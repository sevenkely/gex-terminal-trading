/* Visual layer only: no market subscription, calculation or simulated ticks. */
"use strict";
(() => {
  const marks = {
    SPX: ["sp-global", "S&P 500 · marque du fournisseur S&P Global"],
    SPY: ["state-street", "SPDR S&P 500 ETF · marque de State Street"],
    QQQ: ["invesco", "Invesco QQQ · marque de l’émetteur Invesco"],
    ES: ["cme-group", "E-mini S&P 500 · marque de la place CME Group"],
    NQ: ["cme-group", "E-mini Nasdaq-100 · marque de la place CME Group"],
    GLD: [
      "state-street",
      "SPDR Gold Shares · marque du distributeur State Street",
    ],
    GC: ["cme-group", "Gold futures COMEX · marque de la place CME Group"],
    BTC: ["bitcoin", "Bitcoin"],
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const control = document.createElement("label");
  control.className = "motion-control";
  control.innerHTML =
    '<span class="motion-orbit" aria-hidden="true"></span><span>Animations</span><select id="motion-level" aria-label="Intensité des animations"><option value="rich">Immersives</option><option value="calm">Discrètes</option><option value="off">Désactivées</option></select>';
  $("workspace-bar").append(control);
  const select = $("motion-level");
  const stored = localStorage.getItem("gex.motion");
  select.value = ["rich", "calm", "off"].includes(stored) ? stored : "rich";
  function motion() {
    document.body.dataset.motion = reduced.matches ? "off" : select.value;
    select.title = reduced.matches
      ? "Mouvements réduits selon votre système"
      : "Animations visuelles uniquement — aucun signal de marché";
  }
  select.onchange = () => {
    localStorage.setItem("gex.motion", select.value);
    motion();
  };
  reduced.addEventListener("change", motion);
  motion();
  document.body.classList.add("design-studio");
  const visibility = () =>
    document.body.classList.toggle("motion-paused", document.hidden);
  document.addEventListener("visibilitychange", visibility);
  visibility();

  function mark(symbol, className) {
    const info = marks[symbol];
    if (!info) return null;
    const img = document.createElement("img");
    img.className = className;
    img.src = `assets/instruments/${info[0]}.png`;
    img.alt = ""; // Adjacent symbol is the accessible name; title explains the issuer/exchange.
    img.width = 28;
    img.height = 28;
    img.title = info[1];
    img.draggable = false;
    return img;
  }
  function instruments() {
    for (const tab of $("tabs").children) {
      if (tab.querySelector(".instrument-mark")) continue;
      const img = mark(tab.dataset.sym, "instrument-mark");
      if (img) tab.prepend(img);
      tab.title = marks[tab.dataset.sym]?.[1] || tab.dataset.sym;
    }
  }
  new MutationObserver(instruments).observe($("tabs"), { childList: true });
  instruments();
  let symbol;
  function hero() {
    if (symbol === $("hero-symbol").textContent) return;
    symbol = $("hero-symbol").textContent;
    $("hero-instrument-mark")?.remove();
    const img = mark(symbol, "hero-instrument-mark");
    if (img) {
      img.id = "hero-instrument-mark";
      $("hero-symbol").before(img);
    }
    if (document.body.dataset.motion !== "off" && !document.hidden) {
      $("hero").animate(
        [
          { opacity: 0.4, transform: "translateY(5px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 400, easing: "cubic-bezier(.16,1,.3,1)" },
      );
    }
  }
  new MutationObserver(hero).observe($("hero-symbol"), {
    childList: true,
    characterData: true,
    subtree: true,
  });
  hero();

  // Restart a value highlight only for changed content, not for polling redraws.
  const observed = ["essential-gex", "essential-move", "essential-regime"];
  for (const id of observed) {
    const element = $(id);
    let previous = element.textContent;
    new MutationObserver(() => {
      const value = element.textContent;
      if (value === previous) return;
      previous = value;
      if (document.hidden || document.body.dataset.motion === "off") return;
      element.animate(
        [
          { filter: "brightness(1.65)", transform: "translateY(-2px)" },
          { filter: "brightness(1)", transform: "none" },
        ],
        { duration: 650, easing: "ease-out" },
      );
    }).observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (
      !button ||
      button.disabled ||
      document.body.dataset.motion !== "rich" ||
      document.hidden
    )
      return;
    button.animate([{ transform: "scale(.96)" }, { transform: "scale(1)" }], {
      duration: 260,
      easing: "cubic-bezier(.16,1,.3,1)",
    });
  });
  // Animate view changes once, never on every quote or canvas redraw.
  $("cockpit-detail").addEventListener("click", () => {
    if (document.body.dataset.motion === "off") return;
    $("sidebar").animate(
      [
        { opacity: 0.25, transform: "translateX(12px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 450, easing: "cubic-bezier(.16,1,.3,1)" },
    );
  });
})();
