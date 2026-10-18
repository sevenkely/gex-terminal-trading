/* Independent OHLCV indicator workspace. No generated history or trade-volume inference. */
"use strict";
(() => {
  const math = window.IndicatorMath,
    KEY = "gex.indicators.v1";
  let options = math.sanitize(storedJSON(KEY, {})),
    anchors = storedJSON("gex.indicator.anchors", {});
  if (!anchors || typeof anchors !== "object" || Array.isArray(anchors))
    anchors = {};
  let rows = [],
    context = "",
    error = "",
    loaded = 0,
    controller,
    sequence = 0,
    queued = false,
    armed = null,
    chart = null,
    currentSymbol = null;
  let profiles = [],
    curves = [];
  window.marketIndicatorsManaged = true;
  const button = document.createElement("button");
  button.id = "indicators-open";
  button.className = "hm-btn";
  button.textContent = "Indicateurs · VP / VWAP";
  $("workspace-bar").insertBefore(
    button,
    document.querySelector(".motion-control"),
  );
  const canvas = document.createElement("canvas");
  canvas.id = "market-indicators-canvas";
  $("chart-area").append(canvas);
  const summary = document.createElement("button");
  summary.id = "indicator-summary";
  summary.title = "Méthode, couverture et réglages des indicateurs";
  $("data-quality").after(summary);
  const dialog = document.createElement("dialog");
  dialog.id = "indicator-dialog";
  const select = (path, label, values) =>
    `<label>${label}<select data-config="${path}" id="ind-${path.replace(".", "-")}">${values.map(([value, name]) => `<option value="${value}">${name}</option>`).join("")}</select></label>`;
  const input = (path, label, type, extra = "") =>
    `<label>${label}<input data-config="${path}" id="ind-${path.replace(".", "-")}" type="${type}" ${extra}></label>`;
  const sessions = (name) =>
    select(name + ".session", "Séance", [
      ["auto", "Auto selon l’actif"],
      ["day", "Journée · fuseau choisi"],
      ["rth", "RTH · 09:30–16:00 New York"],
      ["eth", "ETH · 18:00–17:00 New York"],
    ]) +
    select(name + ".zone", "Fuseau journée", [
      ["UTC", "UTC"],
      ["America/New_York", "New York"],
      ["Europe/London", "Londres"],
      ["Asia/Tokyo", "Tokyo"],
    ]);
  dialog.innerHTML = `<form method="dialog" class="indicator-dialog-head"><div><span class="eyebrow">OUTILS DU GRAPHIQUE</span><h2>Profils & prix moyen</h2></div><button class="dialog-close">Fermer</button></form>
  <p class="indicator-method">Estimations OHLCV : le VP répartit uniformément le volume de chaque bougie entre son plus bas et son plus haut. Le VWAP pondère son prix typique (H + L + C) / 3. Ni profil de transactions exact, ni TPO, ni delta acheteur/vendeur.</p>
  <div class="indicator-base">${select(
    "base",
    "Base de calcul indépendante du graphique",
    [
      ["1m", "1 minute · historique court"],
      ["5m", "5 minutes"],
      ["15m", "15 minutes · historique plus long"],
      ["30m", "30 minutes"],
      ["1h", "1 heure · estimation plus grossière"],
    ],
  )}<button type="button" id="ind-refresh">Actualiser les données</button></div>
  <section><header><span class="indicator-number">01</span><h3>Volume Profile <small>Distribution estimée du volume</small></h3>${input("vp.enabled", "Afficher", "checkbox")}</header><div class="indicator-fields">
  ${select("vp.period", "Période", [
    ["daily", "Daily / session"],
    ["weekly", "Weekly · lundi"],
    ["monthly", "Monthly"],
    ["visible", "Plage visible"],
    ["anchored", "Plage ancrée"],
  ])}${sessions("vp")}
  ${select("vp.history", "Profils affichés", [
    ["current", "Dernière période disponible"],
    ["previous", "Période précédente disponible"],
    ["three", "3 dernières · juxtaposées"],
  ])}
  ${select("vp.resolution", "Construction", [
    ["rows", "Nombre de niveaux"],
    ["step", "Pas de prix"],
  ])}${input("vp.rows", "Nombre de niveaux", "number", 'min="8" max="256" step="1"')}${input("vp.step", "Pas de prix", "number", 'min="0.000001" max="10000000" step="any"')}
  ${input("vp.valueArea", "Value Area (%)", "number", 'min="1" max="100"')}${select(
    "vp.side",
    "Position",
    [
      ["left", "À gauche"],
      ["right", "À droite"],
    ],
  )}${input("vp.width", "Largeur (% du graphique)", "number", 'min="5" max="35"')}${input("vp.opacity", "Opacité", "range", 'min="0.05" max="0.8" step="0.01"')}${input("vp.color", "Couleur Value Area", "color")}${input("vp.outside", "Couleur hors Value Area", "color")}${input("vp.poc", "Ligne POC", "checkbox")}${input("vp.va", "Lignes VAH / VAL", "checkbox")}
  </div><div class="anchor-row"><button type="button" data-anchor="vp">Ancrer le VP sur le graphique</button><button type="button" data-clear-anchor="vp">Effacer l’ancrage</button><span id="ind-vp-anchor"></span></div></section>
  <section><header><span class="indicator-number">02</span><h3>VWAP <small>Prix typique pondéré par le volume</small></h3>${input("vwap.enabled", "Afficher", "checkbox")}</header><div class="indicator-fields">
  ${select("vwap.period", "Réinitialisation", [
    ["daily", "Daily / session"],
    ["weekly", "Weekly · lundi"],
    ["monthly", "Monthly"],
    ["anchored", "Depuis un ancrage"],
  ])}${sessions("vwap")}
  ${input("vwap.previous", "Période précédente également", "checkbox")}${select(
    "vwap.bands",
    "Bandes",
    [
      ["none", "Aucune"],
      ["sigma", "Écart-type pondéré (σ)"],
      ["percent", "Pourcentage du VWAP"],
    ],
  )}${input("vwap.bandCount", "Nombre de bandes (±)", "number", 'min="1" max="3"')}${input("vwap.percent", "Pas des bandes (%)", "number", 'min="0.01" max="20" step="0.01"')}${input("vwap.color", "Couleur VWAP", "color")}${input("vwap.width", "Épaisseur", "number", 'min="1" max="5"')}${select(
    "vwap.style",
    "Style",
    [
      ["solid", "Continu"],
      ["dashed", "Tirets"],
      ["dotted", "Pointillé"],
    ],
  )}${input("vwap.labels", "Labels", "checkbox")}
  </div><div class="anchor-row"><button type="button" data-anchor="vwap">Ancrer le VWAP sur le graphique</button><button type="button" data-clear-anchor="vwap">Effacer l’ancrage</button><span id="ind-vwap-anchor"></span></div></section>
  <section class="indicator-coverage"><h3>Source & couverture</h3><p id="indicator-provenance"></p><p id="indicator-coverage"></p><p>Historique reçu uniquement : début de période, séances et trous non certifiés. Une période précédente est la précédente présente dans les données, pas nécessairement la précédente du calendrier. Les horaires RTH/ETH sont des filtres horaires, pas un calendrier de jours fériés. Les bandes sont une dispersion des prix typiques OHLCV, pas des probabilités.</p></section>`;
  document.body.append(dialog);
  button.onclick = summary.onclick = () => {
    sync();
    dialog.showModal();
  };
  const periodName = {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    visible: "Visible",
    anchored: "Ancré",
  };
  function sync() {
    for (const element of dialog.querySelectorAll("[data-config]")) {
      const parts = element.dataset.config.split(".");
      const value =
        parts.length === 1 ? options[parts[0]] : options[parts[0]][parts[1]];
      if (element.type === "checkbox") element.checked = value;
      else element.value = value;
    }
    for (const name of ["vp", "vwap"])
      $("ind-" + name + "-anchor").textContent = options[name].anchor
        ? new Date(options[name].anchor * 1000).toLocaleString("fr-FR", {
            timeZone: "UTC",
          }) +
          " UTC · " +
          state.symbol
        : "Aucun ancrage pour " + state.symbol;
    $("ind-vp-rows").disabled = options.vp.resolution !== "rows";
    $("ind-vp-step").disabled = options.vp.resolution !== "step";
    $("ind-vwap-percent").disabled = options.vwap.bands !== "percent";
    for (const name of ["vp", "vwap"])
      $("ind-" + name + "-zone").disabled =
        options[name].session !== "day" &&
        !(options[name].session === "auto" && state.symbol === "BTC");
  }
  function save() {
    localStorage.setItem(KEY, JSON.stringify(options));
    for (const [name, toggle] of [
      ["vp", "prof"],
      ["vwap", "vwap"],
    ]) {
      state.ltgl[toggle] = options[name].enabled;
      document
        .querySelector(`#lvl-toggles [data-t="${toggle}"]`)
        ?.classList.toggle("active", options[name].enabled);
    }
    localStorage.setItem("gex.ltgl", JSON.stringify(state.ltgl));
  }
  dialog.addEventListener("change", (event) => {
    const el = event.target;
    if (!el.dataset.config) return;
    const parts = el.dataset.config.split("."),
      oldBase = options.base;
    const value =
      el.type === "checkbox"
        ? el.checked
        : ["number", "range"].includes(el.type)
          ? el.valueAsNumber
          : el.value;
    if (parts.length === 1) options[parts[0]] = value;
    else options[parts[0]][parts[1]] = value;
    options = math.sanitize(options);
    save();
    sync();
    if (oldBase !== options.base) load();
    else calculate();
  });
  for (const el of dialog.querySelectorAll("[data-anchor]"))
    el.onclick = () => {
      armed = el.dataset.anchor;
      setDrawTool("none");
      dialog.close();
      summary.textContent =
        "Choisir le départ du " +
        (armed === "vp" ? "VP" : "VWAP") +
        " sur le graphique · Échap pour annuler";
      summary.classList.add("anchor-armed");
    };
  for (const el of dialog.querySelectorAll("[data-clear-anchor]"))
    el.onclick = () => {
      const name = el.dataset.clearAnchor;
      options[name].anchor = null;
      storeAnchor(name, null);
      save();
      sync();
      calculate();
    };
  function storeAnchor(name, time) {
    anchors[state.symbol] = { ...(anchors[state.symbol] || {}), [name]: time };
    localStorage.setItem("gex.indicator.anchors", JSON.stringify(anchors));
  }
  function cancel() {
    armed = null;
    summary.classList.remove("anchor-armed");
    calculate();
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && armed) cancel();
  });
  $("ind-refresh").onclick = () => load();
  function asTime(time) {
    return typeof time === "number"
      ? time
      : typeof time === "string"
        ? Date.parse(time + "T00:00:00Z") / 1000
        : Date.UTC(time.year, time.month - 1, time.day) / 1000;
  }
  function visibleRange() {
    const range = state.chart?.timeScale().getVisibleRange();
    if (!range) return null;
    return {
      from: asTime(range.from),
      to:
        asTime(range.to) +
        (state.barsDaily ? 86400 : PERIOD[state.interval] || 300) -
        1,
    };
  }
  function calculate() {
    const range = visibleRange(),
      vp = math.groups(rows, options.vp, state.symbol, range),
      vw = math.groups(rows, options.vwap, state.symbol, range);
    const selected =
      options.vp.history === "previous"
        ? vp.slice(-2, -1)
        : options.vp.history === "three"
          ? vp.slice(-3)
          : vp.slice(-1);
    profiles = selected
      .map((group) => ({
        ...math.profile(group.bars, options.vp),
        period: group.period,
      }))
      .filter((profile) => profile.vol || profile.error);
    curves = vw
      .slice(options.vwap.previous ? -2 : -1)
      .map((group) => ({ period: group.period, points: math.vwap(group.bars) }))
      .filter((group) => group.points.length);
    const errors = profiles.filter((p) => p.error).map((p) => p.error);
    if (!armed) {
      summary.classList.remove("anchor-armed");
      summary.textContent = [
        options.vp.enabled
          ? "VP " +
            periodName[options.vp.period] +
            (profiles.some((p) => p.vol) ? "" : " · indisponible")
          : "VP masqué",
        options.vwap.enabled
          ? "VWAP " +
            periodName[options.vwap.period] +
            (curves.length ? "" : " · indisponible")
          : "VWAP masqué",
        "Base " + options.base + " · OHLCV estimé",
        error || errors[0] || "Couverture partielle possible",
      ].join("  ·  ");
    }
    const source =
      state.symbol === "BTC"
        ? "Bougies du perpétuel BTC Deribit (pas les options)"
        : FUTURES.has(state.symbol)
          ? "Bougies Yahoo du future continu (pas le tape natif du contrat Rithmic)"
          : "Bougies Yahoo de " +
            state.symbol +
            " (volume du fournisseur, pas le flow options)";
    $("indicator-provenance").textContent =
      source +
      ". Base " +
      options.base +
      " indépendante de l’intervalle affiché. Unité de volume telle que fournie, non normalisée. " +
      (loaded
        ? "Lecture à " + new Date(loaded).toLocaleTimeString("fr-FR") + "."
        : "");
    $("indicator-coverage").textContent =
      error ||
      (!rows.length
        ? "Aucune bougie OHLCV exploitable."
        : rows.length +
          " bougies chargées, du " +
          new Date(rows[0].time * 1000).toISOString() +
          " au " +
          new Date(rows.at(-1).time * 1000).toISOString() +
          ". " +
          profiles
            .filter((p) => p.vol)
            .map(
              (p) =>
                p.period +
                " : " +
                p.count +
                " bougies, volume " +
                p.total.toLocaleString("fr-FR", { maximumFractionDigits: 2 }),
            )
            .join(" ; ") +
          ". Les périodes Weekly/Monthly peuvent être tronquées. Pas de volume positif = indicateur indisponible.");
    queue();
  }
  async function load() {
    controller?.abort();
    controller = new AbortController();
    const seq = ++sequence,
      symbol = state.symbol,
      base = options.base;
    if (context !== symbol + "|" + base) {
      rows = [];
      profiles = [];
      curves = [];
      loaded = 0;
    }
    context = symbol + "|" + base;
    error = rows.length
      ? "Actualisation des données…"
      : "Chargement des données…";
    calculate();
    try {
      const response = await fetch(`/api/history/${symbol}?interval=${base}`, {
        signal: controller.signal,
      });
      if (!response.ok)
        throw Error("Historique indisponible (" + response.status + ")");
      const payload = await response.json();
      if (seq !== sequence || symbol !== state.symbol || base !== options.base)
        return;
      if (payload.error || !Array.isArray(payload.bars))
        throw Error("Historique indisponible");
      rows = math.normalize(payload.bars);
      error = "";
      loaded = Date.now();
      calculate();
    } catch (failure) {
      if (failure.name === "AbortError" || seq !== sequence) return;
      error = "Source indisponible — aucun indicateur reconstruit";
      rows = [];
      calculate();
    }
  }
  function bind() {
    if (state.chart !== chart) {
      chart = state.chart;
      chart?.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (options.vp.period === "visible") calculate();
        else queue();
      });
      chart?.subscribeClick((param) => {
        if (!armed || !param.time || !param.point) return;
        const time = asTime(param.time);
        if (!Number.isFinite(time)) return;
        const name = armed;
        options[name].period = "anchored";
        options[name].anchor = time;
        storeAnchor(name, time);
        save();
        armed = null;
        sync();
        calculate();
      });
    }
    if (currentSymbol !== state.symbol) {
      currentSymbol = state.symbol;
      armed = null;
      for (const name of ["vp", "vwap"])
        options[name].anchor = Number.isFinite(anchors[currentSymbol]?.[name])
          ? anchors[currentSymbol][name]
          : null;
      sync();
      load();
    } else queue();
  }
  function queue() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }
  function draw() {
    const host = $("chart-area"),
      W = host.clientWidth,
      H = host.clientHeight,
      dpr = devicePixelRatio || 1;
    if (
      canvas.width !== Math.round(W * dpr) ||
      canvas.height !== Math.round(H * dpr)
    ) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (
      !state.chart ||
      !state.candles ||
      context !== state.symbol + "|" + options.base
    )
      return;
    const right = W - state.chart.priceScale("right").width(),
      bottom = H * 0.755;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, right, bottom);
    ctx.clip();
    ctx.font = '11px "IBM Plex Mono", monospace';
    const horizontal = (price, color, label, dash = []) => {
      const y = state.candles.priceToCoordinate(price);
      if (y == null || y < 14 || y > bottom) return;
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.fillText(label, options.vp.side === "left" ? right - 150 : 10, y - 5);
      ctx.globalAlpha = 1;
    };
    if (options.vp.enabled) {
      const list = profiles.filter((p) => p.vol),
        totalWidth = (right * options.vp.width) / 100,
        slot = totalWidth / Math.max(1, list.length);
      list.forEach((p, index) => {
        const left =
          options.vp.side === "left"
            ? index * slot
            : right - totalWidth + index * slot;
        for (let i = 0; i < p.vol.length; i++) {
          if (!p.vol[i]) continue;
          const y0 = state.candles.priceToCoordinate(p.lo + i * p.step),
            y1 = state.candles.priceToCoordinate(p.lo + (i + 1) * p.step);
          if (y0 == null || y1 == null) continue;
          const length = (p.vol[i] / p.max) * (slot - 3);
          ctx.globalAlpha = options.vp.opacity;
          ctx.fillStyle =
            i >= p.areaLow && i <= p.areaHigh
              ? options.vp.color
              : options.vp.outside;
          ctx.fillRect(
            options.vp.side === "left" ? left : left + slot - length,
            Math.min(y0, y1),
            length,
            Math.max(1, Math.abs(y1 - y0) - 0.5),
          );
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = options.vp.color;
        ctx.fillText(
          p.period === "anchored"
            ? "Ancré"
            : p.period === "visible"
              ? "Visible"
              : p.period,
          options.vp.side === "left" ? Math.max(48, left + 4) : left + 4,
          Math.min(bottom - 4, 70 + index * 14),
        );
        if (index === list.length - 1) {
          if (options.vp.poc)
            horizontal(p.poc, options.vp.color, "POC · VP estimé");
          if (options.vp.va) {
            horizontal(p.vah, options.vp.outside, "VAH", [4, 4]);
            horizontal(p.val, options.vp.outside, "VAL", [4, 4]);
          }
        }
      });
    }
    if (options.vwap.enabled) {
      const chartBars = [...state.bars.values()],
        times = chartBars.map((b) => asTime(b.time));
      const range = visibleRange();
      function xFor(time) {
        let a = 0,
          b = times.length - 1;
        while (a <= b) {
          const m = (a + b) >> 1;
          if (times[m] < time) a = m + 1;
          else b = m - 1;
        }
        if (a >= times.length) {
          const last = chartBars.at(-1);
          const duration = state.barsDaily
            ? 86400
            : PERIOD[state.interval] || 300;
          return last && time < times.at(-1) + duration
            ? state.chart.timeScale().timeToCoordinate(last.time)
            : null;
        }
        const exact = state.chart
          .timeScale()
          .timeToCoordinate(chartBars[a].time);
        if (times[a] === time || a === 0) return exact;
        const prior = state.chart
          .timeScale()
          .timeToCoordinate(chartBars[a - 1].time);
        return prior == null || exact == null
          ? null
          : prior +
              ((exact - prior) * (time - times[a - 1])) /
                (times[a] - times[a - 1]);
      }
      curves.forEach((curve, index) => {
        const sampled = new Map();
        for (const p of curve.points) {
          if (range && (p.time < range.from - 86400 || p.time > range.to))
            continue;
          const x = xFor(p.time);
          if (x != null && x >= -20 && x <= right + 20)
            sampled.set(Math.round(x), { ...p, x });
        }
        const points = [...sampled.values()];
        if (!points.length) return;
        const line = (multiple) => {
          ctx.globalAlpha = multiple
            ? 0.32
            : index < curves.length - 1
              ? 0.45
              : 0.95;
          ctx.strokeStyle = options.vwap.color;
          ctx.lineWidth = multiple ? 1 : options.vwap.width;
          ctx.setLineDash(
            multiple
              ? [3, 4]
              : options.vwap.style === "dashed"
                ? [7, 4]
                : options.vwap.style === "dotted"
                  ? [2, 4]
                  : [],
          );
          ctx.beginPath();
          let started = false;
          for (const p of points) {
            const band =
              options.vwap.bands === "percent"
                ? (p.value * options.vwap.percent) / 100
                : p.sd;
            const y = state.candles.priceToCoordinate(
              p.value + multiple * band,
            );
            if (y == null) {
              started = false;
              continue;
            }
            if (started) ctx.lineTo(p.x, y);
            else {
              ctx.moveTo(p.x, y);
              started = true;
            }
          }
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        };
        if (options.vwap.bands !== "none")
          for (let n = 1; n <= options.vwap.bandCount; n++) {
            line(n);
            line(-n);
          }
        line(0);
        if (options.vwap.labels) {
          const last = points.at(-1),
            y = state.candles.priceToCoordinate(last.value);
          if (y != null) {
            ctx.fillStyle = options.vwap.color;
            ctx.fillText(
              "VWAP " + periodName[options.vwap.period] + " · estimé",
              Math.min(right - 200, Math.max(8, last.x - 190)),
              y - 6,
            );
          }
        }
      });
    }
    ctx.restore();
  }
  document.addEventListener("click", (event) => {
    if (event.target.closest("#preset-seg [data-p]")) {
      options.vp.enabled = !!state.ltgl.prof;
      options.vwap.enabled = !!state.ltgl.vwap;
      save();
      sync();
      calculate();
      return;
    }
    const toggle = event.target.closest("#lvl-toggles [data-t]");
    if (!toggle) return;
    const name =
      toggle.dataset.t === "prof"
        ? "vp"
        : toggle.dataset.t === "vwap"
          ? "vwap"
          : null;
    if (name) {
      options[name].enabled = !!state.ltgl[toggle.dataset.t];
      save();
      sync();
      queue();
    }
  });
  new ResizeObserver(queue).observe($("chart-area"));
  window.addEventListener("gex-chart-ready", bind);
  window.marketIndicators = {
    queue,
    getState: () => ({
      options,
      profiles,
      curves,
      context,
      error,
      rows: rows.length,
    }),
    refresh: load,
    latestVWAP: (freshOnly = false) => {
      if (
        !options.vwap.enabled ||
        error ||
        !curves.length ||
        context !== state.symbol + "|" + options.base
      )
        return null;
      const point = curves.at(-1).points.at(-1);
      const maxAge = Math.max(600, 2 * (PERIOD[options.base] || 300));
      if (
        !point ||
        (freshOnly &&
          (Date.now() / 1000 - point.time > maxAge ||
            point.time > Date.now() / 1000 + 60))
      )
        return null;
      return point.value;
    },
  };
  sync();
  save();
  bind();
  setInterval(() => {
    if (!document.hidden && (options.vp.enabled || options.vwap.enabled))
      load();
  }, 60000);
})();
