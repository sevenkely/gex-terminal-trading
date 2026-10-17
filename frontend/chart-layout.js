/* Presentation-only layout. Essential mode never changes feeds, filters or models. */
"use strict";
(() => {
  const essentialButton = document.createElement("button");
  essentialButton.id = "cockpit-detail";
  essentialButton.className = "hm-btn";
  $("workspace-bar").insertBefore(essentialButton, $("workspace-save"));
  let essential = localStorage.getItem("gex.presentation") !== "detailed";
  function apply() {
    document.body.classList.toggle("essential", essential);
    essentialButton.textContent = essential
      ? "Outils avancés"
      : "Vue essentielle";
    essentialButton.setAttribute("aria-pressed", String(!essential));
    localStorage.setItem(
      "gex.presentation",
      essential ? "essential" : "detailed",
    );
    requestAnimationFrame(() => {
      queueGamma();
      queueDraw();
      queueFlow();
    });
  }
  essentialButton.onclick = () => {
    essential = !essential;
    apply();
  };
  // Secondary instruments remain in the existing header; no duplicated quote feed.
  const summary = document.createElement("section");
  summary.id = "essential-context";
  summary.setAttribute("aria-label", "Contexte essentiel");
  summary.innerHTML =
    '<header>CONTEXTE DE MARCHÉ <span>Modèle estimé</span></header><div class="essential-stat"><span>Régime gamma</span><b id="essential-regime">—</b></div><div class="essential-stat"><span>Net GEX · +1 % spot</span><b id="essential-gex">—</b></div><div class="essential-stat"><span>Mouvement attendu · 1σ</span><b id="essential-move">—</b></div><div id="essential-source"></div><p>GEX estimé, pas du positionnement dealer observé. Les niveaux ne sont pas des probabilités de rebond.</p>';
  $("sidebar").prepend(summary);
  const controls = document.createElement("div");
  controls.id = "price-controls";
  controls.innerHTML =
    '<button id="price-reset" title="Cadrer le prix sans inclure les niveaux éloignés">Cadrer le prix</button><button id="price-fullscreen" title="Agrandir le graphique">Agrandir</button><label>Flux <select id="essential-flow-source"><option value="perp">Perp / futures</option><option value="options">Options BTC · prime</option></select></label>';
  $("intervals").after(controls);
  $("price-reset").onclick = () => {
    state.fit = false;
    $("fit-toggle").classList.remove("active");
    state.candles?.applyOptions({
      autoscaleInfoProvider: (original) => original(),
    });
    state.chart?.priceScale("right").applyOptions({ autoScale: true });
    smartZoom();
    queueGamma();
    queueFlow();
  };
  $("price-fullscreen").onclick = () => $("zen-toggle").click();
  $("essential-flow-source").onchange = (e) => setFlowSrc(e.target.value);
  // Keep inspection visible and small; the full journal opens outside the chart.
  const inspector = $("flow-inspector");
  const expand = document.createElement("button");
  expand.id = "inspector-expand";
  expand.textContent = "Détails";
  expand.setAttribute("aria-expanded", "false");
  inspector.querySelector("header").append(expand);
  expand.onclick = () => {
    const open = inspector.classList.toggle("inspector-expanded");
    expand.textContent = open ? "Réduire" : "Détails";
    expand.setAttribute("aria-expanded", String(open));
  };
  const journal = document.createElement("dialog");
  journal.id = "inspection-dialog";
  journal.innerHTML =
    '<form method="dialog"><button class="dialog-close">Fermer</button></form><h2>Observations et recherche</h2><p>Historique reçu uniquement. Les trous de collecte ne sont pas des zéros.</p>';
  for (const detail of [...inspector.querySelectorAll(":scope > details")])
    journal.append(detail);
  document.body.append(journal);
  const open = document.createElement("button");
  open.id = "inspection-open";
  open.textContent = "Journal / Replay / Dessins";
  inspector.querySelector("header").append(open);
  open.onclick = () => journal.showModal();
  function update() {
    $("essential-regime").textContent = $("hero-regime").textContent || "—";
    $("essential-gex").textContent = $("lv-netgex").textContent || "—";
    $("essential-move").textContent = $("lv-em").textContent || "—";
    const d = state.dataStatus,
      source = $("essential-source");
    source.replaceChildren();
    const lines = [
      ["Prix", $("mode-label").textContent],
      [
        "Chaîne options",
        d?.chain_age_seconds != null
          ? Math.floor(d.chain_age_seconds / 60) +
            " min · " +
            (d.filtered_contracts ?? "—") +
            " séries"
          : "âge inconnu",
      ],
      ["Open interest", d?.oi_reference || "Référence non disponible"],
    ];
    if (d?.projection)
      lines.push([
        "Projection",
        d.projection.fresh
          ? "Basis synchronisé"
          : "BASIS PÉRIMÉ — précision dégradée",
      ]);
    for (const [name, value] of lines) {
      const line = document.createElement("div"),
        label = document.createElement("span"),
        content = document.createElement("b");
      label.textContent = name;
      content.textContent = value;
      line.append(label, content);
      source.append(line);
    }
    const crypto = CRYPTO.has(state.symbol);
    $("essential-flow-source").parentElement.hidden = !crypto;
    $("essential-flow-source").value = flowSrc;
    $("context-rail").classList.toggle(
      "context-in-focus",
      $("workspace-preset").value === "focus",
    );
  }
  apply();
  update();
  setInterval(() => {
    if (!document.hidden) update();
  }, 1000);
})();
