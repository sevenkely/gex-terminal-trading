/* Observed data only. Kept independent of the live chart and trading alerts. */
"use strict";
(() => {
  let snapshots = [], exported = {}, seq = 0;
  const utc = t => new Date(t * 1000).toLocaleString("fr-FR", {timeZone:"UTC"});
  function line(parent, text) {
    const el = document.createElement("div"); el.textContent = text; parent.appendChild(el); return el;
  }
  function renderReplay() {
    const el = $("replay-detail"); el.replaceChildren();
    const r = snapshots[Number($("replay-range").value)];
    if (!r) { line(el, "Aucun snapshot pour cet instrument et ce filtre. L'enregistrement commence au démarrage ; rétention 7 jours."); return; }
    const l = r.levels;
    line(el, `${r.symbol} · ${r.filter.toUpperCase()} · enregistré ${utc(r.recorded_at)} UTC`);
    line(el, `Prix ${fmtPx(r.price, r.symbol)} · ${r.price_mode} · chaîne ${utc(r.chain_ts)} UTC`);
    line(el, `GEX source ${r.gex_source} · ${regimeLabel(l.regime)}`);
    line(el, `CW ${fmtPx(l.call_wall, r.symbol)} · PW ${fmtPx(l.put_wall, r.symbol)}`);
    line(el, `Zero gamma ${fmtPx(l.zero_gex, r.symbol)} · Net ${fmtUSD(l.net_gex_total)}`);
    line(el, "Snapshot connu à cette date. Aucun recalcul avec la chaîne actuelle.");
  }
  async function load() {
    if (!$('sbp-research').classList.contains('active')) return;
    const id = ++seq, sym = state.symbol, filter = state.filter;
    const minimum = Math.min(1e9, Math.max(0, Number($("opt-minimum").value) || 0));
    const query = new URLSearchParams({minimum, kind:$("opt-kind").value, expiry:filter === "0dte" ? "0dte" : "all"});
    try {
      const result = await Promise.all([
        fetch(`/api/option-flow/${sym}?${query}`),
        fetch(`/api/replay/${sym}?filter=${filter}`),
        fetch(`/api/oi-history/${sym}`),
        fetch(`/api/risk/${sym}?filter=${filter}`),
      ]);
      if (result.some(r => !r.ok)) throw new Error("Source recherche indisponible");
      const [tape, replay, oi, risk] = await Promise.all(result.map(r => r.json()));
      if (id !== seq || sym !== state.symbol || filter !== state.filter) return;
      exported = {symbol:sym, filter, exported_at:new Date().toISOString(), tape, replay, oi, risk};
      $("opt-status").textContent = (tape.reason || `${tape.sample_count} transactions dans l'échantillon · ${tape.live ? "connexion active" : "flux non connecté"}`) + (tape.limitation ? " " + tape.limitation : "");
      const tbody = $("opt-rows"); tbody.replaceChildren();
      for (const r of tape.rows || []) {
        const tr = document.createElement("tr");
        const texts = [new Date(r.ts*1000).toISOString().slice(11,23), r.instrument, r.side, r.amount, Math.round(r.premium_usd).toLocaleString("fr-FR"), r.iv_pct == null ? "—" : `${r.iv_pct}%`];
        for (const text of texts) { const td = document.createElement("td"); td.textContent = text; tr.appendChild(td); }
        tr.title = `Source : ${r.source} ; direction : ${r.side_source} ; ouverture/fermeture : inconnue`;
        tbody.appendChild(tr);
      }
      const concentrations = $("opt-concentrations"); concentrations.replaceChildren();
      for (const b of tape.concentrations || []) line(concentrations, `${utc(b.expiry).slice(0,10)} · ${b.strike} ${b.option_type} · ${Math.round(b.premium_usd).toLocaleString("fr-FR")} $ · ${b.prints} prints`);
      const previousId = snapshots[Number($("replay-range").value)]?.id;
      snapshots = replay.rows || [];
      const range = $("replay-range"); range.max = String(Math.max(0, snapshots.length-1));
      const oldIndex = snapshots.findIndex(r => r.id === previousId);
      range.value = String(oldIndex >= 0 ? oldIndex : Math.max(0, snapshots.length-1)); range.disabled = !snapshots.length;
      renderReplay();
      const riskEl = $("risk-sensitivities"); riskEl.replaceChildren();
      if (risk.available) {
        line(riskEl, `Source ${risk.source} · Vanna ${fmtUSD(risk.vanna_usd_per_vol_point)} / +1 pt IV`);
        line(riskEl, `Charm ${fmtUSD(risk.charm_usd_per_calendar_day)} / jour calendaire`);
      } else line(riskEl, risk.reason || "Indisponible");
      $("risk-limitation").textContent = risk.limitation || "";
      const observations = $("oi-observations"); observations.replaceChildren();
      if (!oi.rows?.length) line(observations, "Aucune observation enregistrée.");
      (oi.rows || []).forEach((r, i, rows) => {
        const prev = rows[i-1], delta = prev ? r.call_oi + r.put_oi - prev.call_oi - prev.put_oi : null;
        line(observations, `${r.day} · C ${fmtOI(r.call_oi)} / P ${fmtOI(r.put_oi)} · Δ OI observé ${delta == null ? "—" : fmtOI(delta)}`);
      });
    } catch (e) { if (id === seq) $("opt-status").textContent = e.message; }
  }
  $("replay-range").addEventListener("input", renderReplay);
  $("research-refresh").addEventListener("click", load);
  $("opt-kind").addEventListener("change", load);
  $("opt-minimum").addEventListener("change", load);
  document.querySelector('[data-p="research"]').addEventListener("click", load);
  $("research-export").addEventListener("click", () => {
    if (exported.symbol !== state.symbol || exported.filter !== state.filter) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], {type:"application/json"}));
    const a = document.createElement("a"); a.href=url; a.download=`gex-observed-${state.symbol}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  setInterval(load, 5000);
})();
