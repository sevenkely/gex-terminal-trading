/* Independent closed-bar replay. No current model levels, no simulated orders.
 * Full candle aggregates become available only at nominal candle close.
 */
"use strict";
(() => {
  let rows = [],
    snapshots = [],
    ctxKey = "",
    seq = 0,
    index = 0,
    timer = null;
  const key = () =>
    flowContext() + "|" + (state.flowContract || "") + "|" + state.filter;
  const status = $("closed-replay-status"),
    tools = $("closed-replay-tools");
  tools.innerHTML =
    '<button id="closed-replay-load">Charger</button><button id="closed-replay-prev">Précédent</button><button id="closed-replay-play">Lecture</button><button id="closed-replay-next">Suivant</button><input id="closed-replay-range" type="range" min="0" max="0" value="0" aria-label="Position de relecture">';
  function pause() {
    clearTimeout(timer);
    timer = null;
    $("closed-replay-play").textContent = "Lecture";
  }
  function known(b) {
    const end = b.t + (PERIOD[state.interval] || 300);
    return snapshots
      .filter(
        (s) =>
          s.recorded_at <= end &&
          end - s.recorded_at <= 90 &&
          s.chain_ts <= end &&
          ["RITHMIC", "DERIBIT"].includes(s.price_mode) &&
          (!FUTURES.has(state.symbol) ||
            (s.contract && s.contract === state.flowContract)) &&
          (!s.projection || s.projection.fresh),
      )
      .at(-1);
  }
  function render() {
    const cv = $("closed-replay-canvas"),
      W = cv.clientWidth,
      H = 200,
      dpr = devicePixelRatio || 1;
    cv.width = Math.max(1, W * dpr);
    cv.height = H * dpr;
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    if (!rows.length || ctxKey !== key()) return;
    const visible = rows.slice(0, index + 1),
      last = visible.at(-1),
      snapshot = known(last),
      vals = visible.map((b) => b.c);
    // Only the three explicit prices belong on the price scale (never GEX/OI).
    for (const b of visible) {
      const s = known(b);
      for (const k of ["call_wall", "put_wall", "zero_gex"])
        if (Number.isFinite(s?.levels?.[k])) vals.push(s.levels[k]);
    }
    const min = Math.min(...vals),
      max = Math.max(...vals),
      span = max - min || 1;
    const x = (i) => 24 + (i / Math.max(1, visible.length - 1)) * (W - 48),
      y = (p) => H - 24 - ((p - min) / span) * (H - 48);
    for (const [field, color] of [
      ["price", "#e5ebf3"],
      ["call_wall", "#2dd4a7"],
      ["put_wall", "#f0616d"],
      ["zero_gex", "#f5c542"],
    ]) {
      c.strokeStyle = color;
      c.lineWidth = field === "price" ? 2 : 1;
      c.beginPath();
      let started = false,
        previous = null;
      visible.forEach((b, i) => {
        const p = field === "price" ? b.c : known(b)?.levels?.[field];
        if (!Number.isFinite(p)) {
          started = false;
          return;
        }
        if (
          previous != null &&
          b.t - previous > (PERIOD[state.interval] || 300) * 1.5
        )
          started = false;
        started ? c.lineTo(x(i), y(p)) : c.moveTo(x(i), y(p));
        started = true;
        previous = b.t;
      });
      c.stroke();
    }
    const unit = state.flowBarsUnit === "USD" ? "USD" : "contrats";
    status.textContent = `${index + 1}/${rows.length} · bougie close à ${new Date((last.t + (PERIOD[state.interval] || 300)) * 1000).toISOString()} · prix tape ${last.c} · gros ${last.big_total || 0} ${unit} ×${last.big_n || 0} · absorption estimée ${(last.abs_buy || 0) + (last.abs_sell || 0)} ${unit} ×${last.abs_n || 0}. ${snapshot ? "Niveaux connus : Call Wall " + snapshot.levels?.call_wall + " · Put Wall " + snapshot.levels?.put_wall + " · Zero Gamma " + snapshot.levels?.zero_gex + " (snapshot ≤90 s)." : "Niveaux inconnus : aucun snapshot contemporain admissible."} Blanc : prix, vert : Call Wall, rouge : Put Wall, jaune : Zero Gamma. Agrégats de bougies, pas replay tick par tick ; lacunes possibles.`;
    $("closed-replay-range").value = index;
  }
  $("closed-replay-load").onclick = async () => {
    pause();
    const request = ++seq,
      context = key();
    ctxKey = context;
    rows = [];
    snapshots = [];
    render();
    if (
      state.interval === "1d" ||
      (!FUTURES.has(state.symbol) && !CRYPTO.has(state.symbol)) ||
      flowSrc === "options"
    ) {
      status.textContent =
        "Relecture combinée : intraday sur futures directs ou BTC perp uniquement. Les proxies cash et la prime options ne sont pas des prix directement comparables.";
      return;
    }
    status.textContent = "Chargement des observations…";
    const observed = flowMarkerRows().filter(
      (b) => b.t + (PERIOD[state.interval] || 300) <= Date.now() / 1000,
    );
    try {
      const response = await fetch(
        `/api/replay/${state.symbol}?filter=${state.filter}&limit=1000`,
      );
      if (!response.ok) throw Error("Snapshots indisponibles");
      const j = await response.json();
      if (request !== seq || context !== key()) return;
      rows = observed;
      snapshots = (j.rows || []).sort((a, b) => a.recorded_at - b.recorded_at);
      index = 0;
      $("closed-replay-range").max = Math.max(0, rows.length - 1);
      if (!rows.length)
        status.textContent =
          "Aucune bougie close observée pour ce contrat et cet intervalle.";
      render();
    } catch (e) {
      if (request === seq) status.textContent = e.message;
    }
  };
  function step(delta) {
    pause();
    index = Math.max(0, Math.min(rows.length - 1, index + delta));
    render();
  }
  $("closed-replay-prev").onclick = () => step(-1);
  $("closed-replay-next").onclick = () => step(1);
  $("closed-replay-range").oninput = (e) => {
    pause();
    index = Number(e.target.value);
    render();
  };
  function tick() {
    if (ctxKey !== key() || index >= rows.length - 1) {
      pause();
      return;
    }
    index++;
    render();
    timer = setTimeout(tick, 1000);
  }
  $("closed-replay-play").onclick = () => {
    if (timer) {
      pause();
      return;
    }
    if (!rows.length) return;
    if (index >= rows.length - 1) index = 0;
    $("closed-replay-play").textContent = "Pause";
    timer = setTimeout(tick, 1000);
  };
  new ResizeObserver(render).observe($("closed-flow-replay"));
  setInterval(() => {
    if (ctxKey && ctxKey !== key()) {
      pause();
      seq++;
      rows = [];
      snapshots = [];
      ctxKey = "";
      status.textContent = "Contexte changé : recharger les observations.";
      render();
    }
  }, 500);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
})();
