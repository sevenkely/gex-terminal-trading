/* Read-only cockpit composition. No calculation of market signals here.
 * Flow summaries remain server-owned; selection never fabricates a missing bar.
 */
"use strict";
(() => {
  window.cockpitManagedLevels = true;
  document.body.classList.add("cockpit");
  const make = (tag, text, parent) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (parent) parent.append(n);
    return n;
  };
  const preferences = storedJSON("gex.cockpit.layout", {});
  let chart = null,
    selected = null,
    pinned = false,
    lastShapes = "",
    context = "",
    levelKey = "";
  const time = (t) =>
    new Date(t * 1000).toLocaleString("fr-FR", { timeZone: "UTC" });
  const amount = (v) =>
    state.flowBarsUnit === "USD" ? fmtUsd(v) : fmtQty(v) + " contrats";
  const isOptions = () => CRYPTO.has(state.symbol) && flowSrc === "options";
  const rail = make("section", null);
  rail.id = "context-rail";
  rail.setAttribute("aria-label", "Niveaux calculés");
  rail.innerHTML = `<header id="context-grip"><strong>NIVEAUX DU MARCHÉ</strong><span class="context-estimated">Calculés</span></header>
    <div class="context-actions"><label>Position <select id="levels-position"><option value="right">À droite</option><option value="left">À gauche</option><option value="float">Flottant</option></select></label><label><input id="levels-secondary" type="checkbox"> Secondaires</label></div>
    <div id="context-levels"></div><p id="context-level-note"></p><div id="offscreen-levels"></div>`;
  function position() {
    rail.classList.toggle("floating", $("levels-position").value === "float");
    if ($("levels-position").value === "right") {
      const target = ["analysis"].includes($("workspace-preset").value)
        ? $("exposure-dock")
        : $("sidebar");
      target.prepend(rail);
    } else document.querySelector("main").prepend(rail);
    if (rail.classList.contains("floating")) {
      rail.style.left =
        Math.max(8, Math.min(innerWidth - 280, Number(preferences.x) || 50)) +
        "px";
      rail.style.top =
        Math.max(8, Math.min(innerHeight - 120, Number(preferences.y) || 160)) +
        "px";
    } else {
      rail.style.left = "";
      rail.style.top = "";
    }
    preferences.position = $("levels-position").value;
    localStorage.setItem("gex.cockpit.layout", JSON.stringify(preferences));
    levelKey = "";
    queueGamma();
  }
  // The controls must be connected before using the shared DOM lookup helper.
  $("sidebar").prepend(rail);
  $("levels-position").value = ["right", "left", "float"].includes(
    preferences.position,
  )
    ? preferences.position
    : "right";
  $("levels-position").addEventListener("change", position);
  $("levels-secondary").addEventListener("change", () => {
    levelKey = "";
    levels();
  });
  $("workspace-preset").addEventListener("change", () => {
    position();
    levels();
  });
  let drag = null;
  $("context-grip").addEventListener("pointerdown", (e) => {
    if (!rail.classList.contains("floating")) return;
    const r = rail.getBoundingClientRect();
    drag = { x: e.clientX - r.left, y: e.clientY - r.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  });
  $("context-grip").addEventListener("pointermove", (e) => {
    if (!drag) return;
    preferences.x = Math.max(
      8,
      Math.min(innerWidth - rail.offsetWidth - 8, e.clientX - drag.x),
    );
    preferences.y = Math.max(
      8,
      Math.min(innerHeight - 100, e.clientY - drag.y),
    );
    rail.style.left = preferences.x + "px";
    rail.style.top = preferences.y + "px";
  });
  for (const event of ["pointerup", "pointercancel"])
    $("context-grip").addEventListener(event, () => {
      drag = null;
      localStorage.setItem("gex.cockpit.layout", JSON.stringify(preferences));
    });
  function levels() {
    const L = state.levels || {},
      spot = state.lastBar?.close || L.spot;
    const key = JSON.stringify([
      L.walls,
      L.call_wall,
      L.put_wall,
      L.gamma_flip,
      L.zero_gex,
      spot,
      $("levels-secondary").checked,
      state.ltgl,
      state.candles?.priceToCoordinate(L.call_wall || 0),
      state.candles?.priceToCoordinate(L.put_wall || 0),
      state.dataStatus?.projection?.fresh,
    ]);
    if (key === levelKey) return;
    levelKey = key;
    const rows = [],
      W = L.walls || { call: [], put: [] },
      n = $("levels-secondary").checked ? 3 : 1;
    for (const [kind, label, color, fallback] of [
      ["call", "Call Wall", "#2dd4a7", L.call_wall],
      ["put", "Put Wall", "#f0616d", L.put_wall],
    ]) {
      const list = W[kind]?.length
        ? W[kind]
        : Number.isFinite(fallback)
          ? [{ strike: fallback }]
          : [];
      list.slice(0, n).forEach((r, i) =>
        rows.push({
          name: label + " " + (i + 1),
          price: r.strike,
          color,
          group: kind === "call" ? "cw" : "pw",
        }),
      );
    }
    const zero = L.gamma_flip ?? L.zero_gex;
    if (Number.isFinite(zero))
      rows.push({
        name: "Zero Gamma",
        price: zero,
        color: "#f5c542",
        group: "flip",
      });
    $("context-levels").replaceChildren();
    for (const r of rows) {
      const row = make("div", null, $("context-levels"));
      row.className = "context-level";
      const toggle = make("input", null, row);
      toggle.type = "checkbox";
      toggle.checked = !!state.ltgl[r.group];
      toggle.setAttribute("aria-label", "Afficher la famille " + r.name);
      toggle.title = "Afficher / masquer toute cette famille de niveaux";
      toggle.addEventListener("change", () => {
        state.ltgl[r.group] = toggle.checked;
        document
          .querySelectorAll(`#lvl-toggles [data-t="${r.group}"]`)
          .forEach((b) => b.classList.toggle("active", toggle.checked));
        localStorage.setItem("gex.ltgl", JSON.stringify(state.ltgl));
        drawLevels(state.levels, state.profile);
        queueGamma();
        levelKey = "";
      });
      const name = make("span", r.name, row);
      name.style.color = r.color;
      make("b", fmtPrice(r.price), row);
      make(
        "small",
        Number.isFinite(spot) && spot > 0
          ? ((r.price / spot - 1) * 100).toFixed(2) + " %"
          : "—",
        row,
      );
    }
    if (!rows.length)
      make(
        "p",
        "Niveaux indisponibles pour cette source / ce filtre.",
        $("context-levels"),
      );
    $("context-level-note").textContent =
      "Niveaux globaux du filtre · cases par famille · distance au prix affiché. " +
      (FUTURES.has(state.symbol)
        ? state.dataStatus?.projection?.fresh === false
          ? "Projection cash : BASIS PÉRIMÉ."
          : "Projection cash : vérifier le basis."
        : "");
    const h = $("chart-area").clientHeight,
      above = rows.filter(
        (r) => state.candles?.priceToCoordinate(r.price) < 0,
      ).length,
      below = rows.filter(
        (r) => state.candles?.priceToCoordinate(r.price) > h,
      ).length;
    $("offscreen-levels").textContent = [
      above ? "↑ " + above + " niveaux au-dessus" : "",
      below ? "↓ " + below + " niveaux au-dessous" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const inspector = make("section", null);
  inspector.id = "flow-inspector";
  inspector.innerHTML = `<header><div><strong>INSPECTEUR DE BOUGIE</strong><span id="inspect-time">Survolez une bougie</span></div><button id="inspect-unpin">Suivre le curseur</button></header>
    <p id="flow-coverage" role="status"></p><div id="flow-metrics"></div>
    <details><summary>Diagnostic de couverture</summary><pre id="flow-diagnostics"></pre></details>
    <details id="flow-journal"><summary>Journal des résumés observés <span id="journal-count"></span></summary>
      <div class="journal-controls"><label>Type <select id="journal-kind"><option value="all">Tous</option><option value="big">Gros trades</option><option value="abs">Absorption / activité estimée</option></select></label><label>Relecture des agrégats <input id="journal-replay" type="range" min="0" max="0" value="0" disabled></label><button id="journal-export">Exporter CSV</button></div>
      <p>UTC · agrégats de la source sélectionnée, pas une liste exhaustive de prints. Cliquer une ligne épingle la bougie. La relecture inspecte l’historique reçu, sans simuler des ordres.</p>
      <div class="journal-scroll"><table><thead><tr><th>Bougie UTC</th><th>Gros trades</th><th>Prints</th><th>Activité estimée</th><th>Épisodes</th><th>Graphique</th></tr></thead><tbody id="journal-rows"></tbody></table></div>
    </details>
    <details id="closed-flow-replay"><summary>Relecture prix / flux / niveaux connus</summary><div id="closed-replay-tools"></div><p id="closed-replay-status">Charger les observations pour une relecture indépendante du graphique live.</p><canvas id="closed-replay-canvas"></canvas></details>
    <details id="drawing-manager"><summary>Objets du graphique</summary><div id="drawing-objects"></div></details>`;
  $("statusbar").before(inspector);
  function inspect(t) {
    selected = t;
    const rows = flowMarkerRows(),
      b = rows.find((r) => String(flowBarKey(r.t)) === String(t));
    $("inspect-time").textContent =
      t == null
        ? "Survolez une bougie"
        : (typeof t === "number" ? time(t) + " UTC" : String(t)) +
          (pinned ? " · épinglée" : "");
    const box = $("flow-metrics");
    box.replaceChildren();
    if (!b) {
      make("p", "Flux non collecté sur cette bougie : inconnu, pas zéro.", box);
      return;
    }
    for (const [label, value, note] of [
      [
        "Gros trades",
        amount(b.big_total || 0),
        `${b.big_n || 0} prints · achats ${amount(b.big_buy || 0)} / ventes ${amount(b.big_sell || 0)} / inconnu ${amount(b.big_unknown || 0)}`,
      ],
      [
        isOptions()
          ? "Prime / index stable (heuristique)"
          : "Absorption estimée",
        amount((b.abs_buy || 0) + (b.abs_sell || 0)),
        `${b.abs_n || 0} épisodes · achats agressifs ${amount(b.abs_buy || 0)} / ventes agressives ${amount(b.abs_sell || 0)}`,
      ],
      [
        "Delta agressif",
        amount(b.delta || 0),
        `Volume reçu ${amount(b.vol || 0)} · ${b.n || 0} transactions reçues`,
      ],
    ]) {
      const card = make("div", null, box);
      make("span", label, card);
      make("strong", value, card);
      make("small", note, card);
    }
    make(
      "p",
      "Montants big trades et activité estimée séparés. Fenêtres d’activité attribuées à la bougie de détection ; aucune preuve de liquidité passive.",
      box,
    ).className = "metric-note";
  }
  $("inspect-unpin").addEventListener("click", () => {
    pinned = false;
    inspect(null);
  });
  function coverage() {
    const rows = flowMarkerRows(),
      d =
        state.flowBarsContext === flowContext()
          ? state.flowDiagnostics || {}
          : {},
      matched = rows.filter(
        (b) =>
          state.bars.has(String(flowBarKey(b.t))) ||
          state.bars.has(flowBarKey(b.t)),
      );
    const markers = rows.filter((b) => b.big_n || b.abs_n),
      visible = new Set(state.flowHits.map((h) => h.cell.t));
    $("flow-coverage").textContent =
      `${rows.length} bougies reçues · ${rows.filter((b) => b.big_n).length} avec gros trades · ${rows.filter((b) => b.abs_n).length} avec activité estimée · historique partiel` +
      (state.flowCoverageStart
        ? " depuis " + time(state.flowCoverageStart) + " UTC"
        : " · collecte en attente") +
      (state.flowError ? " · erreur de chargement" : "");
    $("flow-diagnostics").textContent = [
      `Source : ${state.symbol} / ${flowSrc} · unité : ${state.flowBarsUnit}`,
      `Bougies associées au graphique : ${matched.length} / ${rows.length}`,
      `Bougies événementielles visibles : ${visible.size} / ${markers.length}`,
      `Sans bougie OHLC correspondante : ${rows.length - matched.length}`,
      `Les autres événements sont hors du cadrage ; zoomer pour lire les chiffres.`,
      d.persistence_enabled
        ? "Conservation SQLite activée · checkpoint " +
          (d.last_checkpoint ? time(d.last_checkpoint) + " UTC" : "en attente")
        : "Conservation non attestée par ce serveur",
      d.persistence_error
        ? "ÉCHEC de conservation : " + d.persistence_error
        : "",
      d.restore_error ? "Restauration incomplète : " + d.restore_error : "",
      d.restored_contracts
        ? d.restored_contracts + " contrat(s) restauré(s) sur disque"
        : "",
      d.last_observed_ts
        ? "Dernière transaction reçue : " + time(d.last_observed_ts) + " UTC"
        : "",
      "Couverture partielle : absence de marqueur ≠ absence d’activité.",
    ]
      .filter(Boolean)
      .join("\n");
    if (!pinned) inspect(selected);
  }
  function focusBar(b) {
    const key = flowBarKey(b.t);
    if (!state.bars.has(String(key)) && !state.bars.has(key)) return;
    pinned = true;
    inspect(key);
    const logical = drawLogicalAtTime(key);
    if (logical != null)
      state.chart
        .timeScale()
        .setVisibleLogicalRange({ from: logical - 8, to: logical + 8 });
    state.chart.setCrosshairPosition(
      (state.bars.get(String(key)) || state.bars.get(key)).close,
      key,
      state.candles,
    );
  }
  function journal() {
    const rows = flowMarkerRows().filter((b) =>
      $("journal-kind").value === "big"
        ? b.big_n
        : $("journal-kind").value === "abs"
          ? b.abs_n
          : b.big_n || b.abs_n,
    );
    $("journal-count").textContent = "(" + rows.length + ")";
    $("journal-rows").replaceChildren();
    const slider = $("journal-replay");
    slider.max = Math.max(0, rows.length - 1);
    slider.disabled = !rows.length;
    for (const b of [...rows].reverse()) {
      const tr = make("tr", null, $("journal-rows"));
      for (const value of [
        time(b.t),
        amount(b.big_total || 0),
        b.big_n || 0,
        amount((b.abs_buy || 0) + (b.abs_sell || 0)),
        b.abs_n || 0,
      ])
        make("td", String(value), tr);
      const td = make("td", null, tr),
        button = make("button", "Inspecter", td);
      button.disabled =
        !state.bars.has(String(flowBarKey(b.t))) &&
        !state.bars.has(flowBarKey(b.t));
      button.addEventListener("click", () => focusBar(b));
    }
    slider.oninput = () => {
      const b = rows[Number(slider.value)];
      if (b) focusBar(b);
    };
    $("journal-export").onclick = () => {
      const text =
        "time_utc,big_total,big_count,estimated_total,episodes,unit\n" +
        rows
          .map((b) =>
            [
              new Date(b.t * 1000).toISOString(),
              b.big_total || 0,
              b.big_n || 0,
              (b.abs_buy || 0) + (b.abs_sell || 0),
              b.abs_n || 0,
              state.flowBarsUnit,
            ].join(","),
          )
          .join("\n");
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" })),
        a = make("a");
      a.href = url;
      a.download = state.symbol + "-observed-aggregates.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  }
  $("journal-kind").addEventListener("change", journal);
  function objects() {
    const signature = JSON.stringify(draw.shapes);
    if (signature === lastShapes) return;
    lastShapes = signature;
    $("drawing-objects").replaceChildren();
    if (!draw.shapes.length)
      make(
        "p",
        "Aucune annotation pour cet instrument. Les niveaux calculés ne sont pas des dessins.",
        $("drawing-objects"),
      );
    draw.shapes.forEach((sh, i) => {
      const row = make("div", null, $("drawing-objects"));
      row.className = "object-row";
      make("span", `${i + 1} · ${sh.tool}`, row);
      for (const [label, action] of [
        [
          "Sélectionner",
          () => {
            draw.sel = i;
            setDrawTool("cursor");
            drawOptsSync();
            queueDraw();
          },
        ],
        [
          sh.hidden ? "Afficher" : "Masquer",
          () => {
            if (sh.locked) return;
            sh.hidden = !sh.hidden;
            drawSave();
            queueDraw();
          },
        ],
        [
          sh.locked ? "Déverrouiller" : "Verrouiller",
          () => {
            sh.locked = !sh.locked;
            drawSave();
            drawOptsSync();
            queueDraw();
          },
        ],
        [
          "Dupliquer",
          () => {
            draw.sel = i;
            drawDuplicate();
          },
        ],
        [
          "Supprimer",
          () => {
            draw.sel = i;
            drawDelete();
          },
        ],
      ]) {
        const b = make("button", label, row);
        b.disabled =
          !!sh.locked && ["Masquer", "Afficher", "Supprimer"].includes(label);
        b.onclick = () => {
          action();
          lastShapes = "";
          objects();
        };
      }
    });
  }
  const settings = make("dialog", null, document.body);
  settings.id = "flow-settings-dialog";
  settings.innerHTML =
    '<form method="dialog"><button class="dialog-close">Fermer</button></form><h2>Affichage du flux</h2><p>Vert / rouge : sens des transactions. Bleu / jaune : côté agressif absorbé estimé, pas un signal directionnel. Options : activité prime / index stable, pas une absorption de carnet observée.</p>';
  const oldSettings = $("abs-settings");
  settings.append(oldSettings);
  oldSettings.open = true;
  for (const id of ["flow-read", "flow-overview"])
    $(id).addEventListener("click", () => settings.close());
  $("cockpit-flow-settings").onclick = () => {
    oldSettings.open = true;
    settings.showModal();
  };
  const plan = make("dialog", null, document.body);
  plan.id = "cockpit-plan";
  plan.innerHTML =
    '<form method="dialog"><button class="dialog-close">Fermer</button></form><h2>Un cockpit, deux lectures GEX</h2><div class="cockpit-blueprint"><header>Instrument · prix · état des sources</header><section>GRAPHIQUE<br><small>Prix, lignes, marqueurs, dessins</small></section><aside>CONTEXTE<br><small>Profil global ou échéances<br>Niveaux repositionnables</small></aside><footer>INSPECTEUR · couverture · journal · objets</footer></div><p>Le graphique reste prioritaire. Les réglages ne masquent plus les bougies. Classique conserve le profil global ; Analyse ouvre la grille par échéance. Aucune source ou donnée supplémentaire n’est créée par ce changement de vue.</p>';
  $("cockpit-layout").onclick = () => plan.showModal();
  window.addEventListener("flow-data", () => {
    coverage();
    journal();
  });
  setInterval(() => {
    if (document.hidden) return;
    const next = flowContext() + "|" + (state.flowContract || "");
    if (next !== context) {
      context = next;
      selected = null;
      pinned = false;
      lastShapes = "";
      journal();
    }
    if (chart !== state.chart && state.chart) {
      chart = state.chart;
      chart.subscribeCrosshairMove((param) => {
        if (!pinned && param.time != null) inspect(param.time);
      });
      chart.subscribeClick((param) => {
        if (param.time != null) {
          pinned = true;
          inspect(param.time);
        }
      });
    }
    levels();
    coverage();
    objects();
  }, 700);
  window.addEventListener("resize", () => {
    if (rail.classList.contains("floating")) position();
    levelKey = "";
  });
  window.gexAccessReady.then(() => {
    position();
    levels();
    coverage();
    journal();
    objects();
    queueGamma();
  });
})();
