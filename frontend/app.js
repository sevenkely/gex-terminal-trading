/* ================= GEX Terminal — frontend v2 ================= */
"use strict";

const $ = (id) => document.getElementById(id);
function storedJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function regimeLabel(regime) {
  return ({long_gamma: "LONG GAMMA ESTIMÉ", short_gamma: "SHORT GAMMA ESTIMÉ", neutral: "GAMMA NEUTRE", unavailable: "GEX INDISPONIBLE"})[regime] || "GEX INDISPONIBLE";
}
let adminToken = "";
async function adminFetch(url, options = {}) {
  const r = await fetch(url, {...options, headers: {...options.headers, Authorization: `Bearer ${adminToken}`}});
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.detail || `Erreur administration ${r.status}`);
  }
  return r;
}
const FUTURES = new Set(["ES", "NQ", "GC"]);
const CRYPTO = new Set(["BTC"]);   // tape Deribit : perp (notionnel) ou options (prime)
const PERIOD = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "1d": 86400 };

const state = {
  symbol: "SPX",
  interval: "1d",
  filter: "all",
  win: Number(localStorage.getItem("gex.win") || 3),
  ladderOn: localStorage.getItem("gex.ladder") !== "0",
  sound: localStorage.getItem("gex.sound") === "1",
  histArr: [], pulses: [], crossCounts: {},
  ltgl: Object.assign({ cw: true, pw: true, flip: true, pain: false, hist: false, band: false,
    vwap: true, prof: false, heat: false },
    storedJSON("gex.ltgl", {})),
  ws: null,
  wsTimer: null,
  reconnects: 0,
  chart: null,
  candles: null,
  volume: null,
  lines: {},
  pins: new Map(),
  lastBar: null,
  bars: new Map(),          // time -> bar (pour la légende OHLC)
  barsDaily: false,
  levels: {},
  meta: {},
  profile: null,
  prevPrice: null,
  tickCount: 0,
  symbols: [],
  sparks: {},
  fit: false,
  colors: { up: "#2dd4a7", down: "#f0616d" },
  // bulles gros trades / absorptions (style Deepchart)
  bubbles: localStorage.getItem("gex.bubbles") !== "0",
  flowBig: [], flowAbsorb: [], flowUnit: "USD", flowUsd: false,
  flowHits: [],          // bulles dessinées (hit-test du tooltip)
  flowBars: [],          // delta/CVD par bougie (bande basse)
  flowBarsUnit: "contrats",
  flowTipEl: null,
};

/* ---------------- odomètre (transition chiffrée) ---------------- */
function tweenNum(el, to, fmt) {
  const from = el._v ?? to;
  el._v = to;
  if (from === to || !isFinite(from)) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 420;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------------- formatage ---------------- */
function fmtUSD(x) {
  if (x == null || !isFinite(x)) return "—";
  const s = x < 0 ? "−" : "", a = Math.abs(x);
  if (a >= 1e12) return s + "$" + (a / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(0) + "K";
  return s + "$" + a.toFixed(0);
}
function fmtPx(x, sym) {
  if (x == null) return "—";
  if (sym === "SPX" || sym === "NQ") return Math.round(x).toLocaleString("en-US");
  return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const fmtPrice = (x) => fmtPx(x, state.symbol);

function err(msg) {
  const b = $("error-banner");
  b.textContent = msg; b.hidden = false;
  setTimeout(() => (b.hidden = true), 6000);
}
function toast(msg, kind = "info", ttl = 5000) {
  const t = document.createElement("div");
  t.className = "toast";
  if (kind && (kind.startsWith("var(") || kind.startsWith("#"))) t.style.borderLeftColor = kind;
  else t.classList.add(kind);
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, ttl);
}

/* ---------------- chart ---------------- */
function initChart() {
  const el = $("chart");
  el.innerHTML = "";
  const chart = LightweightCharts.createChart(el, {
    layout: { background: { color: "transparent" }, textColor: "#8492a6", fontSize: 11, fontFamily: "'JetBrains Mono', monospace" },
    grid: { vertLines: { color: "rgba(26,34,51,.55)" }, horzLines: { color: "rgba(26,34,51,.55)" } },
    rightPriceScale: { borderColor: "#1a2233", scaleMargins: { top: 0.07, bottom: 0.22 } },
    timeScale: { borderColor: "#1a2233", timeVisible: true, secondsVisible: false, rightOffset: gp.on ? 18 : 6, barSpacing: 7 },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "rgba(79,142,247,.5)", width: 1, style: 3, labelBackgroundColor: cssVar("--elev") },
      horzLine: { color: "rgba(79,142,247,.5)", width: 1, style: 3, labelBackgroundColor: cssVar("--elev") },
    },
    localization: { priceFormatter: (p) => p.toLocaleString("en-US", { maximumFractionDigits: 2 }) },
  });
  const candles = chart.addSeries(LightweightCharts.CandlestickSeries, {
    autoscaleInfoProvider: (original) => (state.fit ? levelsAutoscale(original) : original()),
    upColor: state.colors.up, downColor: state.colors.down,
    wickUpColor: state.colors.up + "bf", wickDownColor: state.colors.down + "bf",
    borderVisible: false, priceLineColor: "#4f8ef7",
  });
  const volume = chart.addSeries(LightweightCharts.HistogramSeries, {
    priceFormat: { type: "volume" }, priceScaleId: "vol",
    lastValueVisible: false, priceLineVisible: false,
  });
  // axe volume masqué : la bande delta/CVD occupe le bas du chart (voir drawDeltaBand)
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.755, bottom: 0.175 }, visible: false });
  chart.priceScale("right").applyOptions({ minimumWidth: 122 });
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => { queueGamma(); queueDraw(); queueFlow(); });
  chart.priceScale("right").subscribeVisibleValueRangeChange?.(() => { queueGamma(); queueFlow(); });

  chart.subscribeCrosshairMove((param) => {
    state.crosshairActive = !!(param && param.time != null);
    let bar = null;
    if (state.crosshairActive) {
      bar = state.bars.get(param.time) || state.bars.get(String(param.time));
    }
    renderOhlc(bar || state.lastBar);
    updateHud(param);
  });

  new ResizeObserver(() => {
    chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    queueFlow();
  }).observe(el);
  chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  state.chart = chart; state.candles = candles; state.volume = volume;
  state.lines = {}; state.pins.clear();
}

function renderOhlc(b) {
  const el = $("ohlc-legend");
  if (!b) { el.innerHTML = ""; return; }
  const c = b.close >= b.open ? "green" : "red";
  el.innerHTML =
    `<span>${state.symbol} · ${state.interval.toUpperCase()}</span>` +
    `<span>O <b>${fmtPrice(b.open)}</b></span><span>H <b class="${c}">${fmtPrice(b.high)}</b></span>` +
    `<span>L <b class="${c}">${fmtPrice(b.low)}</b></span><span>C <b class="${c}">${fmtPrice(b.close)}</b></span>` +
    (b.volume ? `<span>Vol <b>${(b.volume / 1e6).toFixed(2)}M</b></span>` : "");
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const fmtOI = (x) => x == null ? "" :
  x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "K" : String(Math.round(x));
const WALL_C = "#2dd4a7", WALL_P = "#f0616d", FLIP_C = "#f5c542", PAIN_C = "#e8ecf4";

function makeLine(key, opts) {
  const ln = state.candles.createPriceLine(opts);
  state.lines[key] = ln;
  return ln;}
const D = LightweightCharts.LineStyle.Dashed;
const S = LightweightCharts.LineStyle.Solid;

function drawLevels(L, profile) {
  state.levels = L || {};
  const up = state.candles;
  const setLine = (key, price, opts) => {
    if (price == null) { if (state.lines[key]) { up.removePriceLine(state.lines[key]); delete state.lines[key]; } return; }
    if (state.lines[key]) state.lines[key].applyOptions({ price, ...opts });
    else makeLine(key, { price, ...opts });
  };
  const W = (L && L.walls) || { call: [], put: [] };
  const T = state.ltgl;
  const maxC = W.call.length ? Math.max(1, ...W.call.map((e) => Math.abs(e.gex))) : 1;
  const maxP = W.put.length ? Math.max(1, ...W.put.map((e) => Math.abs(e.gex))) : 1;

  // top-N walls : lignes fines pile sur le strike ; #1 pleine et épaisse,
  // secondaires 1 px avec opacité proportionnelle à la magnitude du GEX
  for (let i = 0; i < 5; i++) {
    const c = W.call[i], p = W.put[i];
    if (T.cw && c) setLine("cw" + i, c.strike, {
      color: i ? hexA(WALL_C, 0.28 + 0.62 * Math.abs(c.gex) / maxC) : WALL_C,
      lineWidth: i ? 1 : 2, lineStyle: S, axisLabelVisible: false, title: "",
    }); else setLine("cw" + i, null);
    if (T.pw && p) setLine("pw" + i, p.strike, {
      color: i ? hexA(WALL_P, 0.28 + 0.62 * Math.abs(p.gex) / maxP) : WALL_P,
      lineWidth: i ? 1 : 2, lineStyle: S, axisLabelVisible: false, title: "",
    }); else setLine("pw" + i, null);
  }
  const flip = L.gamma_flip ?? L.zero_gex;
  if (T.flip && flip != null) setLine("flip", flip, { color: FLIP_C, lineWidth: 1, lineStyle: S, axisLabelVisible: false, title: "" });
  else setLine("flip", null);
  if (T.pain && L.max_pain != null) setLine("pain", L.max_pain, { color: hexA(PAIN_C, .7), lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: false, title: "" });
  else setLine("pain", null);
  setLine("emup", L.em_up, { color: "rgba(79,142,247,.75)", lineWidth: 1, lineStyle: D, axisLabelVisible: false, title: "+1σ" });
  setLine("emdn", L.em_down, { color: "rgba(79,142,247,.75)", lineWidth: 1, lineStyle: D, axisLabelVisible: false, title: "−1σ" });

  // légende compacte
  const lg = [];
  W.call.slice(0, 3).forEach((e, i) => lg.push(`<span class="green">CW${i + 1} ${fmtPrice(e.strike)}</span>`));
  W.put.slice(0, 3).forEach((e, i) => lg.push(`<span class="red">PW${i + 1} ${fmtPrice(e.strike)}</span>`));
  if (flip != null) lg.push(`<span class="yellow">FLIP ${fmtPrice(flip)}</span>`);
  if (T.pain && L.max_pain != null) lg.push(`<span class="muted">PAIN ${fmtPrice(L.max_pain)}</span>`);
  $("legend-lines").innerHTML = lg.join("");

  // tiles
  $("lv-callwall").textContent = fmtPrice(L.call_wall);
  $("lv-putwall").textContent = fmtPrice(L.put_wall);
  const w0c = W.call[0], w0p = W.put[0];
  $("lv-callwall-gex").textContent = w0c ? `${fmtUSD(w0c.gex)} · ${fmtOI(w0c.oi)} OI` : "";
  $("lv-putwall-gex").textContent = w0p ? `${fmtUSD(w0p.gex)} · ${fmtOI(w0p.oi)} OI` : "";
  $("lv-zerogex").textContent = fmtPrice(flip);
  $("lv-netgex").textContent = L.available === false || L.regime === "unavailable" ? "—" : fmtUSD(L.net_gex_total);
  const tg = $("tile-netgex");
  tg.classList.toggle("long", L.regime === "long_gamma");
  tg.classList.toggle("short", L.regime === "short_gamma");
  $("lv-em").textContent = L.em_sigma ? "± " + fmtPrice(L.em_sigma) : "—";
  $("lv-em-note").textContent = L.em_up != null ? `${fmtPrice(L.em_down)} — ${fmtPrice(L.em_up)}` : "";
  $("lv-maxpain").textContent = fmtPrice(L.max_pain);
  $("lv-maxpain-note").textContent = (L.max_pain != null && L.spot != null)
    ? `${((L.max_pain / L.spot - 1) * 100).toFixed(2)} % du spot` : "";
  $("lv-gpcall").textContent = fmtPrice(L.gamma_peak_call);
  $("lv-gpput").textContent = fmtPrice(L.gamma_peak_put);
  $("lv-iv30").textContent = L.iv30 ? L.iv30.toFixed(1) + " %" : "—";
  if (state.meta && state.meta.contracts != null) {
    $("lv-oi").textContent = CRYPTO.has(state.symbol)
      ? Math.round(state.meta.contracts / 1e3) + "k"
      : (state.meta.contracts / 1e6).toFixed(2) + "M";
  }
  $("lv-zerogex-note").textContent =
    (flip != null && L.spot != null) ? (L.spot > flip ? "spot au-dessus du flip" : "spot sous le flip") : "";

  const at = (k) => {
    if (!profile || !profile.strikes || k == null) return "";
    const i = profile.strikes.indexOf(k);
    return i < 0 ? "" : fmtUSD(profile.net_gex[i]);
  };
  $("lv-gpcall-gex").textContent = at(L.gamma_peak_call);
  $("lv-gpput-gex").textContent = at(L.gamma_peak_put);

  // régime
  const rb = $("regime-badge");
  if (L.regime === "long_gamma") { rb.textContent = "LONG GAMMA ESTIMÉ"; rb.className = "badge long"; }
  else if (L.regime === "short_gamma") { rb.textContent = "SHORT GAMMA ESTIMÉ"; rb.className = "badge short"; }
  else { rb.textContent = regimeLabel(L.regime); rb.className = "badge"; }

  // pin score : proximité spot/flip relativement à σ daily
  const flip0 = L.gamma_flip ?? L.zero_gex;
  let pin = 0;
  if (flip0 != null && L.spot && L.em_sigma) {
    pin = Math.round(100 * Math.exp(-Math.abs(L.spot - flip0) / Math.max(L.em_sigma, 1e-9)));
    if (L.regime === "long_gamma") pin = Math.min(100, pin + 15);
  }
  $("lv-pin").textContent = pin ? pin + " / 100" : "—";
  $("pin-gauge").style.setProperty("--sc", String(pin));
  $("lv-pin-note").textContent = flip0 != null && L.spot
    ? `${Math.round(Math.abs(L.spot - flip0))} pts · indice heuristique, pas une probabilité` : "";

  renderZoneMap(L);
  renderRail();
  renderLadder();
  renderTape();
  queueGamma();
  queueDraw();
  const hr = $("hero-regime");
  if (L.regime) {
    hr.hidden = false;
    hr.textContent = regimeLabel(L.regime);
    hr.className = "mono " + (L.regime === "long_gamma" ? "long" : L.regime === "short_gamma" ? "short" : "");
    hr.id = "hero-regime";
  }
}

/* ---------------- zone map ---------------- */
function renderZoneMap(L) {
  const spot = L.spot;
  if (spot == null) return;
  const win = (state.win || 3) / 100;
  let lo = spot * (1 - win), hi = spot * (1 + win);
  for (const x of [L.gamma_flip, L.zero_gex, L.max_pain, L.call_wall, L.put_wall]) {
    if (x == null) continue;
    if (x > spot * (1 - 2.5 * win) && x < spot * (1 + 2.5 * win)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  }
  const pad = Math.max((hi - lo) * 0.06, spot * 0.0012);
  lo -= pad; hi += pad;
  const pos = (x) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
  const clampLabel = (x) => Math.max(7, Math.min(93, pos(x)));

  const em = $("zm-em");
  if (L.em_up != null && L.em_down != null) {
    em.style.left = pos(L.em_down) + "%";
    em.style.width = (pos(L.em_up) - pos(L.em_down)) + "%";
    em.style.display = "";
  } else em.style.display = "none";

  const setMarker = (id, x) => {
    const m = $(id);
    if (x == null) { m.style.display = "none"; return; }
    m.style.display = "";
    m.style.left = pos(x) + "%";
  };
  setMarker("zm-spot", spot);
  setMarker("zm-pw", L.put_wall);
  setMarker("zm-cw", L.call_wall);
  setMarker("zm-pain", L.max_pain);
  // labels pw / spot / cw avec écart minimal anti-collision
  let pP = clampLabel(L.put_wall ?? spot), pS = clampLabel(spot), pC = clampLabel(L.call_wall ?? spot);
  if (pS - pP < 15) pP = Math.max(6, pS - 15);
  if (pC - pS < 15) pC = Math.min(94, pS + 15);
  $("zm-pw-label").style.left = pP + "%";
  $("zm-pw-label").textContent = L.put_wall != null ? fmtPrice(L.put_wall) : "";
  $("zm-cw-label").style.left = pC + "%";
  $("zm-cw-label").textContent = L.call_wall != null ? fmtPrice(L.call_wall) : "";
  $("zm-spot-label").style.left = pS + "%";
  $("zm-spot-label").textContent = fmtPrice(spot);
  // walls structurels (gros OI) : drapeaux clipés hors échelle
  const sc = L.struct_call, sp = L.struct_put;
  $("zm-struct-c").textContent = sc != null && sc > hi ? `OI ${fmtPrice(sc)} ▶` : "";
  $("zm-struct-p").textContent = sp != null && sp < lo ? `◀ OI ${fmtPrice(sp)}` : "";
  const zg = $("zm-zero");
  const flip = L.gamma_flip ?? L.zero_gex;
  if (flip != null) { zg.style.display = ""; zg.style.left = pos(flip) + "%"; }
  else zg.style.display = "none";

  // ticks des walls secondaires (rangs 2-3)
  const track = document.querySelector("#zonemap .zm-track");
  track.querySelectorAll(".zm-tick").forEach((n) => n.remove());
  const addTick = (x, color) => {
    if (x == null || x < lo || x > hi) return;
    const d = document.createElement("div");
    d.className = "zm-tick";
    d.style.left = pos(x) + "%";
    d.style.background = color;
    track.appendChild(d);
  };
  const W = L.walls || { call: [], put: [] };
  (W.call || []).slice(1, 4).forEach((e) => addTick(e.strike, WALL_C));
  (W.put || []).slice(1, 4).forEach((e) => addTick(e.strike, WALL_P));
}

/* ---------------- profil GEX ---------------- */
function renderProfile(P) {
  const el = $("profile");
  if (!P || !P.strikes || !P.strikes.length) { el.innerHTML = "<div class='muted' style='padding:10px'>Pas de données</div>"; return; }
  state.profile = P;
  const spot = state.levels.spot ?? P.strikes[Math.floor(P.strikes.length / 2)];
  const lo = spot * 0.975, hi = spot * 1.025;
  let idx = [];
  for (let i = 0; i < P.strikes.length; i++) if (P.strikes[i] >= lo && P.strikes[i] <= hi) idx.push(i);
  for (const k of [P.strikes.indexOf(state.levels.call_wall), P.strikes.indexOf(state.levels.put_wall)]) {
    if (k >= 0 && !idx.includes(k)) idx.push(k);
  }
  idx.sort((a, b) => P.strikes[b] - P.strikes[a]);
  if (idx.length > 120) idx = idx.slice(0, 120);

  const maxAbs = Math.max(...idx.map((i) => Math.abs(P.net_gex[i])), 1);
  const step = idx.length > 1 ? Math.abs(P.strikes[idx[0]] - P.strikes[idx[1]]) : 1;
  let zgIdx = -1, bd = Infinity;
  if (state.levels.zero_gex != null) {
    for (const i of idx) { const d = Math.abs(P.strikes[i] - state.levels.zero_gex); if (d < bd) { bd = d; zgIdx = i; } }
  }

  const frag = document.createDocumentFragment();
  for (const i of idx) {
    const k = P.strikes[i], net = P.net_gex[i];
    const row = document.createElement("div");
    row.className = "prow " + (net >= 0 ? "pos" : "neg");
    if (Math.abs(k - spot) < step / 2) row.classList.add("spot");
    if (state.pins.has(k)) row.classList.add("pinned");
    const w = Math.max(2, Math.round((Math.abs(net) / maxAbs) * 48));
    let tags = "";
    if (k === state.levels.call_wall) tags += "<span class='tag cw'>CW</span>";
    if (k === state.levels.put_wall) tags += "<span class='tag pw'>PW</span>";
    if (i === zgIdx && bd < step) tags += "<span class='tag zg'>ZG</span>";
    row.innerHTML =
      `<span class="k">${fmtPx(k, state.symbol)}${tags}</span>` +
      `<span class="bar-wrap"><span class="bar-mid"></span><span class="bar" style="width:${w}%"></span></span>` +
      `<span class="v">${fmtUSD(net)}</span>`;
    row.title = `Call GEX ${fmtUSD(P.call_gex[i])} · Put GEX ${fmtUSD(P.put_gex[i])}\nOI calls ${Math.round(P.call_oi[i]).toLocaleString()} · OI puts ${Math.round(P.put_oi[i]).toLocaleString()}`;
    row.addEventListener("click", () => togglePin(k));
    frag.appendChild(row);
  }
  el.innerHTML = "";
  el.appendChild(frag);
  queueGamma();
}

function togglePin(k) {
  if (state.pins.has(k)) {
    state.candles.removePriceLine(state.pins.get(k));
    state.pins.delete(k);
  } else {
    state.pins.set(k, makeLine("pin" + k, {
      price: k, color: "#8f9bb3", lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true,
      title: "● " + fmtPx(k, state.symbol),
    }));
  }
  renderProfile(state.profile);
}

/* ---------------- chargement données ---------------- */
let histSeq = 0;
async function loadHistory() {
  const iv = state.interval;
  const seq = ++histSeq;
  const r = await fetch(`/api/history/${state.symbol}?interval=${iv}`);
  const j = await r.json();
  if (seq !== histSeq) return;   // un switch plus récent a eu lieu entre-temps
  if (j.error || !j.bars) throw new Error(j.error || "historique indisponible");
  // filet de sécurité client : bougies aberrantes -> corps plat
  for (const b of j.bars) {
    if (!(b.high >= b.low) || b.high > 1.8 * b.close || b.low < 0.55 * b.close) {
      b.high = Math.max(b.open, b.close); b.low = Math.min(b.open, b.close);
    }
  }
  state.barsDaily = iv === "1d";
  state.bars = new Map(j.bars.map((b) => [String(b.time), b]));
  state.histArr = j.bars;
  state.candles.setData(j.bars);
  computeSession(j.bars);
  state.volume.setData(j.bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? state.colors.up + "4d" : state.colors.down + "4d" })));
  state.lastBar = j.bars.length ? { ...j.bars[j.bars.length - 1] } : null;
  smartZoom();
  renderOhlc(state.lastBar);
  queueGamma();
  queueDraw();
}

/* zoom par défaut lisible : ~3 fenêtres de séance en intraday, tout en 1D */
function smartZoom() {
  const n = state.bars.size;
  if (state.barsDaily || n <= 200) { state.chart.timeScale().fitContent(); return; }
  const want = { "1m": 390, "5m": 200, "15m": 160, "30m": 140, "1h": 180 }[state.interval] || 200;
  state.chart.timeScale().setVisibleLogicalRange({ from: n - want, to: n + (gp.on ? 18 : 6) });
}

/* échelle de prix incluant les niveaux GEX (bouton NIVEAUX) */
function levelsAutoscale(original) {
  const base=original?.();
  const L = state.levels || {};
  const vals = [L.call_wall, L.put_wall, L.zero_gex, state.selectedExposureStrike, base?.priceRange?.minValue, base?.priceRange?.maxValue].filter((v) => Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const pad = (mx - mn) * 0.10 || mx * 0.01;
  return { ...base, priceRange: { minValue: mn - pad, maxValue: mx + pad } };
}
$("fit-toggle").addEventListener("click", () => {
  state.fit = !state.fit;
  $("fit-toggle").classList.toggle("active", state.fit);
  state.candles?.applyOptions({ autoscaleInfoProvider: (original) => (state.fit ? levelsAutoscale(original) : original()) });
  queueGamma();
});

let gexSeq = 0;
async function loadGex() {
  const seq = ++gexSeq, sym = state.symbol, filter = state.filter;
  const r = await fetch(`/api/gex/${sym}?filter=${filter}&win=${state.win}`);
  const j = await r.json();
  if (seq !== gexSeq || sym !== state.symbol || filter !== state.filter) return;
  if (j.error) throw new Error(j.error);
  state.meta = j.meta;
  renderDataStatus(j.meta);
  fetchHeat();
  drawLevels(j, j);
  renderProfile(j);
  // hero + badges + statusbar
  $("hero-symbol").textContent = state.symbol;
  const pb = $("proxy-badge");
  if (j.meta.gex_source) {
    pb.hidden = false;
    pb.textContent = `GEX ${j.meta.gex_source} PROJETÉ`;
    pb.title = `Zones calculées sur la chaîne ${j.meta.gex_source}, transposées via ${j.meta.map_desc}`;
    $("hero-sub").textContent = `${j.meta.map_desc} · chaîne ${j.meta.gex_source} ${fmtChainTs(j.meta.chain_ts)}`;
  } else {
    pb.hidden = true;
    $("hero-sub").textContent = CRYPTO.has(state.symbol)
      ? `Deribit · chaîne ${fmtChainTs(j.meta.chain_ts)} · ${Math.round(j.meta.contracts / 1e3)}k contrats OI (BTC)`
      : `CBOE delayed 15-min · chaîne ${fmtChainTs(j.meta.chain_ts)} · ${(j.meta.contracts / 1e6).toFixed(2)}M contrats OI`;
  }
  $("lv-oi").textContent = CRYPTO.has(state.symbol)
    ? Math.round(j.meta.contracts / 1e3) + "k" : (j.meta.contracts / 1e6).toFixed(2) + "M";
  updateChainAge(j.meta.chain_ts);
  setMode(j.meta.mode);
  skeletons(false);
  queueHeroSpark();
  renderReaction();
  renderLadder();
}

function fmtChainTs(ts) { return (ts || "").replace("T", " ").slice(0, 16) + " ET"; }
let chainTsCache = null;
function updateChainAge(ts) {
  chainTsCache = ts;
  renderChainAge();
}
function renderChainAge() {
  if (!chainTsCache) return;
  const src = CRYPTO.has(state.symbol) ? "Deribit" : "CBOE";
  try {
    // CBOE envoie un horodatage nu, Deribit un ISO déjà suffixé du fuseau
    const iso = /([+-]\d\d:\d\d|Z)$/.test(chainTsCache) ? chainTsCache : chainTsCache + "-04:00";
    const t = state.meta?.chain_ts_epoch ? new Date(state.meta.chain_ts_epoch * 1000) : new Date(iso);
    const age = Date.now() - t.getTime();
    const mins = Math.max(0, Math.round(age / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    const left = state.nextRefresh ? state.nextRefresh * 1000 - Date.now() : 15 * 60000 - age;
    let cd = "";
    if (left > 0) {
      const mm = String(Math.floor(left / 60000)).padStart(2, "0");
      const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
      cd = ` · maj ${src} dans ${mm}:${ss}`;
    } else cd = ` · maj ${src} en cours…`;
    $("sb-chain").textContent = `chaîne ${src} ${fmtChainTs(chainTsCache)} · ${h > 0 ? h + " h " : ""}${m} min${cd}`;
  } catch { $("sb-chain").textContent = `chaîne ${src} ${fmtChainTs(chainTsCache)}`; }
}
setInterval(renderChainAge, 1000);

function renderDataStatus(meta) {
  state.dataStatus = meta;
  const empty = meta.available === false;
  $("expiry-empty").hidden = !empty;
  $("expiry-empty-title").textContent = state.filter === "0dte" ? "Aucune option 0DTE exploitable aujourd'hui" : "Aucune option exploitable pour ce filtre";
  const next = meta.next_expiry ? new Date(meta.next_expiry * 1000).toLocaleString("fr-FR", {timeZone: meta.timezone, dateStyle: "short", timeStyle: "short"}) : "non disponible";
  $("expiry-empty-detail").textContent = `${meta.valuation_date || ""} · ${meta.timezone || ""}. Les échéances expirées et l'OI nul sont exclus. Après expiration, le week-end ou sans OI publié, le 0DTE peut être vide. Prochaine échéance avec OI : ${next}. Aucun remplacement automatique par une autre échéance.`;
  $("filter-summary").textContent = `${state.filter.toUpperCase()} · ${meta.filtered_contracts || 0} séries · ${fmtOI(meta.filtered_oi || 0)} OI`;
  const age = Math.max(0, Math.floor((Date.now() / 1000 - (meta.chain_ts_epoch || Date.now() / 1000)) / 60));
  $("data-quality").title = meta.model_inputs ? JSON.stringify(meta.model_inputs,null,2) : "";
  $("data-quality").textContent = `Options : ${CRYPTO.has(state.symbol) ? "Deribit" : "CBOE différées ~15 min"} · snapshot ${age} min · ${meta.oi_reference || "Date OI inconnue"} · GEX estimé calls + / puts −${state.meta?.gex_source ? ` · proxy ${state.meta.gex_source} → ${state.symbol}` : ""}${meta.projection && !meta.projection.fresh ? " · BASIS PÉRIMÉ — alertes suspendues" : ""}`;
}
$("expiry-show-all").addEventListener("click", () => document.querySelector('#filters [data-f="all"]').click());

function setMode(m) {
  state.mode = m;
  const warning = $("feed-warning");
  warning.hidden = m === "RITHMIC" || m === "DERIBIT";
  warning.dataset.mode = m;
  warning.textContent = m === "SIM" ? "DÉMONSTRATION — prix simulés, non utilisables pour une décision réelle. Alertes de trading suspendues." : m === "STALE" ? "FLUX INTERROMPU — dernier prix figé. Aucun passage automatique en simulation. Alertes suspendues." : "PRIX DIFFÉRÉ — aucun flux de prix temps réel connecté. Dernier prix connu figé ; alertes suspendues.";
  const chip = $("mode-chip");
  if (m === "RITHMIC") {
    chip.className = "chip rithmic"; $("mode-label").textContent = "RITHMIC LIVE";
    $("sb-sources").textContent = "CBOE delayed 15-min · Yahoo Finance · ticks RITHMIC temps réel";
  } else if (m === "DERIBIT") {
    chip.className = "chip rithmic"; $("mode-label").textContent = "DERIBIT LIVE";
    $("sb-sources").textContent = "Options Deribit 24/7 (OI · IV · échéances quotidiennes) · index BTC et tape temps réel";
  } else {
    chip.className = "chip sim"; $("mode-label").textContent = m === "SIM" ? "DÉMO / SIM" : m === "STALE" ? "FLUX PÉRIMÉ" : "DIFFÉRÉ";
    $("sb-sources").textContent = `Prix ${m === "SIM" ? "simulés" : m === "STALE" ? "figés (flux interrompu)" : "différés"} · options ${CRYPTO.has(state.symbol) ? "Deribit" : "CBOE différées"}`;
  }
}

/* ---------------- websocket ---------------- */
function barKey(tsSeconds) {
  if (state.barsDaily) return new Date(tsSeconds * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const p = PERIOD[state.interval] || 300;
  return Math.floor(tsSeconds / p) * p;
}

function onTick(msg) {
  if (msg.data_status) renderDataStatus(msg.data_status);
  if (msg.mode) setMode(msg.mode);
  const p = msg.price;
  const el = $("live-price"), ch = $("live-change");
  tweenNum(el, p, fmtPrice);
  const up = (msg.change_pct ?? 0) >= 0;
  el.className = "mono " + (up ? "up" : "down");
  ch.className = "chg-pill mono " + (up ? "up" : "down");
  ch.textContent = (up ? "+" : "") + (msg.change_pct ?? 0).toFixed(2) + " %";
  // flash
  if (state.prevPrice != null && p !== state.prevPrice) {
    const f = p > state.prevPrice ? "flash-up" : "flash-down";
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth;
    el.classList.add(f);
  }
  state.prevPrice = p;

  // sparkline live de l'onglet actif
  const sp = (state.sparks[state.symbol] ||= []);
  if (sp[sp.length - 1] !== p) { sp.push(p); if (sp.length > 48) sp.shift(); }
  const tb = document.querySelector(`#tabs button[data-sym="${state.symbol}"] .t-spark`);
  if (tb && sp.length > 1) tb.innerHTML = sparkSVG(sp, (msg.change_pct ?? 0) >= 0 ? "var(--green)" : "var(--red)");
  renderTape();

  // bougie live
  if (state.lastBar && msg.ts && ["RITHMIC", "DERIBIT", "SIM"].includes(msg.mode)) {
    const key = barKey(msg.ts);
    const lastKey = state.lastBar.time;
    if ((typeof key === "number" && key > lastKey) || (typeof key === "string" && key > String(lastKey))) {
      state.lastBar = { time: key, open: p, high: p, low: p, close: p, volume: 0 };
      state.bars.set(String(key), state.lastBar);
      state.candles.update({ ...state.lastBar });
      state.volume.update({ time: key, value: 0, color: state.colors.up + "4d" });
    } else {
      state.lastBar = { ...state.lastBar, close: p, high: Math.max(state.lastBar.high, p), low: Math.min(state.lastBar.low, p) };
      state.bars.set(String(state.lastBar.time), state.lastBar);
      state.candles.update({ ...state.lastBar });
    }
    if (!state.crosshairActive) renderOhlc(state.lastBar);
  }
  if (msg.mode) setMode(msg.mode);
  if (msg.levels) drawLevels(msg.levels, state.profile);
  if (msg.profile) renderProfile(msg.profile);
  if (msg.alerts && msg.alerts.length) {
    pushAlerts(msg.alerts);
    for (const a of msg.alerts) {
      const px = a.level_price ?? a.price;
      if (px != null) state.pulses.push({ px, t0: Date.now() });
      beep(a.direction && a.direction.includes("baisse") ? 520 : 980, 0.1);
    }
  }

  if (["RITHMIC", "DERIBIT"].includes(state.mode) && (!state.dataStatus?.projection || state.dataStatus.projection.fresh)) checkRules(p);
  else rules.state.clear();
  queueHeroSpark();
  state.tickCount++;
  const src = msg.mode === "RITHMIC" ? "Rithmic" : msg.mode === "DERIBIT" ? "Deribit" : "SIM";
  $("sb-ticks").textContent = `${state.tickCount.toLocaleString()} ticks · ${src} · ${new Date().toLocaleTimeString("fr-FR")}`;
}

function connectWS() {
  closeWS();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sym = state.symbol;          // le socket est lié à CE symbole, pour toujours
  const ws = new WebSocket(`${proto}://${location.host}/ws/${sym}?filter=${state.filter}&win=${state.win}`);
  ws._sym = sym;
  state.ws = ws;
  ws.onopen = () => { state.reconnects = 0; };
  ws.onmessage = (e) => {
    // garde-fou : une trame du symbole précédent ne doit JAMAIS toucher le
    // symbole courant (sinon la barre active prend le prix de l'autre
    // instrument et l'échelle de prix couvre les deux).
    if (ws._sym !== state.symbol || ws !== state.ws) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.symbol && msg.symbol !== state.symbol) return;
    if (msg.type === "init") {
      if (msg.data_status) renderDataStatus(msg.data_status);
      setMode(msg.mode);
      if (msg.price) { $("live-price").textContent = fmtPrice(msg.price); state.prevPrice = msg.price; }
      if (msg.levels) drawLevels(msg.levels, state.profile);
    } else if (msg.type === "tick") onTick(msg);
  };
  ws.onclose = (event) => {
    if (state.ws !== ws) return;
    if(event.code===4401) window.gexRequireAccess?.();
    setMode("STALE");
    const delay = Math.min(15000, 1000 * 2 ** state.reconnects++);
    state.wsTimer = setTimeout(connectWS, delay);
  };
  ws.onerror = () => {};
}

/** Ferme le socket courant sans armer de reconnexion (changement de symbole). */
function closeWS() {
  clearTimeout(state.wsTimer);
  state.wsTimer = null;
  const ws = state.ws;
  state.ws = null;
  if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch {} }
}

/* ---------------- basis (futures) ---------------- */
async function loadBasis() {
  if (!FUTURES.has(state.symbol)) return;
  try {
    const r = await fetch(`/api/basis/${state.symbol}`);
    const j = await r.json();
    if (!j.available || !j.series || !j.series.length) return;
    const isRatio = j.kind === "ratio";
    $("basis-title").textContent = isRatio ? `Ratio ${j.symbol}/${j.src}` : `Basis ${j.symbol}−${j.src}`;
    $("basis-kind").textContent = isRatio ? "MULTIPLICATIF" : "ADDITIF · 5M/5J";
    $("basis-value").textContent = isRatio ? "×" + j.current.toFixed(3) : (j.current >= 0 ? "+" : "−") + Math.abs(j.current).toFixed(2) + " pts";
    const d = j.series[j.series.length - 1].v - j.series[0].v;
    $("basis-delta").textContent = `5 j : ${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(isRatio ? 3 : 2)}`;
    $("basis-delta").className = "mono " + (d >= 0 ? "green" : "red");
    $("basis-spark").innerHTML = sparkSVG(j.series.map((p) => p.v), "#22d3ee");
    $("basis-foot").innerHTML = `<span>min ${fmtV(j.min, isRatio)}</span><span>${j.series.length} échantillons · 5 jours</span><span>max ${fmtV(j.max, isRatio)}</span>`;
  } catch { /* silencieux */ }
}
function fmtV(v, ratio) { return v == null ? "—" : (ratio ? "×" + v.toFixed(3) : (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2)); }

function sparkSVG(vals, color) {
  if (!vals.length) return "";
  const gid = "sg" + (sparkSVG._n = (sparkSVG._n || 0) + 1);
  const W = 320, H = 58, P = 4;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const rng = (mx - mn) || Math.abs(mx) * 0.001 || 1;
  const x = (i) => P + (i / (vals.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - mn) / rng) * (H - 2 * P);
  let d = `M ${x(0)} ${y(vals[0])}`;
  for (let i = 1; i < vals.length; i++) d += ` L ${x(i)} ${y(vals[i])}`;
  const area = `${d} L ${x(vals.length - 1)} ${H} L ${x(0)} ${H} Z`;
  const last = vals[vals.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".28"/>
      <stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${x(vals.length - 1)}" cy="${y(last)}" r="2.6" fill="${color}"/>
  </svg>`;
}

/* ---------------- carnet d'ordres L2 (Rithmic) ---------------- */
let domPoll = null;
function startDomPoll() {
  stopDomPoll();
  if (!FUTURES.has(state.symbol)) return;
  const poll = async () => {
    try {
      const r = await fetch(`/api/depth/${state.symbol}`);
      const j = await r.json();
      renderDom(j);
    } catch { /* silencieux */ }
  };
  poll();
  domPoll = setInterval(poll, 2000);
}
function stopDomPoll() { if (domPoll) { clearInterval(domPoll); domPoll = null; } }

function renderDom(j) {
  const ladder = $("dom-ladder"), ph = $("dom-placeholder"), badge = $("dom-badge");
  if (!j || !j.available) {
    ladder.innerHTML = ""; ladder.hidden = true; ph.hidden = false;
    badge.textContent = "HORS LIGNE"; badge.className = "badge off";
    $("dom-contract").textContent = "";
    return;
  }
  ladder.hidden = false; ph.hidden = true;
  badge.textContent = "L2 LIVE"; badge.className = "badge live";
  $("dom-contract").textContent = `${j.contract} · ${j.exchange}`;
  const asks = j.asks.slice(0, 9).reverse();   // haut = plus cher
  const bids = j.bids.slice(0, 9);
  const maxQ = Math.max(...asks.map((a) => a[1]), ...bids.map((b) => b[1]), 1);
  const rows = [];
  asks.forEach((a, i) => rows.push(domRow("ask", a, maxQ, i === 0)));
  const bestBid = j.bids[0] ? j.bids[0][0] : null, bestAsk = j.asks[0] ? j.asks[0][0] : null;
  const spread = bestBid != null && bestAsk != null ? (bestAsk - bestBid).toFixed(2) : "—";
  rows.push(`<div class="dom-spread"><span>${j.last_price != null ? j.last_price.toFixed(2) : "—"}</span><span class="muted">spread ${spread}</span></div>`);
  bids.forEach((b, i) => rows.push(domRow("bid", b, maxQ, i === 0)));
  ladder.innerHTML = rows.join("");
}
function domRow(side, lvl, maxQ, best) {
  const w = Math.max(3, Math.round((lvl[1] / maxQ) * 100));
  return `<div class="dom-row ${side}${best ? " best" : ""}">` +
    `<span class="p">${lvl[0].toFixed(2)}</span>` +
    `<span class="barq" style="width:${w}%"></span>` +
    `<span class="q">${Math.round(lvl[1])}</span></div>`;
}

/* ---------------- flux d'ordres (gros trades / absorption / delta) ---------------- */
let flowPoll = null, flowAbsSeq = 0, flowBigSeq = 0, flowSrc = "perp";
function startFlowPoll() {
  stopFlowPoll();
  flowAbsSeq = 0;   // pas de toast sur l'historique au changement d'onglet
  flowBigSeq = 0;
  const poll = async () => {
    try {
      const q = CRYPTO.has(state.symbol) && flowSrc !== "perp" ? `?src=${flowSrc}` : "";
      const r = await fetch(`/api/flow/${state.symbol}${q}`);
      renderFlow(await r.json());
    } catch { /* silencieux */ }
  };
  poll();
  flowPoll = setInterval(poll, 2500);
}
function stopFlowPoll() { if (flowPoll) { clearInterval(flowPoll); flowPoll = null; } }
function setFlowSrc(src) {
  flowSrc = src;
  $("flow-src").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.src === src));
  startFlowPoll();
  loadFlowBars();
}

const fmtQty = (v) => v == null ? "—" : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + "K" : String(Math.round(v));
const fmtFlowPx = (v) => v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// tailles crypto : notionnel USD (perp) ou prime payée (options)
const fmtUsd = (v) => v == null ? "—"
  : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + " M$"
  : Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + " k$"
  : Math.round(v) + " $";
const shortInst = (n) => {
  const m = /^(?:BTC-)?(\d+[A-Z]+\d+)-(\d+)-([CP])$/.exec(n || "");
  return m ? `${m[1]} ${m[2]}${m[3]}` : (n || "");
};

function renderFlow(j) {
  $("fl-abs-label").textContent = j?.kind === "options" || j?.src === "options" ? "ACTIVITÉ OPTIONS / INDEX STABLE" : "ABSORPTION ESTIMÉE";
  const badge = $("flow-state"), contract = $("flow-contract"), note = $("fl-note");
  if (!badge) return;
  const crypto = CRYPTO.has(state.symbol);
  const sources = (j && j.sources) || [];
  $("flow-src").hidden = sources.length < 2;
  const opts = crypto && flowSrc === "options";
  const usd = !!(j && j.unit === "USD");
  const fmt = usd ? fmtUsd : fmtQty;
  const title = $("flow-title");
  if (title) title.textContent = crypto
    ? (opts ? "Flux d'ordres · options BTC (Deribit)" : "Flux d'ordres · perp BTC (Deribit)")
    : "Flux d'ordres · tape Rithmic";
  $("fl-lab-delta").textContent = usd
    ? (opts ? "DELTA PRIME AGRESSIF · SÉANCE" : "DELTA AGRESSIF · NOTIONNEL USD")
    : "DELTA AGRESSIF · SÉANCE";
  $("fl-lab-vol").textContent = usd ? (opts ? "PRIME PAYÉE" : "VOLUME NOTIONNEL") : "VOLUME";
  $("fl-lab-thr").textContent = opts ? "SEUIL GROS PRINT" : "SEUIL GROS TRADE";
  if (!j || !j.available) {
    badge.textContent = "HORS LIGNE"; badge.className = "badge off";
    contract.hidden = true;
    for (const id of ["fl-delta", "fl-delta-sub", "fl-vol", "fl-trades", "fl-thr", "fl-med", "fl-big-n", "fl-abs-n"]) $(id).textContent = "";
    $("fl-delta").textContent = "—"; $("fl-vol").textContent = "—"; $("fl-thr").textContent = "—";
    $("fl-big").innerHTML = ""; $("fl-absorb").innerHTML = "";
    note.textContent = (j && j.reason) || "";
    return;
  }
  note.textContent = j.live ? (opts ? "Primes agrégées sur plusieurs contrats et index stable : ne prouve pas une absorption de carnet." : "") : (crypto
    ? "Flux Deribit interrompu — dernière image reçue."
    : "Connexion Rithmic interrompue — dernières données reçues.");
  badge.textContent = j.live ? "LIVE" : "FIGÉ";
  badge.className = "badge " + (j.live ? "live" : "off");
  contract.hidden = false;
  contract.textContent = `${j.contract} · ${j.exchange}`;
  const d = j.delta || 0;
  $("fl-delta").textContent = (d >= 0 ? "+" : "−") + fmt(Math.abs(d));
  $("fl-delta").className = "tile-value " + (d >= 0 ? "green" : "red");
  $("fl-delta-sub").textContent = `achats ${fmt(j.buy_vol)} · ventes ${fmt(j.sell_vol)}`;
  $("fl-vol").textContent = fmt(j.volume);
  $("fl-trades").textContent = `${(j.trades || 0).toLocaleString("fr-FR")} prints`;
  $("fl-thr").textContent = fmt(j.big_threshold);
  $("fl-med").textContent = `médiane ${usd ? fmtUsd(j.median_size) : j.median_size} · fenêtre ${j.window_s}s`;

  const big = (j.big || []).slice().reverse();
  $("fl-big-n").textContent = big.length ? String(big.length) : "";
  $("fl-big").innerHTML = big.length ? big.map((b) => {
    const t = new Date(b.ts * 1000).toLocaleTimeString("fr-FR", { hour12: false });
    const lab = b.side === "buy" ? "ACHAT" : b.side === "sell" ? "VENTE" : "—";
    const inst = b.instrument ? shortInst(b.instrument) : "";
    return `<div class="fl-row ${b.side || "na"}${inst ? " opts" : ""}" title="${fmtFlowPx(b.price)}">` +
      `<span class="t">${t}</span><span class="p">${inst || fmtFlowPx(b.price)}</span>` +
      `<span class="s">${fmt(b.size)}</span><span class="k">${lab}</span></div>`;
  }).join("") : '<div class="fl-empty muted">Aucun print au-dessus du seuil pour l\'instant.</div>';

  const abs = (j.absorb || []).slice().reverse();
  $("fl-abs-n").textContent = abs.length ? String(abs.length) : "";
  $("fl-absorb").innerHTML = abs.length ? abs.map((a) => {
    const t = new Date(a.ts * 1000).toLocaleTimeString("fr-FR", { hour12: false });
    const lab = opts ? (a.side === "buy" ? "PRIMES ACHAT / INDEX STABLE" : "PRIMES VENTE / INDEX STABLE") : a.side === "buy" ? "ACHATS ABSORBÉS (EST.)" : "VENTES ABSORBÉES (EST.)";
    const inst = a.instrument ? shortInst(a.instrument) : "";
    return `<div class="fl-row ${a.side}${inst ? " opts" : ""}" title="${fmtFlowPx(a.price)}">` +
      `<span class="t">${t}</span><span class="p">${inst || fmtFlowPx(a.price)}</span>` +
      `<span class="s">${fmt(a.volume)}</span><span class="k">${lab}</span></div>`;
  }).join("") : '<div class="fl-empty muted">Rien pour l\'instant — volume agressif concentré sans mouvement de prix.</div>';

  // toasts sur les nouveaux gros prints (pas sur l'historique initial)
  const bigMax = big.length ? Math.max(...big.map((b) => b.seq)) : 0;
  if (flowBigSeq && bigMax > flowBigSeq) {
    for (const b of big.filter((x) => x.seq > flowBigSeq).sort((x, y) => x.seq - y.seq)) {
      const inst = b.instrument && opts ? " " + shortInst(b.instrument) : "";
      toast(`Gros print ${b.side === "buy" ? "ACHAT" : b.side === "sell" ? "VENTE" : "—"}${inst} @ ${fmtFlowPx(b.price)} — ${fmt(b.size)}`,
            b.side === "buy" ? "var(--green)" : "var(--red)", 7000);
    }
  }
  flowBigSeq = Math.max(flowBigSeq, bigMax);

  // toasts sur les nouvelles absorptions (pas sur l'historique initial)
  const maxSeq = abs.length ? Math.max(...abs.map((a) => a.seq)) : 0;
  if (flowAbsSeq && maxSeq > flowAbsSeq) {
    for (const a of abs.filter((x) => x.seq > flowAbsSeq).sort((x, y) => x.seq - y.seq)) {
      toast(`${opts ? "Activité options / index stable" : "Absorption estimée"} ${a.side === "buy" ? "des achats" : "des ventes"}${a.instrument ? " " + shortInst(a.instrument) : ""} @ ${fmtFlowPx(a.price)} — ${fmt(a.volume)}${usd ? "" : " contrats"} (${a.window_s}s)`, a.side === "buy" ? "var(--red)" : "var(--green)", 8000);
    }
  }
  flowAbsSeq = Math.max(flowAbsSeq, maxSeq);

  // bulles sur le chart (gros trades + absorptions)
  state.flowBig = (j.big || []).slice(-160);
  state.flowAbsorb = (j.absorb || []).slice(-80);
  state.flowUnit = j.unit || null;
  state.flowUsd = usd;
  queueFlow();
}

/* -------- bulles gros trades / absorptions sur le prix (style Deepchart) --------
 * v2 : les prints sont **agrégés par cellule temps×prix** pour rester lisibles en
 * session active — une cellule = une bulle, avec le total et un badge ×N. Les
 * absorptions ne multiplient plus les anneaux : elles marquent la cellule.
 */
const FLOW_COL = { buy: "#2dd4a7", sell: "#f0616d", mixed: "#93a1b5", abs: "#a78bfa" };
const FLOW_RADIUS = [7, 11, 16, 22];      // 4 classes : r = classe de la cellule
const FLOW_MAX_BUBBLES = 40;
function setBubbles(on) {
  state.bubbles = on;
  localStorage.setItem("gex.bubbles", on ? "1" : "0");
  const b = $("draw-bubbles");
  if (b) { b.classList.toggle("active", on); b.classList.toggle("off", !on); }
  const lg = $("flow-legend");
  if (lg) lg.hidden = !on;
  queueFlow();
}
function queueFlow() { if (state.flowQueued) return; state.flowQueued = true; requestAnimationFrame(() => { state.flowQueued = false; flowRender(); drawDeltaBand(); }); }

// temps -> x : timeToCoordinate, sinon la bougie la plus proche (l'événement peut
// tomber entre deux bougies ou hors du jeu de données affiché)
function flowX(ts) {
  const t = state.chart?.timeScale();
  if (!t) return null;
  const x = t.timeToCoordinate(ts);
  if (x != null) return x;
  const times = [...state.bars.keys()].map(Number).sort((a, b) => a - b);
  if (!times.length) return null;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < ts) lo = m + 1; else hi = m; }
  const best = [times[lo], times[Math.max(0, lo - 1)]].sort((a, b) => Math.abs(a - ts) - Math.abs(b - ts))[0];
  return t.timeToCoordinate(best);
}
/** Rayon d'une bulle pour une taille donnée, en 4 classes discrètes (lisibilité). */
function flowRadius(v, max) {
  const k = v / (max || 1);
  if (k >= 0.55) return FLOW_RADIUS[3];
  if (k >= 0.16) return FLOW_RADIUS[2];
  if (k >= 0.045) return FLOW_RADIUS[1];
  return FLOW_RADIUS[0];
}

/**
 * Cellules gros prints / absorptions.
 *
 * Maillage fin (temps × prix) dimensionné sur l'écran : les cellules d'une même
 * colonne sont ensuite **réparties en éventail vertical**, chacune reliée à son
 * vrai prix par un fin trait de rappel — c'est la seule façon de garder le prix
 * exact ET de rendre lisible une salve de prints au même endroit.
 */
function flowClusters() {
  const c = state.candles, ts = state.chart && state.chart.timeScale();
  if (!c || !ts) return { cells: [], max: 1, classes: [0, 0, 0] };
  const bs = ts.options().barSpacing || 4;
  const barSecs = state.barsDaily ? 86400 : (PERIOD[state.interval] || 300);
  const quantum = Math.max(barSecs, barSecs * Math.round(26 / bs));   // ≥ 26 px entre colonnes
  const y0 = c.coordinateToPrice(0), y1 = c.coordinateToPrice(1);
  const perPx = (y0 != null && y1 != null) ? Math.abs(y0 - y1) : 0;
  const rowStep = perPx > 0 ? perPx * 26 : 0;                          // ~26 px par rangée
  const map = new Map();
  const grab = (tsSec, price) => {
    const tb = Math.floor(tsSec / quantum) * quantum;
    const pb = rowStep > 0 ? Math.round(price / rowStep) : 0;
    const key = tb + "|" + pb;
    let cu = map.get(key);
    if (!cu) {
      cu = { key, t: tb, size: 0, buy: 0, sell: 0, n: 0, absN: 0, absBuy: 0, absSell: 0,
             pMin: price, pMax: price, ts: tsSec, lastTs: tsSec, vw: 0 };
      map.set(key, cu);
    }
    return cu;
  };
  for (const b of state.flowBig) {
    const cu = grab(b.ts, b.price);
    cu.size += b.size; cu.n += 1; cu.vw += b.price * b.size;
    if (b.side === "buy") cu.buy += b.size; else cu.sell += b.size;
    cu.pMin = Math.min(cu.pMin, b.price); cu.pMax = Math.max(cu.pMax, b.price);
    cu.ts = Math.min(cu.ts, b.ts); cu.lastTs = Math.max(cu.lastTs, b.ts);
  }
  for (const a of state.flowAbsorb) {
    const cu = grab(a.ts, a.price);
    cu.absN += 1;
    if (a.side === "buy") cu.absBuy += a.volume; else cu.absSell += a.volume;
    cu.size += a.volume * 0.25;              // pèse dans la taille sans écraser
    cu.vw += a.price * a.volume * 0.25;
    cu.pMin = Math.min(cu.pMin, a.price); cu.pMax = Math.max(cu.pMax, a.price);
    cu.ts = Math.min(cu.ts, a.ts); cu.lastTs = Math.max(cu.lastTs, a.ts);
  }
  const cells = [...map.values()];
  if (!cells.length) return { cells: [], max: 1, classes: [0, 0, 0] };
  const max = Math.max(...cells.map((x) => x.size));
  const classes = [max * 0.55, max * 0.16, max * 0.045];

  // placement : x = centre de la colonne, y true = prix moyen pondéré
  const W = document.getElementById("flow-canvas").clientWidth;
  const H = document.getElementById("flow-canvas").clientHeight;
  const visible = [];
  for (const cu of cells) {
    cu.p = cu.size > 0 ? cu.vw / cu.size : cu.pMin;
    const x0 = flowX(cu.t + quantum / 2);
    const y = c.priceToCoordinate(cu.p);
    if (x0 == null || y == null || x0 < -20 || x0 > W + 20 || y < -20 || y > H + 20) continue;
    cu.x = x0; cu.yTrue = y; cu.y = y; cu.r = flowRadius(cu.size, max);
    cu.side = cu.buy >= cu.sell * 1.6 ? "buy" : cu.sell >= cu.buy * 1.6 ? "sell" : "mixed";
    visible.push(cu);
  }
  // éventail : dans une même colonne (x à ±20 px), on écarte les bulles en y
  visible.sort((a, b) => a.x - b.x || a.yTrue - b.yTrue);
  for (let i = 0; i < visible.length;) {
    let j = i + 1;
    while (j < visible.length && visible[j].x - visible[i].x <= 20) j++;
    const col = visible.slice(i, j);
    if (col.length > 1) {
      const step = 2 * Math.max(...col.map((k) => k.r)) + 4;
      const mid = col.reduce((s, k) => s + k.yTrue, 0) / col.length;
      const total = (col.length - 1) / 2;
      for (let k = 0; k < col.length; k++) {
        col[k].y = mid + (k - total) * step * 0.62;
        col[k].fanned = Math.abs(col[k].y - col[k].yTrue) > 2;
      }
      // on serre l'éventail pour rester dans le cadre
      const lo = Math.min(...col.map((k) => k.y - k.r)), hi = Math.max(...col.map((k) => k.y + k.r));
      if (lo < 4) { const d = 4 - lo; col.forEach((k) => { k.y += d; }); }
      if (hi > H - 4) { const d = hi - (H - 4); col.forEach((k) => { k.y -= d; }); }
    }
    i = j;
  }
  const kept = visible.sort((a, b) => b.size - a.size).slice(0, FLOW_MAX_BUBBLES).sort((a, b) => a.size - b.size);
  return { cells: kept, max, classes };
}

function flowRender() {
  const cv = $("flow-canvas");
  if (!cv || !state.chart || !state.candles) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  state.flowHits = [];
  if (!state.bubbles) return;
  const plotR = W - (state.chart.priceScale("right").width() || 0);
  const now = Date.now() / 1000;
  const usd = state.flowUsd;
  const amount = (v) => usd ? fmtUsd(v) : fmtQty(v);
  const { cells, max, classes } = flowClusters();
  let recent = false;

  for (const cu of cells) {
    const x = cu.x, y = cu.y;
    if (x < 0 || x > plotR || y < 0 || y > H) continue;
    const r = cu.r;
    const fade = Math.max(0.42, 1 - Math.max(0, now - cu.lastTs) / 5400);
    const col = FLOW_COL[cu.side] || FLOW_COL.mixed;
    if (now - cu.lastTs < 5) recent = true;

    // halo bref sur une cellule fraîche (≈1 s de pulsation, sans boucle infinie)
    if (now - cu.lastTs < 5) {
      const k = 1 - ((now - cu.lastTs) % 1.2) / 1.2;
      ctx.globalAlpha = 0.30 * k * fade;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, r + 4 + 10 * (1 - k), 0, Math.PI * 2); ctx.fill();
    }

    // trait de rappel : la bulle a été écartée pour la lisibilité, le prix réel reste tracé
    if (cu.fanned) {
      ctx.globalAlpha = 0.5 * fade;
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(x + r + 2, y); ctx.lineTo(x + r + 2, cu.yTrue); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(cu.x + 0.5, cu.yTrue, 1.4, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
    }
    ctx.globalAlpha = 0.82 * fade;
    const g = ctx.createRadialGradient(x - r * 0.32, y - r * 0.32, r * 0.12, x, y, r);
    g.addColorStop(0, col); g.addColorStop(1, col + "55");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = fade;
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(6,9,14,.85)"; ctx.stroke();

    if (r >= 12 && cu.n > 0) {
      ctx.fillStyle = "#06121a";
      ctx.font = `700 ${r >= 20 ? 10 : 8.5}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(amount(cu.size), x, y + 0.5);
    }

    // absorption : anneau violet (état de marché distinct du sens du tape)
    if (cu.absN) {
      const ar = r + 3.5;
      ctx.globalAlpha = 0.95 * fade;
      ctx.strokeStyle = FLOW_COL.abs; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(x, y, ar, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = FLOW_COL.abs;
      ctx.beginPath(); ctx.arc(x, y - ar, 2.6, 0, Math.PI * 2); ctx.fill();
    }

    // badge ×N : plusieurs prints dans la même cellule
    if (cu.n > 1) {
      const bx = x + r * 0.72, by = y - r * 0.72;
      const txt = "×" + (cu.n + cu.absN > 99 ? "99" : cu.n);
      ctx.font = "700 8.5px 'JetBrains Mono', monospace";
      const bw = ctx.measureText(txt).width + 7;
      ctx.globalAlpha = 0.92 * fade;
      ctx.fillStyle = "rgba(9,13,20,.92)";
      ctx.beginPath(); ctx.roundRect(bx - bw / 2, by - 7, bw, 14, 7); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = col; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(txt, bx, by + 0.5);
    }
    state.flowHits.push({ x, y, r: r + (cu.absN ? 4 : 1), cell: cu });
  }
  ctx.globalAlpha = 1;

  // légende des classes (seuils calculés sur la vue courante)
  const lg = $("flow-legend");
  if (lg && !lg.hidden) {
    const cls = [[FLOW_RADIUS[3], max], [FLOW_RADIUS[2], classes[0]], [FLOW_RADIUS[1], classes[1]]];
    lg.innerHTML = cls.map(([r, v]) =>
      `<span><i style="width:${r}px;height:${r}px"></i>≥&nbsp;${usd ? fmtUsd(v) : fmtQty(v)}</span>`).join("") +
      `<span><i class="abs"></i>${CRYPTO.has(state.symbol) && flowSrc === "options" ? "activité options / index stable" : "absorption estimée"}</span><span class="xl">×N&nbsp;prints</span>`;
  }
  // une cellule fraîche doit continuer à pulser : on se réarme brièvement
  if (recent) setTimeout(queueFlow, 260);
}

// infobulle au survol : le canvas de bulles est en pointer-events:none, on écoute donc le conteneur et on teste les cercles dessinés
(function flowTooltip() {
  const area = $("chart-area"), tip = $("flow-tip");
  if (!area || !tip) return;
  area.addEventListener("mousemove", (e) => {
    if (!state.bubbles || !state.flowHits.length) { tip.hidden = true; return; }
    const r = area.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let hit = null;
    for (let i = state.flowHits.length - 1; i >= 0; i--) {
      const h = state.flowHits[i];
      if (Math.hypot(h.x - x, h.y - y) <= h.r + 2) { hit = h; break; }
    }
    if (!hit) { tip.hidden = true; return; }
    const cu = hit.cell;
    const usd = state.flowUsd;
    const amt = (v) => usd ? fmtUsd(v) : fmtQty(v) + " contrats";
    const t1 = new Date(cu.ts * 1000).toLocaleTimeString("fr-FR", { hour12: false });
    const t2 = new Date(cu.lastTs * 1000).toLocaleTimeString("fr-FR", { hour12: false });
    const total = cu.buy + cu.sell;
    const col = FLOW_COL[cu.side] || "#fff";
    const head = cu.side === "mixed" ? "ACHATS / VENTES" : cu.side === "buy" ? "DOMINANTE ACHAT" : "DOMINANTE VENTE";
    const range = cu.pMin === cu.pMax ? fmtFlowPx(cu.p) : `${fmtFlowPx(cu.pMin)} – ${fmtFlowPx(cu.pMax)}`;
    let html = `<b style="color:${col}">${cu.n > 1 ? cu.n + " GROS PRINTS" : "GROS PRINT"} · ${head}</b><br>` +
      `${amt(cu.size - (cu.absBuy + cu.absSell) * 0.25)}` +
      (total ? ` · achats ${amt(cu.buy)} / ventes ${amt(cu.sell)}` : "") + `<br>${range} · ${t1}${cu.n > 1 || cu.absN ? "–" + t2 : ""}`;
    if (cu.absN) {
      const lbl = cu.absBuy >= cu.absSell ? "ACHATS ABSORBÉS" : "VENTES ABSORBÉES";
      html += `<br><b style="color:${FLOW_COL.abs}">◌ ${lbl}</b> ${amt(Math.max(cu.absBuy, cu.absSell))}` +
              (cu.absN > 1 ? ` ×${cu.absN}` : "");
    }
    tip.innerHTML = html;
    tip.style.left = Math.min(hit.x + 12, area.clientWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = Math.max(4, hit.y - tip.offsetHeight - 10) + "px";
    tip.hidden = false;
  });
  area.addEventListener("mouseleave", () => { tip.hidden = true; });
})();
$("draw-bubbles").addEventListener("click", () => setBubbles(!state.bubbles));
setBubbles(state.bubbles);

/* ---------------- bande delta / CVD sous le chart ---------------- */
let flowBarsPoll = null, flowBarsSeq = 0;
async function loadFlowBars() {
  const iv = state.interval, seq = ++flowBarsSeq;
  const q = CRYPTO.has(state.symbol) && flowSrc !== "perp" ? `&src=${flowSrc}` : "";
  try {
    const r = await fetch(`/api/flow/${state.symbol}/bars?interval=${iv}&limit=300${q}`);
    const j = await r.json();
    if (seq !== flowBarsSeq) return;
    state.flowBars = j.bars || [];
    state.flowBarsUnit = j.unit || "contrats";
    queueFlow();
  } catch { /* tape indisponible : la bande reste vide */ }
}
function startFlowBarsPoll() { stopFlowBarsPoll(); loadFlowBars(); flowBarsPoll = setInterval(loadFlowBars, 15000); }
function stopFlowBarsPoll() { if (flowBarsPoll) { clearInterval(flowBarsPoll); flowBarsPoll = null; } }

function drawDeltaBand() {
  const cv = $("delta-canvas"), lg = $("delta-legend");
  if (!cv || !state.chart || !state.candles) return;
  const bars0 = (state.flowBars || []).filter((b) => b && b.t != null);
  // pas de tape : la bande disparaît (le panneau FLUX explique l'absence)
  if (!bars0.length) { cv.hidden = true; if (lg) lg.hidden = true; return; }
  cv.hidden = false;
  if (lg) lg.hidden = false;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const tsH = typeof state.chart.timeScale().height === "function" ? state.chart.timeScale().height() : 26;
  cv.style.bottom = tsH + "px";
  if (lg) lg.style.bottom = tsH + H + 6 + "px";
  const plotR = W - (state.chart.priceScale("right").width() || 0);
  if (plotR < 80) return;

  ctx.fillStyle = "rgba(8,11,18,.62)";
  ctx.fillRect(0, 0, plotR, H);
  ctx.strokeStyle = "rgba(26,34,51,.95)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, .5); ctx.lineTo(plotR, .5); ctx.stroke();

  const bars = bars0;
  const unit = state.flowBarsUnit === "USD" ? "$" : "ct";
  if (lg) lg.innerHTML =
    `<b>Δ / CVD · ${state.interval.toUpperCase()}</b>` +
    `<span><i class="lg-dot" style="background:${state.colors.up}"></i>achats</span>` +
    `<span><i class="lg-dot" style="background:${state.colors.down}"></i>ventes</span>` +
    `<span><i class="lg-dot" style="background:#4f8ef7"></i>CVD</span>`;

  const xOf = (t) => {
    let x = state.chart.timeScale().timeToCoordinate(t);
    if (x == null) x = state.chart.timeScale().timeToCoordinate(new Date(t * 1000).toISOString().slice(0, 10));
    return x;
  };
  const xs = bars.map((b) => xOf(b.t));
  // largeur d'une bougie à l'écran (médiane des écarts positifs)
  const dx = [];
  for (let i = 1; i < xs.length; i++) if (xs[i] != null && xs[i - 1] != null && xs[i] > xs[i - 1]) dx.push(xs[i] - xs[i - 1]);
  dx.sort((a, b) => a - b);
  const bw = Math.max(2, Math.min(30, dx.length ? dx[Math.floor(dx.length / 2)] : 6));

  const top = 8, bot = H - 8, mid = (top + bot) / 2;
  let maxD = 1;
  for (const b of bars) maxD = Math.max(maxD, Math.abs(b.delta || 0));

  // ligne zéro
  ctx.strokeStyle = "rgba(255,255,255,.13)"; ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(0, mid + .5); ctx.lineTo(plotR, mid + .5); ctx.stroke();
  ctx.setLineDash([]);

  // histogramme de delta agressif
  const half = (bot - top) * 0.42;
  for (let i = 0; i < bars.length; i++) {
    const x = xs[i];
    if (x == null || x < -bw || x > plotR + bw) continue;
    const d = bars[i].delta || 0;
    const h = (Math.abs(d) / maxD) * half;
    if (h < 0.6) continue;
    ctx.fillStyle = d >= 0 ? hexA(state.colors.up, .62) : hexA(state.colors.down, .62);
    ctx.fillRect(x - bw / 2 + 0.4, d >= 0 ? mid - h : mid, Math.max(1, bw - 0.8), h);
  }

  // CVD cumulé (recalé sur la fenêtre retournée par le serveur)
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { lo = Math.min(lo, b.cvd ?? 0); hi = Math.max(hi, b.cvd ?? 0); }
  if (!isFinite(lo)) { lo = -1; hi = 1; }
  const span = hi - lo;
  const yC = (v) => (span < 1e-9 ? mid : bot - ((v - lo) / span) * (bot - top));
  ctx.beginPath();
  let started = false, lastX = null, lastY = null;
  for (let i = 0; i < bars.length; i++) {
    const x = xs[i];
    if (x == null) { started = false; continue; }
    const y = yC(bars[i].cvd ?? 0);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    lastX = x; lastY = y;
  }
  ctx.strokeStyle = "rgba(79,142,247,.95)"; ctx.lineWidth = 1.4; ctx.stroke();
  // valeur courante
  if (lastX != null && lastY != null) {
    ctx.fillStyle = "rgba(79,142,247,1)";
    ctx.beginPath(); ctx.arc(lastX, lastY, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  const last = bars[bars.length - 1];
  const sgn = (v) => (v >= 0 ? "+" : "−") + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + "k" : Math.round(Math.abs(v)));
  if (lg) lg.insertAdjacentHTML("beforeend",
    `<span>Δ ${sgn(last.delta || 0)}${unit} · CVD <b>${sgn(last.cvd || 0)}${unit}</b> · ${bars.length} b.</span>`);
  // bornes de l'échelle CVD
  ctx.font = "700 8px 'JetBrains Mono', monospace";
  ctx.fillStyle = "rgba(139,147,167,.65)"; ctx.textAlign = "right";
  ctx.fillText(sgn(hi) + unit, plotR - 6, top + 7);
  ctx.fillText(sgn(lo) + unit, plotR - 6, bot - 1);
  ctx.textAlign = "left";
}

/* ---------------- alertes de franchissement ---------------- */
async function loadAlerts() {
  try {
    const r = await fetch(`/api/alerts/${state.symbol}`);
    const j = await r.json();
    $("alerts-list").innerHTML = "";
    (j.alerts || []).reverse().forEach((a) => addAlertRow(a, false));
    if (!j.alerts || !j.alerts.length) alertsEmpty();
    updateAlertCount();
  } catch { /* silencieux */ }
}
function alertsEmpty() {
  $("alerts-list").innerHTML = '<div class="alerts-empty muted">Aucun franchissement pour l\'instant — les passages de zero-GEX / call wall / put wall apparaîtront ici en direct.</div>';
}
function addAlertRow(a, fresh) {
  const list = $("alerts-list");
  const empty = list.querySelector(".alerts-empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "alert-row " + a.level + (fresh ? " fresh" : "");
  const t = new Date(a.ts * 1000).toLocaleTimeString("fr-FR", { hour12: false });
  row.innerHTML = `<span class="t">${t}</span><span class="m">${a.text}</span>`;
  list.prepend(row);
  while (list.children.length > 30) list.lastChild.remove();
  if (fresh) setTimeout(() => row.classList.remove("fresh"), 2500);
  updateAlertCount();
}
function updateAlertCount() {
  const n = $("alerts-list").querySelectorAll(".alert-row").length;
  $("alerts-count").textContent = n;
}
function pushAlerts(alerts) {
  for (const a of alerts) {
    addAlertRow(a, true);
    const col = a.level === "zero_gex" ? "var(--yellow)" : (a.level === "call_wall" ? "var(--green)" : "var(--red)");
    toast(a.text, col, 7000);
  }
}

/* ---------------- heatmap GEX ---------------- */
const hm = { open: false, mode: "session", iv: "5m", range: 0.05, data: null };

/* ---------------- pane GEX (overlay gamma synchronisé) ---------------- */
const gp = { on: true, queued: false };

$("gp-toggle").addEventListener("click", () => {
  gp.on = !gp.on;
  $("gp-toggle").classList.toggle("active", gp.on);
  $("gex-overlay").style.display = gp.on ? "" : "none";
  if (state.chart) state.chart.timeScale().applyOptions({ rightOffset: gp.on ? 18 : 6 });
  queueGamma();
});

function queueGamma() {
  if (gp.queued) return;
  gp.queued = true;
  requestAnimationFrame(() => { gp.queued = false; drawGamma(); });
}

/* --------- B : strike ladder façon DOM --------- */
function renderLadder() {
  const el = $("ladder");
  if (!el) return;
  const card = $("ladder-card");
  if (card) card.hidden = !state.ladderOn;
  el.hidden = !state.ladderOn;
  const tb = $("ladder-toggle");
  if (tb) tb.classList.toggle("active", state.ladderOn);
  if (!state.ladderOn) return;
  const P = state.profile, L = state.levels || {};
  if (!P || !P.strikes || !P.strikes.length) { el.innerHTML = ""; return; }
  const spot = L.spot ?? P.strikes[Math.floor(P.strikes.length / 2)];
  const H = el.clientHeight || 300;
  const nRows = Math.max(6, Math.floor((H - 20) / 18));
  let i0 = P.strikes.findIndex((k) => k >= spot);
  if (i0 < 0) i0 = P.strikes.length - 1;
  const start = Math.max(0, i0 - Math.floor(nRows / 2));
  const end = Math.min(P.strikes.length, start + nRows);
  let maxNet = 1;
  for (let i = start; i < end; i++) maxNet = Math.max(maxNet, Math.abs(P.net_gex[i]));
  const W = L.walls || { call: [], put: [] };
  const cwr = new Map(W.call.map((e, i) => [e.strike, i]));
  const pwr = new Map(W.put.map((e, i) => [e.strike, i]));
  const flip = L.gamma_flip ?? L.zero_gex;
  const poc = state.sess ? state.sess.poc : null;
  let html = '<div class="ld-head"><span>PUT OI</span><span>STRIKE</span><span>CALL OI</span></div>';
  for (let i = start; i < end; i++) {
    const k = P.strikes[i], v = P.net_gex[i];
    const w = Math.min(44, Math.pow(Math.abs(v) / maxNet, 0.6) * 44);
    const bar = v >= 0
      ? `background:rgba(45,212,167,.38);width:${w.toFixed(0)}px;`
      : `background:rgba(240,97,109,.38);width:${w.toFixed(0)}px;margin-left:${(-w).toFixed(0)}px;`;
    const ci = cwr.get(k), pi = pwr.get(k);
    const bdg = ci != null ? `<span class="bdg" style="background:var(--green)">C${ci + 1}</span>`
      : pi != null ? `<span class="bdg" style="background:var(--red)">P${pi + 1}</span>` : "";
    const cls = "ld-row" + (flip === k ? " flip" : "") +
      (poc != null && Math.abs(poc - k) < 1e-9 ? " poc" : "") +
      (state.pins.has(k) ? " pinned" : "");
    html += `<div class="${cls}" data-k="${k}"><span class="bar" style="${bar}"></span>` +
      `<span class="poi">${fmtOI(P.put_oi[i])}</span><span class="pk">${fmtPx(k, state.symbol)}</span>` +
      `<span class="coi">${fmtOI(P.call_oi[i])}</span>${bdg}</div>`;
  }
  el.innerHTML = html;
}
$("ladder").addEventListener("click", (e) => {
  const r = e.target.closest(".ld-row");
  if (!r) return;
  togglePin(Number(r.dataset.k));
  renderLadder();
});
$("ladder-toggle").addEventListener("click", () => {
  state.ladderOn = !state.ladderOn;
  localStorage.setItem("gex.ladder", state.ladderOn ? "1" : "0");
  renderLadder();
  queueGamma(); queueDraw();
});

/* --------- C : panneau dérivés (skew 25Δ, terme, OI / max pain) --------- */
const deriv = { data: null, at: 0 };
async function loadDerivs() {
  const tab = $("tab-deriv");
  if (tab) tab.hidden = false;
  // Derivative term/skew data is available for both CBOE and Deribit.
  const sym = state.symbol;
  try {
    const r = await fetch(`/api/derivs/${sym}`);
    const j = await r.json();
    if (sym !== state.symbol) return;          // switch de symbole entre-temps
    deriv.data = j; deriv.at = Date.now();
    renderDerivs(j);
  } catch { renderDerivs(null); }
}
const fmtExpiry = (e) => new Date(e * 1000)
  .toLocaleDateString("fr-FR", { day: "2-digit", month: "short", timeZone: "UTC" })
  .replace(".", "").toUpperCase();

function renderDerivs(j) {
  const rows = (j && j.available && j.expiries) || [];
  const skew = j && j.available ? j.skew_25d : null;
  $("dv-skew").textContent = skew == null ? "—" : (skew >= 0 ? "+" : "−") + Math.abs(skew).toFixed(2) + " pt";
  $("dv-skew").style.color = skew == null ? "var(--faint)" : skew >= 0 ? "var(--red)" : "var(--green)";
  const r0 = rows.find((r) => r.skew_25d != null);
  $("dv-skew-note").textContent = r0
    ? `puts 25Δ ${r0.put_iv_25d?.toFixed(1) ?? "—"} % · calls 25Δ ${r0.call_iv_25d?.toFixed(1) ?? "—"} %`
    : "skew indisponible sur cette chaîne";
  $("dv-atm").textContent = j && j.atm_iv != null ? j.atm_iv.toFixed(1) + " %" : "—";
  $("dv-pc").textContent = j && j.put_call_oi != null ? j.put_call_oi.toFixed(2) : "—";
  $("dv-spot").textContent = j && j.spot != null ? fmtPx(j.spot, state.symbol) : "—";
  $("deriv-src").textContent = CRYPTO.has(state.symbol) ? "DERIBIT" : "CBOE";

  $("dterm-rows").innerHTML = !rows.length
    ? '<div class="alerts-empty muted">Aucune échéance lisible — chaîne indisponible.</div>'
    : '<div class="dt-head"><span>ÉCHÉANCE</span><span>SKEW</span><span>OI C / P</span><span>PAIN</span></div>' +
      rows.map((r) => {
        const sk = r.skew_25d;
        const cls = sk == null ? "muted" : sk >= 0 ? "red" : "green";
        return `<div class="dt-row" title="IV ATM ${(r.atm_iv * 100).toFixed(1)} % · OI ${fmtOI(r.call_oi)} calls / ${fmtOI(r.put_oi)} puts">` +
          `<span class="dd">${fmtExpiry(r.expiry)}<i>${r.dte < 1 ? Math.round(r.dte * 24) + "h" : Math.round(r.dte) + "j"}</i></span>` +
          `<span class="sk ${cls}">${sk == null ? "—" : (sk >= 0 ? "+" : "−") + Math.abs(sk).toFixed(1)}</span>` +
          `<span class="oi">${fmtOI(r.call_oi)} / ${fmtOI(r.put_oi)}</span>` +
          `<span class="mp">${r.max_pain != null ? fmtPx(r.max_pain, state.symbol) : "—"}</span></div>`;
      }).join("");
  $("dv-term-note").textContent = rows.length ? `${rows.length} échéances` : "";
  drawTerm(rows);
}

function drawTerm(rows) {
  const cv = $("dterm-canvas");
  if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pts = rows.filter((r) => r.atm_iv != null).map((r) => ({ x: r.dte, y: r.atm_iv * 100, r }));
  if (pts.length < 2) {
    ctx.fillStyle = "rgba(139,147,167,.5)";
    ctx.font = "700 9px 'JetBrains Mono', monospace";
    ctx.fillText("structure par terme indisponible", 10, H / 2);
    return;
  }
  const pad = { l: 30, r: 10, t: 10, b: 16 };
  const ivs = pts.map((p) => p.y);
  const lo = Math.min(...ivs), hi = Math.max(...ivs);
  const ymin = lo - Math.max(0.5, (hi - lo) * 0.18), ymax = hi + Math.max(0.5, (hi - lo) * 0.18);
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const X = (i) => pad.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const Y = (v) => pad.t + ih - ((v - ymin) / (ymax - ymin)) * ih;
  // grille + labels de vol
  ctx.strokeStyle = "rgba(26,34,51,.85)"; ctx.lineWidth = 1;
  ctx.font = "700 8px 'JetBrains Mono', monospace";
  for (let k = 0; k <= 2; k++) {
    const v = ymin + ((ymax - ymin) * k) / 2, y = Y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, y + .5); ctx.lineTo(W - pad.r, y + .5); ctx.stroke();
    ctx.fillStyle = "rgba(139,147,167,.65)";
    ctx.fillText(v.toFixed(0) + "%", 2, y + 3);
  }
  // aire + courbe
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, "rgba(79,142,247,.30)");
  grad.addColorStop(1, "rgba(79,142,247,0)");
  ctx.beginPath();
  ctx.moveTo(X(0), H - pad.b);
  pts.forEach((p, i) => ctx.lineTo(X(i), Y(p.y)));
  ctx.lineTo(X(pts.length - 1), H - pad.b);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.y)) : ctx.moveTo(X(i), Y(p.y))));
  ctx.strokeStyle = "rgba(79,142,247,.95)"; ctx.lineWidth = 1.6; ctx.stroke();
  pts.forEach((p, i) => {
    ctx.fillStyle = "#0b0e14"; ctx.strokeStyle = "rgba(79,142,247,1)"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(X(i), Y(p.y), 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });
  // labels d'échéance
  ctx.fillStyle = "rgba(139,147,167,.6)"; ctx.font = "700 7.5px 'JetBrains Mono', monospace";
  ctx.textAlign = "center";
  const every = Math.ceil(pts.length / 6);
  pts.forEach((p, i) => { if (i % every === 0 || i === pts.length - 1) ctx.fillText(fmtExpiry(p.r.expiry), X(i), H - 4); });
  ctx.textAlign = "left";
}

/* --------- E : règles d'alerte personnelles --------- */
const RULE_KINDS = { cross: "Franchit", near: "Approche ≤", regime: "Régime γ" };
const RULE_LEVELS = { cw1: "CW1", pw1: "PW1", flip: "FLIP", pain: "MAX PAIN", vwap: "VWAP", price: "Prix fixe" };
const rules = {
  list: storedJSON("gex.rules", []),
  log: storedJSON("gex.rlog", []),
  state: new Map(),        // id -> { last, armed, regime }
};
function saveRules() {
  localStorage.setItem("gex.rules", JSON.stringify(rules.list));
  localStorage.setItem("gex.rlog", JSON.stringify(rules.log.slice(0, 40)));
}
function levelPrice(level) {
  const L = state.levels || {}, W = L.walls || {};
  switch (level) {
    case "cw1": return W.call && W.call[0] ? W.call[0].strike : null;
    case "pw1": return W.put && W.put[0] ? W.put[0].strike : null;
    case "flip": return L.gamma_flip ?? L.zero_gex ?? null;
    case "pain": return L.max_pain ?? null;
    case "vwap": return state.sess ? state.sess.vwapLast : null;
    default: return null;
  }
}
function ruleLabel(r) {
  if (r.kind === "regime") return `Régime γ → ${r.regime === "long_gamma" ? "LONG" : "SHORT"}`;
  const lv = RULE_LEVELS[r.level] || r.level;
  if (r.kind === "near") return `Approche ≤ ${r.bps} bps de ${lv}`;
  return r.level === "price" ? `Franchit ${fmtPrice(r.px)}` : `Franchit ${lv}`;
}
function renderRules() {
  const list = $("rules-list");
  $("rules-count").textContent = rules.list.length;
  list.innerHTML = rules.list.length
    ? rules.list.map((r) => `<div class="rule-row" data-id="${r.id}"><span class="rk">${RULE_KINDS[r.kind] || r.kind}</span>` +
        `<span class="rt">${ruleLabel(r)}</span><button class="rm" title="Supprimer">✕</button></div>`).join("")
    : '<div class="alerts-empty muted">Aucune règle — ex. « franchit FLIP », « approche ≤ 20 bps de CW1 », « régime γ devient SHORT ».</div>';
  const log = $("rules-log");
  log.innerHTML = rules.log.length
    ? rules.log.map((l) => `<div class="rlog-row"><span class="t">${l.t}</span><span class="m">${l.m}</span><span class="p">${l.p}</span></div>`).join("")
    : '<div class="alerts-empty muted">Déclenchements de vos règles — horodatés, avec le prix au moment du signal.</div>';
}
function syncRuleForm() {
  const kind = $("rule-kind").value;
  const isReg = kind === "regime";
  $("rule-level").hidden = isReg;
  $("rule-regime").hidden = !isReg;
  $("rule-x").hidden = isReg || (kind === "cross" && $("rule-level").value !== "price");
  $("rule-x").placeholder = kind === "near" ? "bps" : "prix";
}
$("rule-kind").addEventListener("change", syncRuleForm);
$("rule-level").addEventListener("change", syncRuleForm);
syncRuleForm();
$("rule-add").addEventListener("click", () => {
  const kind = $("rule-kind").value;
  const level = $("rule-level").value;
  const raw = parseFloat($("rule-x").value.replace(",", "."));
  const r = { id: "r" + Date.now().toString(36), kind, level };
  if (kind === "regime") r.regime = $("rule-regime").value;
  if (kind === "near") {
    if (!(raw > 0)) { err("Renseignez un seuil en bps (ex. 20)."); return; }
    r.bps = Math.min(500, raw);
  }
  if (kind === "cross" && level === "price") {
    const px = raw > 0 ? raw : state.levels.spot;
    if (!(px > 0)) { err("Prix fixe invalide."); return; }
    r.px = px;
  }
  r.symbol = state.symbol;
  rules.list.push(r);
  rules.state.set(r.id, {});
  $("rule-x").value = "";
  saveRules(); renderRules();
  toast(`Règle ajoutée : ${ruleLabel(r)}`, "var(--cyan)");
});
$("rules-list").addEventListener("click", (e) => {
  const del = e.target.closest(".rm");
  if (!del) return;
  const id = del.closest(".rule-row").dataset.id;
  rules.list = rules.list.filter((r) => r.id !== id);
  rules.state.delete(id);
  saveRules(); renderRules();
});
function fireRule(r, text, px) {
  const t = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  rules.log.unshift({ t, m: text, p: px != null ? fmtPrice(px) : "—" });
  rules.log = rules.log.slice(0, 40);
  saveRules(); renderRules();
  toast(text, "var(--yellow)", 8000);
  beep(r.kind === "regime" ? 620 : 940, 0.1);
  if (px != null) state.pulses.push({ px, t0: Date.now() });
  const row = document.querySelector(`#rules-list .rule-row[data-id="${r.id}"]`);
  if (row) { row.classList.remove("fired"); void row.offsetWidth; row.classList.add("fired"); }
}
function checkRules(px) {
  if (!rules.list.length || !(px > 0)) return;
  for (const r of rules.list) {
    if (!r.symbol || r.symbol !== state.symbol) continue;
    const st = rules.state.get(r.id) || {};
    rules.state.set(r.id, st);
    if (r.kind === "regime") {
      const reg = state.levels && state.levels.regime;
      if (st.regime !== undefined && reg && reg !== st.regime && reg === r.regime)
        fireRule(r, `Régime γ devient ${r.regime === "long_gamma" ? "LONG" : "SHORT"}`, px);
      st.regime = reg;
      continue;
    }
    const lv = r.level === "price" ? r.px : levelPrice(r.level);
    if (!(lv > 0)) { st.last = px; continue; }
    if (r.kind === "cross") {
      if (st.last != null && st.level === lv && Math.sign(px - lv) !== Math.sign(st.last - lv))
        fireRule(r, `${r.level === "price" ? "Prix" : RULE_LEVELS[r.level]} franchi ${px > lv ? "à la hausse" : "à la baisse"} · ${fmtPrice(lv)}`, lv);
      st.last = px; st.level = lv;
    } else if (r.kind === "near") {
      const bps = Math.abs(px / lv - 1) * 1e4;
      if (bps <= r.bps) {
        if (!st.armed) { st.armed = true; fireRule(r, `Prix à ${bps.toFixed(0)} bps de ${RULE_LEVELS[r.level]} ${fmtPrice(lv)}`, lv); }
      } else if (bps > r.bps * 1.8) st.armed = false;
    }
  }
}

/* --------- E : statistique de réaction des niveaux --------- */
function renderReaction() {
  const bars = state.histArr || [], L = state.levels || {}, W = L.walls || {};
  const tab = $("react-table");
  if (!tab) return;
  const lvls = [
    { n: "CW1", px: W.call && W.call[0] ? W.call[0].strike : null, c: WALL_C },
    { n: "PW1", px: W.put && W.put[0] ? W.put[0].strike : null, c: WALL_P },
    { n: "FLIP", px: L.gamma_flip ?? L.zero_gex ?? null, c: FLIP_C },
    { n: "PAIN", px: L.max_pain ?? null, c: PAIN_C },
    { n: "VWAP", px: state.sess ? state.sess.vwapLast : null, c: "#8492a6" },
  ].filter((l) => l.px > 0);
  if (!lvls.length || bars.length < 12) {
    tab.innerHTML = '<div class="alerts-empty muted">Pas assez d\'historique pour mesurer la réaction des niveaux.</div>';
    $("react-note").textContent = "—";
    return;
  }
  const F = 5;                      // horizon de projection (bougies)
  const rows = [];
  for (const l of lvls) {
    let touches = 0, held = 0, move = 0, prevTouch = false;
    for (let i = 1; i < bars.length - F; i++) {
      const b = bars[i];
      const touch = b.low <= l.px && b.high >= l.px;
      const hit = touch && !prevTouch;   // une touche par passage
      prevTouch = touch;
      if (!hit) continue;
      touches++;
      const side0 = Math.sign(b.close - l.px) || Math.sign(bars[i - 1].close - l.px);
      const sideF = Math.sign(bars[i + F].close - l.px);
      if (side0 !== 0 && sideF === side0) held++;
      move += Math.abs(bars[i + F].close / l.px - 1) * 1e4;
    }
    rows.push({ ...l, touches, held, mv: touches ? move / touches : 0 });
  }
  const maxMv = Math.max(1, ...rows.map((r) => r.mv));
  $("react-note").textContent = `RÉTROSPECTIF · ${bars.length} bougies`;
  tab.innerHTML = '<div class="rb-head"><span>NIVEAU</span><span>STATS</span><span>%</span><span>MV</span></div>' +
    rows.map((r) => {
      const pct = r.touches ? Math.round((r.held / r.touches) * 100) : 0;
      return `<div class="rb-row" title="${r.n} ${fmtPrice(r.px)} · ${r.touches} touches · tenue ${pct} % · mouvement moyen ${r.mv.toFixed(0)} bps sur ${F} bougies">` +
        `<span class="rl2"><i class="sw" style="background:${r.c}"></i>${r.n} ${fmtPrice(r.px)}</span>` +
        `<span class="num">${r.touches}</span>` +
        `<span class="num" style="color:${pct >= 50 ? "var(--green)" : "var(--red)"}">${r.touches ? pct + "%" : "—"}</span>` +
        `<span class="num">${r.touches ? r.mv.toFixed(0) : "—"}</span>` +
        `<span class="rbar"><i style="width:${(100 * r.mv / maxMv).toFixed(0)}%"></i></span></div>`;
    }).join("");
}

/* --------- B : HUD crosshair --------- */
function updateHud(param) {
  const hud = $("hud");
  if (!hud) return;
  const P = state.profile;
  if (!param || param.point == null || !state.candles || !P || !P.strikes) { hud.hidden = true; return; }
  const px = state.candles.coordinateToPrice(param.point.y);
  if (px == null) { hud.hidden = true; return; }
  let bi = 0, bd = Infinity;
  for (let i = 0; i < P.strikes.length; i++) {
    const d = Math.abs(P.strikes[i] - px);
    if (d < bd) { bd = d; bi = i; }
  }
  const L = state.levels || {}, W = L.walls || {};
  const bps = (t) => t == null ? "—" : String(Math.round((t / P.strikes[bi] - 1) * 10000));
  hud.hidden = false;
  hud.innerHTML =
    `<div class="hrow"><span>STRIKE</span><b>${fmtPx(P.strikes[bi], state.symbol)}</b></div>` +
    `<div class="hrow"><span>γ NET</span><b class="${P.net_gex[bi] >= 0 ? "green" : "red"}">${fmtUSD(P.net_gex[bi])}</b></div>` +
    `<div class="hrow"><span>OI C / P</span><b>${fmtOI(P.call_oi[bi])} / ${fmtOI(P.put_oi[bi])}</b></div>` +
    `<div class="hrow"><span>→ CW1</span><b>${bps(W.call && W.call[0] && W.call[0].strike)} bps</b></div>` +
    `<div class="hrow"><span>→ PW1</span><b>${bps(W.put && W.put[0] && W.put[0].strike)} bps</b></div>` +
    `<div class="hrow"><span>→ FLIP</span><b>${bps(L.gamma_flip ?? L.zero_gex)} bps</b></div>`;
  document.querySelectorAll("#ladder .ld-row.xh").forEach((n) => n.classList.remove("xh"));
  const row = document.querySelector(`#ladder .ld-row[data-k="${P.strikes[bi]}"]`);
  if (row) row.classList.add("xh");
}

/* --------- B : rail sidebar repliée --------- */
function renderRail() {
  const r = $("sb-rail");
  if (!r) return;
  const L = state.levels || {}, W = L.walls || {};
  const it = [];
  it.push(`<div class="rl"><span>SPOT</span><b>${L.spot != null ? fmtPx(L.spot, state.symbol) : "—"}</b></div>`);
  if (W.call && W.call[0]) it.push(`<div class="rl" style="color:var(--green)"><span>CW1</span><b>${fmtPx(W.call[0].strike, state.symbol)}</b></div>`);
  if (W.put && W.put[0]) it.push(`<div class="rl" style="color:var(--red)"><span>PW1</span><b>${fmtPx(W.put[0].strike, state.symbol)}</b></div>`);
  const flip = L.gamma_flip ?? L.zero_gex;
  if (flip != null) it.push(`<div class="rl" style="color:var(--yellow)"><span>FLIP</span><b>${fmtPx(flip, state.symbol)}</b></div>`);
  if (L.net_gex_total != null) it.push(`<div class="rl"><span>Γ NET</span><b>${fmtUSD(L.net_gex_total)}</b></div>`);
  r.innerHTML = it.join("");
}

/* --------- D : toasts, beep, pulses --------- */
let _AC = null;
function beep(f, dur) {
  if (!state.sound) return;
  try {
    _AC = _AC || new (window.AudioContext || window.webkitAudioContext)();
    const o = _AC.createOscillator(), g = _AC.createGain();
    o.frequency.value = f || 880; g.gain.value = 0.07;
    o.connect(g); g.connect(_AC.destination); o.start();
    g.gain.exponentialRampToValueAtTime(1e-4, _AC.currentTime + (dur || 0.12));
    o.stop(_AC.currentTime + (dur || 0.12) + 0.02);
  } catch (e) { /* audio indisponible */ }
}
$("sound-toggle").addEventListener("click", () => {
  state.sound = !state.sound;
  localStorage.setItem("gex.sound", state.sound ? "1" : "0");
  $("sound-toggle").classList.toggle("active", state.sound);
  if (state.sound) beep(660, 0.08);
});
$("sound-toggle").classList.toggle("active", state.sound);

/* --------- D : presets SCALP / SWING / MACRO --------- */
const PRESETS = {
  scalp: { iv: "5m", win: 1, filter: "all", ladder: true,
    ltgl: { cw: 1, pw: 1, flip: 1, pain: 0, hist: 1, band: 1, vwap: 1, prof: 1, heat: 1 } },
  swing: { iv: "1h", win: 5, filter: "all", ladder: true,
    ltgl: { cw: 1, pw: 1, flip: 1, pain: 1, hist: 0, band: 1, vwap: 1, prof: 1, heat: 0 } },
  macro: { iv: "1d", win: 8, filter: "monthly", ladder: false,
    ltgl: { cw: 1, pw: 1, flip: 1, pain: 1, hist: 1, band: 0, vwap: 0, prof: 0, heat: 1 } },
};
async function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  localStorage.setItem("gex.preset", name);
  state.interval = p.iv; state.win = p.win; state.filter = p.filter;
  state.ladderOn = p.ladder;
  Object.assign(state.ltgl, p.ltgl);
  document.querySelectorAll("#intervals button").forEach((b) => b.classList.toggle("active", b.dataset.iv === p.iv));
  document.querySelectorAll("#win-seg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.w) === p.win));
  document.querySelectorAll("#filters button").forEach((b) => b.classList.toggle("active", b.dataset.f === p.filter));
  document.querySelectorAll("#lvl-toggles .ltgl").forEach((b) => b.classList.toggle("active", !!state.ltgl[b.dataset.t]));
  document.querySelectorAll("#preset-seg button").forEach((b) => b.classList.toggle("active", b.dataset.p === name));
  localStorage.setItem("gex.ltgl", JSON.stringify(state.ltgl));
  renderLadder();
  closeWS();                   // évite qu'un tick de l'ancien TF retombe dans les nouvelles bougies
  state.lastBar = null;
  try { await loadGex(); await loadHistory(); connectWS(); } catch (e) { err(e.message); }
}
document.querySelectorAll("#preset-seg button").forEach((b) =>
  b.addEventListener("click", () => applyPreset(b.dataset.p)));
{
  const cur = localStorage.getItem("gex.preset");
  if (cur) document.querySelectorAll("#preset-seg button").forEach((b) => b.classList.toggle("active", b.dataset.p === cur));
}

/* --------- session VWAP + volume profile (calcul client) --------- */
function sessionBars(bars, symbol, selection = "auto") {
  const mode = selection === "auto" ? (CRYPTO.has(symbol) ? "utc" : FUTURES.has(symbol) ? "eth" : "rth") : selection;
  const rows = [];
  for (const b of bars || []) {
    if (typeof b.time !== "number" || !(b.volume > 0)) continue;
    const d = new Date(b.time * 1000);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone: mode === "utc" ? "UTC" : "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(d).map(p => [p.type, p.value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    if (mode === "rth" && (minute < 570 || minute >= 960)) continue;
    if (mode === "eth" && minute >= 1020 && minute < 1080) continue;
    const key = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + (mode === "eth" && minute >= 1080 ? 1 : 0))).toISOString().slice(0, 10);
    rows.push({...b, sessionKey: key});
  }
  if (!rows.length) return [];
  const last = rows[rows.length - 1].sessionKey;
  return rows.filter(b => b.sessionKey === last);
}
$("session-select").addEventListener("change", () => { computeSession(state.histArr); queueGamma(); });

function computeSession(bars) {
  const sb = sessionBars(bars, state.symbol, $("session-select").value);
  if (sb.length < 4) { state.sess = null; return; }
  let cv = 0, cs = 0, cs2 = 0;
  const vwap = [], up1 = [], dn1 = [], up2 = [], dn2 = [];
  for (const b of sb) {
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume || 0;
    cv += v; cs += tp * v; cs2 += tp * tp * v;
    if (!(cv > 0)) continue;
    const w = cs / cv;
    const sd = Math.sqrt(Math.max(cs2 / cv - w * w, 0));
    vwap.push(w); up1.push(w + sd); dn1.push(w - sd); up2.push(w + 2 * sd); dn2.push(w - 2 * sd);
  }
  // volume profile : distribution du volume par prix
  let lo = Math.min(...sb.map((b) => b.low)), hi = Math.max(...sb.map((b) => b.high));
  const nB = 56, bw = (hi - lo) / nB || 1;
  const vol = new Array(nB).fill(0);
  for (const b of sb) {
    const i0 = Math.max(0, Math.floor((b.low - lo) / bw));
    const i1 = Math.min(nB - 1, Math.floor((b.high - lo) / bw));
    const each = (b.volume || 0) / (i1 - i0 + 1);
    for (let i = i0; i <= i1; i++) vol[i] += each;
  }
  const tot = vol.reduce((a, b) => a + b, 0);
  let poc = vol.indexOf(Math.max(...vol));
  // value area 70 % autour du POC
  let acc = vol[poc], iA = poc, iB = poc;
  while (acc < 0.7 * tot && (iA > 0 || iB < nB - 1)) {
    const a = iA > 0 ? vol[iA - 1] : -1, bb = iB < nB - 1 ? vol[iB + 1] : -1;
    if (a >= bb) { iA--; acc += vol[iA]; } else { iB++; acc += vol[iB]; }
  }
  state.sess = {
    bars: sb, vwap, up1, dn1, up2, dn2,
    prof: { lo, bw, vol, max: Math.max(...vol, 1) },
    poc: lo + (poc + 0.5) * bw, vah: lo + (iB + 1) * bw, val: lo + iA * bw,
    vwapLast: vwap[vwap.length - 1],
  };
}

/* --------- strip heatmap GEX temps x strike --------- */
const heat = { data: null, ts: 0, key: "" };
async function fetchHeat(force) {
  const key = `${state.symbol}|${state.filter}`;
  if (!force && heat.key === key && Date.now() - heat.ts < 90000) return;
  heat.key = key; heat.ts = Date.now();
  try {
    const r = await fetch(`/api/heatmap/${state.symbol}?mode=hist&range=0.04&filter=${state.filter}`);
    const j = await r.json();
    heat.data = j.available ? j : null;
  } catch (e) { heat.data = null; }
  queueGamma();
}
function drawStrip() {
  const cv = $("gex-strip");
  if (!cv) return;
  if (!state.ltgl.heat || !gp.on || !state.candles) { cv.hidden = true; return; }
  cv.hidden = false;
  const H = cv.clientHeight || cv.parentElement.clientHeight;
  const W = 92;
  if (H < 60) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,.35)";
  ctx.font = "700 8px 'JetBrains Mono', monospace";
  ctx.fillText("γ t×K 15m", 6, 12);
  const hd = heat.data;
  if (!hd || !hd.strikes || !hd.matrix || !hd.matrix.length) {
    ctx.fillStyle = "rgba(255,255,255,.25)";
    ctx.fillText("historique…", 6, H / 2);
    return;
  }
  const rows = hd.matrix, strikes = hd.strikes, nT = rows.length;
  const nC = Math.min(30, nT);
  const cw = W / (nC + 1);
  let maxAbs = 1;
  for (const r of rows) for (const v of r) maxAbs = Math.max(maxAbs, Math.abs(v));
  // coordonnées écran des strikes (alignées sur l'axe du chart)
  const ys = strikes.map((k) => state.candles.priceToCoordinate(k));
  const slot = (() => {
    const v = [];
    for (let i = 0; i < ys.length - 1; i++) if (ys[i] != null && ys[i + 1] != null) v.push(Math.abs(ys[i + 1] - ys[i]));
    v.sort((a, b) => a - b);
    return v.length ? Math.max(1, Math.min(26, v[Math.floor(v.length / 2)])) : 3;
  })();
  const live = new Map();
  if (state.profile && state.profile.strikes)
    state.profile.strikes.forEach((k, i) => live.set(k, state.profile.net_gex[i] / 1e6));
  for (let c = 0; c < nC; c++) {
    const ri = Math.floor((c + 0.5) * nT / nC);
    const row = rows[Math.min(nT - 1, ri)];
    const x = c * cw;
    for (let i = 0; i < strikes.length; i++) {
      const y = ys[i];
      if (y == null || y < -slot || y > H + slot) continue;
      const v = row[i];
      const a = 0.06 + 0.80 * Math.pow(Math.abs(v) / maxAbs, 0.6);
      ctx.fillStyle = v >= 0 ? `rgba(45,212,167,${a.toFixed(3)})` : `rgba(240,97,109,${a.toFixed(3)})`;
      ctx.fillRect(x, y - slot / 2, cw + 0.6, slot);
    }
    const sp = hd.spot_path && hd.spot_path[ri];
    const ysp = sp != null ? state.candles.priceToCoordinate(sp) : null;
    if (ysp != null && ysp > 0 && ysp < H) { ctx.fillStyle = "rgba(255,255,255,.85)"; ctx.fillRect(x, ysp - 1, cw, 2); }
  }
  // colonne live (profil courant)
  const x = nC * cw;
  for (const k of strikes) {
    const y = state.candles.priceToCoordinate(k);
    if (y == null || y < -slot || y > H + slot) continue;
    const v = live.get(k);
    if (v == null) continue;
    const a = 0.06 + 0.80 * Math.pow(Math.abs(v) / maxAbs, 0.6);
    ctx.fillStyle = v >= 0 ? `rgba(45,212,167,${a.toFixed(3)})` : `rgba(240,97,109,${a.toFixed(3)})`;
    ctx.fillRect(x, y - slot / 2, cw + 0.6, slot);
  }
}

/* --------- tape ticker --------- */
let tapeTs = 0;
function renderTape(force) {
  const now = Date.now();
  if (!force && now - tapeTs < 5000) return;
  tapeTs = now;
  const el = $("tape-inner");
  if (!el) return;
  const L = state.levels || {};
  const it = [];
  for (const sy of (state.symbols || [])) {
    if (sy.price == null) continue;
    const c = sy.change_pct || 0;
    it.push(`<span><b>${sy.symbol}</b> ${fmtPrice(sy.price)} <span class="${c >= 0 ? "green" : "red"}">${c >= 0 ? "+" : ""}${c.toFixed(2)}%</span></span>`);
  }
  if (L.net_gex_total != null) it.push(`<span>Γ NET <b class="${L.regime === "long_gamma" ? "green" : "red"}">${fmtUSD(L.net_gex_total)}</b> ${L.regime === "long_gamma" ? "LONG" : "SHORT"} GAMMA</span>`);
  const flip = L.gamma_flip ?? L.zero_gex;
  if (flip != null && L.spot) it.push(`<span>FLIP <b>${fmtPrice(flip)}</b> · ${Math.round((flip / L.spot - 1) * 10000)} bps</span>`);
  const W = L.walls || {};
  if (W.call && W.call[0]) it.push(`<span>CW1 <b class="green">${fmtPrice(W.call[0].strike)}</b></span>`);
  if (W.put && W.put[0]) it.push(`<span>PW1 <b class="red">${fmtPrice(W.put[0].strike)}</b></span>`);
  if (state.sess && state.sess.vwapLast) it.push(`<span>VWAP <b>${fmtPrice(state.sess.vwapLast)}</b></span>`);
  if (state.meta && state.meta.chain_ts) it.push(`<span>CHAÎNE <b>${String(state.meta.chain_ts).slice(11, 16)} ET</b></span>`);
  it.push(`<span>${CRYPTO.has(state.symbol) ? "Deribit options + tape temps réel" : "CBOE delayed 15-min · Yahoo"} · <b>${($("mode-label") || {}).textContent || "SIM"}</b></span>`);
  const html = it.join('<span class="tsep">·</span>');
  el.innerHTML = html + '<span class="tsep" style="width:40px"></span>' + html;
}

function drawGamma() {
  const cv = $("gex-overlay");
  if (!gp.on || !state.chart || !state.candles || !state.profile || cv.style.display === "none") return;
  const wrap = $("chart-area");
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W < 100 || H < 100) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const P = state.profile, L = state.levels, T = state.ltgl;
  const spot = L.spot ?? P.strikes[Math.floor(P.strikes.length / 2)];
  const axisW = state.chart.priceScale("right").width?.() ?? 62;
  const plotR = W - axisW;
  if (plotR < 120) return;
  const winF = (state.win || 3) / 100;

  // strikes dans la fenêtre ±win %, projetés en coordonnées écran
  const rows = [];
  let maxAbs = 1;
  for (let i = 0; i < P.strikes.length; i++) {
    const sk = P.strikes[i];
    if (Math.abs(sk - spot) / spot > winF) continue;
    const y = state.candles.priceToCoordinate(sk);
    if (y == null || y < -40 || y > H + 40) continue;
    rows.push({ y, v: P.net_gex[i], sk });
    maxAbs = Math.max(maxAbs, Math.abs(P.net_gex[i]));
  }
  if (rows.length < 2) return;
  rows.sort((a, b) => a.y - b.y);

  // espacement médian entre strikes (px) -> bandes étroites ±0.25 spacing
  const dys = [];
  for (let i = 0; i < rows.length - 1; i++) dys.push(rows[i + 1].y - rows[i].y);
  dys.sort((a, b) => a - b);
  const slotPx = dys.length ? Math.max(1, dys[Math.floor(dys.length / 2)]) : 4;

  // 1) bandes étroites sous les walls #1 (jamais plus d'un strike)
  if (T.band) {
    const band = (px, color) => {
      if (px == null) return;
      const y = state.candles.priceToCoordinate(px);
      if (y == null) return;
      ctx.fillStyle = hexA(color, 0.10);
      ctx.fillRect(0, y - slotPx * 0.25, plotR, slotPx * 0.5);
    };
    const Ws = L.walls || { call: [], put: [] };
    if (T.cw && Ws.call[0]) band(Ws.call[0].strike, WALL_C);
    if (T.pw && Ws.put[0]) band(Ws.put[0].strike, WALL_P);
  }

  // 1bis) volume profile session (barres grises depuis le bord droit) + POC/VA
  const SE = state.sess;
  if (T.prof && SE) {
    const { lo, bw, vol, max } = SE.prof;
    ctx.fillStyle = "rgba(139,147,167,.16)";
    for (let i = 0; i < vol.length; i++) {
      if (vol[i] <= 0) continue;
      const y1 = state.candles.priceToCoordinate(lo + i * bw);
      const y2 = state.candles.priceToCoordinate(lo + (i + 1) * bw);
      if (y1 == null || y2 == null) continue;
      const h = Math.max(1, Math.abs(y2 - y1));
      const len = (vol[i] / max) * 88;
      ctx.fillRect(0, Math.min(y1, y2), len, h);
    }
    const pl = (px, color, dash, label) => {
      const y = state.candles.priceToCoordinate(px);
      if (y == null || y < 0 || y > H) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(plotR, y + .5); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.font = "700 8px 'JetBrains Mono', monospace";
      ctx.fillText(label, 6, y - 3);
    };
    pl(SE.poc, "rgba(245,197,66,.8)", [], "POC");
    pl(SE.vah, "rgba(139,147,167,.55)", [3, 3], "VAH");
    pl(SE.val, "rgba(139,147,167,.55)", [3, 3], "VAL");
  }
  // 1ter) VWAP session + bandes ±1σ / ±2σ
  if (T.vwap && SE && state.lastBar) {
    const line = (arr, color, width, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      SE.bars.forEach((b, i) => {
        const x = state.chart.timeScale().timeToCoordinate(b.time);
        const y = state.candles.priceToCoordinate(arr[i]);
        if (x == null || y == null) return;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    };
    line(SE.up2, "rgba(139,147,167,.30)", 1, [2, 4]);
    line(SE.dn2, "rgba(139,147,167,.30)", 1, [2, 4]);
    line(SE.up1, "rgba(139,147,167,.50)", 1, [4, 4]);
    line(SE.dn1, "rgba(139,147,167,.50)", 1, [4, 4]);
    line(SE.vwap, "rgba(232,236,244,.92)", 1.6, []);
  }

  // 1quater) ruban de session : volume coloré vs VWAP + rendu cumulé
  const SE0 = state.sess;
  if (SE0 && state.histArr && state.histArr.length > 2) {
    const y0 = H * 0.845, y1 = H - 2;
    const rng = state.chart.timeScale().getVisibleLogicalRange();
    if (rng && rng.to > rng.from) {
      const bw = Math.max(1, plotR / (rng.to - rng.from));
      const open0 = SE0.bars[0].close;
      let cumPrev = null, sidePrev = null;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, y0, plotR, y1 - y0); ctx.clip();
      ctx.fillStyle = "rgba(255,255,255,.03)";
      ctx.fillRect(0, y0, plotR, y1 - y0);
      const sd = Math.max(1e-9, SE0.up1[SE0.up1.length - 1] - SE0.vwap[SE0.vwap.length - 1]);
      SE0.bars.forEach((b, i) => {
        const x = state.chart.timeScale().timeToCoordinate(b.time);
        if (x == null || x < -bw || x > plotR + bw) return;
        const dv = b.close - SE0.vwap[i];
        const a = 0.10 + 0.40 * Math.min(1, Math.abs(dv) / sd);
        ctx.fillStyle = dv >= 0 ? `rgba(45,212,167,${a.toFixed(3)})` : `rgba(240,97,109,${a.toFixed(3)})`;
        ctx.fillRect(x - bw / 2 + 0.5, y0 + 1, Math.max(1, bw - 1), y1 - y0 - 2);
        if (sidePrev != null && Math.sign(dv) !== sidePrev) {
          ctx.fillStyle = "rgba(255,255,255,.9)";
          ctx.beginPath(); ctx.arc(x, y0 + 4, 2, 0, Math.PI * 2); ctx.fill();
        }
        sidePrev = Math.sign(dv);
        // rendu cumulé (polyline steel)
        const cum = (b.close / open0 - 1);
        const cy = y1 - 3 - Math.max(-1, Math.min(1, cum / 0.012)) * (y1 - y0 - 8) / 2 - (y1 - y0 - 8) / 2 * 0;
        const cy2 = (y0 + y1) / 2 - Math.max(-1, Math.min(1, cum / 0.012)) * (y1 - y0) / 2;
        if (cumPrev != null) {
          ctx.strokeStyle = "rgba(200,210,225,.75)"; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(cumPrev.x, cumPrev.y); ctx.lineTo(x, cy2); ctx.stroke();
        }
        cumPrev = { x, y: cy2 };
        void cy;
      });
      ctx.restore();
    }
  }

  // 1quinquies) step-lines : dérive des walls/flip depuis le journal 15 min
  const hd0 = heat.data;
  if (hd0 && hd0.times && hd0.cw && !state.barsDaily) {
    const step = (key, color) => {
      let px = null, py = null;
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = 0; i < hd0.times.length; i++) {
        const v = hd0[key] && hd0[key][i];
        const x = state.chart.timeScale().timeToCoordinate(Math.round(hd0.times[i]));
        const y = v != null ? state.candles.priceToCoordinate(v) : null;
        if (x == null || y == null) { px = null; continue; }
        if (px != null && py != null) { ctx.moveTo(px, py); ctx.lineTo(x, py); ctx.lineTo(x, y); }
        px = x; py = y;
      }
      ctx.stroke();
    };
    if (hd0.cw.some((v) => v != null)) step("cw", "rgba(45,212,167,.42)");
    if (hd0.pw && hd0.pw.some((v) => v != null)) step("pw", "rgba(240,97,109,.42)");
    if (hd0.fl && hd0.fl.some((v) => v != null)) step("fl", "rgba(245,197,66,.40)");
  }

  // 1sexies) marqueurs de franchissement des niveaux #1 / flip
  state.crossCounts = {};
  if (SE0 && L.walls) {
    const lvls = [];
    if (T.cw && L.walls.call[0]) lvls.push({ k: "cw", px: L.walls.call[0].strike, c: WALL_C });
    if (T.pw && L.walls.put[0]) lvls.push({ k: "pw", px: L.walls.put[0].strike, c: WALL_P });
    const fl0 = L.gamma_flip ?? L.zero_gex;
    if (T.flip && fl0 != null) lvls.push({ k: "fl", px: fl0, c: FLIP_C });
    for (const lv of lvls) {
      let side = null, n = 0;
      for (const b of SE0.bars) {
        const sd0 = Math.sign(b.close - lv.px);
        if (side != null && sd0 !== 0 && sd0 !== side) {
          n++;
          const x = state.chart.timeScale().timeToCoordinate(b.time);
          const y = state.candles.priceToCoordinate(lv.px);
          if (x != null && y != null && y > 0 && y < H) {
            ctx.fillStyle = sd0 > 0 ? "rgba(45,212,167,.95)" : "rgba(240,97,109,.95)";
            ctx.beginPath();
            if (sd0 > 0) { ctx.moveTo(x, y - 3); ctx.lineTo(x - 4, y - 9); ctx.lineTo(x + 4, y - 9); }
            else { ctx.moveTo(x, y + 3); ctx.lineTo(x - 4, y + 9); ctx.lineTo(x + 4, y + 9); }
            ctx.closePath(); ctx.fill();
          }
        }
        if (sd0 !== 0) side = sd0;
      }
      state.crossCounts[lv.k] = n;
    }
  }

  // 3) histogramme GEX net par strike : axe zéro central, vert à droite,
  //    rouge à gauche, une barre par strike (hauteur = slot - 1 px)
  const GUT = 64, x0 = plotR - GUT, xC = x0 + GUT / 2;
  if (T.hist) {
    ctx.strokeStyle = "rgba(255,255,255,.18)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xC + .5, rows[0].y - 4); ctx.lineTo(xC + .5, rows[rows.length - 1].y + 4);
    ctx.stroke();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const h = Math.max(1, slotPx - 1);
      const len = Math.sqrt(Math.abs(r.v) / maxAbs) * (GUT / 2 - 8);
      if (len < 0.8) continue;
      ctx.fillStyle = r.v >= 0 ? "rgba(45,212,167,.75)" : "rgba(240,97,109,.75)";
      if (r.v >= 0) ctx.fillRect(xC + 1, r.y - h / 2, len, h);
      else ctx.fillRect(xC - 1 - len, r.y - h / 2, len, h);
    }
  }

  // 4) marqueurs de bord de gouttière
  const mark = (px, color, shape) => {
    const y = state.candles.priceToCoordinate(px);
    if (y == null) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (shape === "d") {
      ctx.moveTo(x0 - 10, y); ctx.lineTo(x0 - 6, y - 4); ctx.lineTo(x0 - 2, y); ctx.lineTo(x0 - 6, y + 4);
    } else if (shape === "s") {
      ctx.rect(x0 - 9, y - 3, 6, 6);
    } else {
      ctx.moveTo(x0 - 10, y - 4); ctx.lineTo(x0 - 10, y + 4); ctx.lineTo(x0 - 3, y);
    }
    ctx.closePath(); ctx.fill();
  };
  const Ws = L.walls || { call: [], put: [] };
  if (T.cw && Ws.call[0]) mark(Ws.call[0].strike, WALL_C, "t");
  if (T.pw && Ws.put[0]) mark(Ws.put[0].strike, WALL_P, "t");
  const flip = L.gamma_flip ?? L.zero_gex;
  if (T.flip && flip != null) mark(flip, FLIP_C, "d");
  if (T.pain && L.max_pain != null) mark(L.max_pain, PAIN_C, "s");

  // 5) chips d'axe : « CW1 82,000 | $22.4M » posées sur le strike, empilées sans
  //    chevauchement si elles se marchent dessus (le trait de rappel garde le
  //    prix exact quand la chip a été poussée).
  const CH = 15, GAP = 1, chipW = Math.max(60, axisW - 4);
  const chips = [];
  const xc = state.crossCounts || {};
  if (T.cw) Ws.call.slice(0, 3).forEach((e, i) => chips.push({ y0: state.candles.priceToCoordinate(e.strike), bg: i ? hexA(WALL_C, .82) : WALL_C, txt: `CW${i + 1} ${fmtPrice(e.strike)} | ${fmtUSD(e.gex)}${i === 0 && xc.cw ? " ×" + xc.cw : ""}` }));
  if (T.pw) Ws.put.slice(0, 3).forEach((e, i) => chips.push({ y0: state.candles.priceToCoordinate(e.strike), bg: i ? hexA(WALL_P, .82) : WALL_P, txt: `PW${i + 1} ${fmtPrice(e.strike)} | ${fmtUSD(e.gex)}${i === 0 && xc.pw ? " ×" + xc.pw : ""}` }));
  if (T.flip && flip != null) chips.push({ y0: state.candles.priceToCoordinate(flip), bg: FLIP_C, txt: `FLIP ${fmtPrice(flip)}` });
  if (T.pain && L.max_pain != null) chips.push({ y0: state.candles.priceToCoordinate(L.max_pain), bg: hexA(PAIN_C, .8), txt: `PAIN ${fmtPrice(L.max_pain)}` });
  const tsH = typeof state.chart.timeScale().height === "function" ? state.chart.timeScale().height() : 28;
  const yMax = H - tsH - 2;          // jamais de chip sur l'axe du temps
  const vis = chips.filter((c) => c.y0 != null && c.y0 >= 2 && c.y0 <= yMax).sort((a, b) => a.y0 - b.y0);
  for (const c of vis) c.y = c.y0;
  // passe 1 : pousse vers le bas ; passe 2 : remonte si ça déborde
  for (let i = 1; i < vis.length; i++) if (vis[i].y < vis[i - 1].y + CH + GAP) vis[i].y = vis[i - 1].y + CH + GAP;
  let over = vis.length ? vis[vis.length - 1].y - yMax : 0;
  if (over > 0) {
    for (let i = vis.length - 1; i >= 0; i--) {
      vis[i].y -= over;
      if (i && vis[i].y < vis[i - 1].y + CH + GAP) over = vis[i - 1].y + CH + GAP - vis[i].y;
      else over = 0;
      if (!over) break;
    }
  }
  ctx.font = "700 9px 'JetBrains Mono', monospace";
  for (const c of vis) {
    if (c.y < 2) continue;
    const w = chipW;
    if (Math.abs(c.y - c.y0) > 1) {           // rappel discret vers le strike réel
      ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(plotR + 1, c.y0 + .5); ctx.lineTo(plotR + 5, c.y + .5); ctx.stroke();
    }
    // masque opaque sur toute la largeur de l'axe : les prix du scale ne se
    // mélangent jamais au texte de la chip
    ctx.fillStyle = "rgba(9,12,19,.94)";
    ctx.fillRect(plotR + 1, c.y - 8, axisW - 1, CH);
    ctx.fillStyle = c.bg;
    ctx.beginPath();
    ctx.roundRect(plotR + 1.5, c.y - 8, w, CH, 3);
    ctx.fill();
    ctx.fillStyle = "#0b0e14";
    ctx.save();
    ctx.beginPath(); ctx.rect(plotR + 1.5, c.y - 8, w, CH); ctx.clip();
    ctx.fillText(c.txt, plotR + 6, c.y + 3);
    ctx.restore();
  }

  // 6) chips de rappel quand un niveau sort de l'écran (zoom intraday)
  const chip = (px, bg, label) => {
    const y = state.candles.priceToCoordinate(px);
    if (y == null || (y >= 4 && y <= H - 4)) return;
    const top = y < 0;
    const txt = `${top ? "▲" : "▼"} ${label} ${fmtPrice(px)}`;
    ctx.font = "700 10px 'JetBrains Mono', monospace";
    const w = ctx.measureText(txt).width + 14;
    const yy = top ? 6 : H - 24;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(plotR - w - 10, yy, w, 18, 5);
    ctx.fill();
    ctx.fillStyle = "#0b0e14";
    ctx.fillText(txt, plotR - w - 3, yy + 13);
  };
  if (T.cw && Ws.call[0]) chip(Ws.call[0].strike, WALL_C, "CW1");
  if (T.pw && Ws.put[0]) chip(Ws.put[0].strike, WALL_P, "PW1");
  if (T.flip && flip != null) chip(flip, FLIP_C, "FLIP");

  // pulses d'alerte (anneaux expansifs)
  if (state.pulses && state.pulses.length) {
    const now = Date.now();
    state.pulses = state.pulses.filter((p) => now - p.t0 < 1400);
    for (const p of state.pulses) {
      const age = (now - p.t0) / 1400;
      const y = state.candles.priceToCoordinate(p.px);
      if (y == null) continue;
      ctx.strokeStyle = `rgba(245,197,66,${(0.7 * (1 - age)).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(plotR - 16, y, 5 + age * 26, 0, Math.PI * 2); ctx.stroke();
    }
    if (state.pulses.length) queueGamma();
  }

  drawStrip();
}

/* ---------------- simulateur de scénario ---------------- */
const scen = { open: false, dspot: 0, div: 0, minutes: 0, seq: 0, timer: null, lines: {} };

$("scen-toggle").addEventListener("click", () => {
  scen.open = !scen.open;
  $("scen-panel").hidden = !scen.open;
  $("scen-toggle").classList.toggle("active", scen.open);
  if (scen.open) runScenario(); else clearScenario();
});
$("sc-close").addEventListener("click", () => $("scen-toggle").click());
$("sc-reset").addEventListener("click", () => {
  $("sc-spot").value = 0; $("sc-iv").value = 0;
  scen.dspot = 0; scen.div = 0; scen.minutes = 0; $("sc-time").value = 0; $("sc-time-v").textContent = "+0 min";
  $("sc-spot-v").textContent = "+0.00 %"; $("sc-iv-v").textContent = "+0.0 pt";
  runScenario();
});
[[ "sc-spot", "dspot", (v) => (v >= 0 ? "+" : "") + v.toFixed(2) + " %"],
 [ "sc-iv",   "div",   (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + " pt"],
 [ "sc-time", "minutes", (v) => `+${v} min`]].forEach(([id, key, fmt]) => {
  $(id).addEventListener("input", (e) => {
    const raw = parseFloat(e.target.value);
    scen[key] = key === "dspot" ? raw / 100 : raw;   // slider en %, backend en fraction
    $(id + "-v").textContent = fmt(raw);
    clearTimeout(scen.timer);
    scen.timer = setTimeout(runScenario, 160);
  });
});

async function runScenario() {
  const seq = ++scen.seq, sym = state.symbol, filter = state.filter;
  if (!scen.open) return;
  if (scen.dspot === 0 && scen.div === 0 && scen.minutes === 0) { clearScenario(); renderScenOut(null); return; }
  try {
    const r = await fetch(`/api/scenario/${state.symbol}?dspot=${scen.dspot}&div=${scen.div}&minutes=${scen.minutes}&filter=${state.filter}`);
    const j = await r.json();
    if (seq !== scen.seq || sym !== state.symbol || filter !== state.filter || !scen.open) return;
    if (j.error || !j.strikes) return;
    drawScenLines(j);
    renderScenOut(j);
  } catch { /* serveur occupé */ }
}

function drawScenLines(j) {
  const defs = [
    ["sc_cw", j.call_wall, "#ffa502", "CW SCÉN"],
    ["sc_pw", j.put_wall, "#ffa502", "PW SCÉN"],
    ["sc_zg", j.zero_gex, "#ff7f50", "ZG SCÉN"],
  ];
  for (const [key, price, color, title] of defs) {
    if (price == null) {
      if (scen.lines[key]) { state.candles.removePriceLine(scen.lines[key]); delete scen.lines[key]; delete state.lines[key]; }
      continue;
    }
    const opts = { price, color, lineWidth: 1, lineStyle: D, axisLabelVisible: true, title };
    if (scen.lines[key]) scen.lines[key].applyOptions(opts);
    else scen.lines[key] = makeLine(key, opts);
  }
}

function clearScenario() {
  scen.seq++;
  for (const k of Object.keys(scen.lines)) {
    state.candles.removePriceLine(scen.lines[k]);
    delete state.lines[k];
  }
  scen.lines = {};
  renderScenOut(null);
}

function renderScenOut(j) {
  const el = $("sc-out");
  if (!j) { el.innerHTML = ""; return; }
  const L = state.levels;
  const row = (lab, v, base) => {
    const d = (v == null || base == null) ? "" :
      `<span class="dl ${v - base >= 0 ? "green" : "red"}">${v - base >= 0 ? "+" : "−"}${Math.abs(v - base).toFixed(0)}</span>`;
    return `<span class="lab">${lab}</span><span>${v == null ? "—" : fmtPx(v, state.symbol)}</span>${d || "<span></span>"}`;
  };
  el.innerHTML =
    row("ZERO-GEX", j.zero_gex, L.zero_gex) +
    row("CALL WALL", j.call_wall, L.call_wall) +
    row("PUT WALL", j.put_wall, L.put_wall) +
    `<span class="lab">RÉGIME</span><span class="${j.regime === "long_gamma" ? "green" : "red"}" style="grid-column:span 2">${regimeLabel(j.regime)}</span>` +
    `<span class="lab">GEX NET 1%</span><span style="grid-column:span 2" class="${(j.net_gex_total ?? 0) >= 0 ? "green" : "red"}">${fmtUSD(j.net_gex_total)}</span>`;
}

$("hm-toggle").addEventListener("click", () => {
  hm.open = !hm.open;
  $("heatmap-panel").hidden = !hm.open;
  $("hm-toggle").classList.toggle("active", hm.open);
  if (hm.open) fetchHeatmap();
});
$("hm-close").addEventListener("click", () => {
  hm.open = false;
  $("heatmap-panel").hidden = true;
  $("hm-toggle").classList.remove("active");
});
document.querySelectorAll("#hm-mode button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#hm-mode button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active"); hm.mode = b.dataset.m; fetchHeatmap();
  }));
document.querySelectorAll("#hm-iv button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#hm-iv button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active"); hm.iv = b.dataset.i; fetchHeatmap();
  }));
document.querySelectorAll("#hm-range button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#hm-range button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active"); hm.range = parseFloat(b.dataset.r); fetchHeatmap();
  }));

async function fetchHeatmap() {
  if (!hm.open) return;
  const url = `/api/heatmap/${state.symbol}?mode=${hm.mode}&interval=${hm.iv}&range=${hm.range}&filter=${state.filter}`;
  $("hm-empty").hidden = true;
  try {
    const r = await fetch(url);
    const j = await r.json();
    hm.data = j;
    if (!j.available) {
      $("hm-empty").hidden = false;
      $("hm-empty").textContent = j.reason || "Données indisponibles";
      $("hm-foot").textContent = "";
      return;
    }
    renderHeatmap();
  } catch (e) {
    $("hm-empty").hidden = false;
    $("hm-empty").textContent = "Erreur de chargement du heatmap";
  }
}

function renderHeatmap() {
  const j = hm.data;
  hm.multiDay = new Set(j.times.map(t => new Date(t * 1000).toLocaleDateString("fr-FR", { timeZone: "America/New_York" }))).size > 1;
  if (!j || !j.available) return;
  const canvas = $("hm-canvas");
  const body = $("hm-body");
  const dpr = window.devicePixelRatio || 1;
  const W = body.clientWidth, H = body.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const M = { l: 6, r: 64, t: 10, b: 22 };
  const strikes = j.strikes;                 // haut = strike max
  const nS = strikes.length, nT = j.times.length;
  if (!nS || !nT) return;
  const cw = (W - M.l - M.r) / nT;
  const ch = (M.t + (H - M.t - M.b)) / nS - 0;  // hauteur de cellule
  const plotH = H - M.t - M.b;
  const rowH = plotH / nS;

  // normalisation par colonne (max |GEX| du pas de temps)
  const colMax = new Array(nT).fill(1e-9);
  for (let t = 0; t < nT; t++) {
    let m = 0;
    const col = j.matrix[t];
    for (let s = 0; s < nS; s++) m = Math.max(m, Math.abs(col[s]));
    colMax[t] = m || 1e-9;
  }
  for (let t = 0; t < nT; t++) {
    const col = j.matrix[t];
    const x = M.l + t * cw;
    for (let s = 0; s < nS; s++) {
      const v = col[s];
      if (!v) continue;
      const a = Math.pow(Math.abs(v) / colMax[t], 0.6);
      ctx.fillStyle = v > 0 ? `rgba(45,212,167,${(a * 0.92).toFixed(3)})`
                            : `rgba(240,97,109,${(a * 0.92).toFixed(3)})`;
      ctx.fillRect(x, M.t + s * rowH, cw + 0.6, rowH + 0.6);
    }
  }

  // walls horizontales (niveaux courants)
  const yOf = (px) => {
    const hi = strikes[0], lo = strikes[nS - 1];
    if (px > hi || px < lo) return null;
    return M.t + ((hi - px) / (hi - lo)) * plotH;
  };
  const wallLine = (lvl, color, label) => {
    if (lvl == null) return;
    const y = yOf(lvl);
    if (y == null) return;
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(W - M.r, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = "600 9px 'JetBrains Mono', monospace";
    ctx.fillText(label, M.l + 4, y - 3);
    ctx.restore();
  };
  wallLine(state.levels.call_wall, "rgba(240,97,109,.85)", "CALL WALL");
  wallLine(state.levels.put_wall, "rgba(45,212,167,.85)", "PUT WALL");

  // trajectoire du spot
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.4;
  ctx.shadowColor = "rgba(79,142,247,.8)"; ctx.shadowBlur = 6;
  ctx.beginPath();
  let started = false;
  for (let t = 0; t < nT; t++) {
    const y = yOf(j.spot_path[t]);
    const x = M.l + (t + 0.5) * cw;
    if (y == null) { started = false; continue; }
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // axes
  ctx.fillStyle = "#8492a6"; ctx.font = "500 9.5px 'JetBrains Mono', monospace";
  const stepS = Math.max(1, Math.round(nS / 9));
  for (let s = 0; s < nS; s += stepS) {
    ctx.fillText(fmtPx(strikes[s], state.symbol), W - M.r + 8, M.t + s * rowH + rowH / 2 + 3);
  }
  const stepT = Math.max(1, Math.round(nT / 7));
  ctx.textAlign = "center";
  for (let t = 0; t < nT; t += stepT) {
    const lbl = hmTimeLabel(j.times[t], j.mode);
    ctx.fillText(lbl, M.l + (t + 0.5) * cw, H - 7);
  }
  ctx.textAlign = "left";

  $("hm-foot").innerHTML =
    `<span>${nT} pas × ${nS} strikes · ${hm.mode === "session" ? "RECONSTRUCTION : OI, IV et temps du snapshot constants — pas un historique observé" : "snapshots 15 min accumulés"}</span>` +
    `<span>normalisé par colonne · ligne blanche = spot · pointillés = walls</span>`;

  // hover
  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left - M.l, y = e.clientY - r.top - M.t;
    const t = Math.floor(x / cw), s = Math.floor(y / rowH);
    const tip = $("hm-tip");
    if (t < 0 || t >= nT || s < 0 || s >= nS) { tip.hidden = true; return; }
    const v = j.matrix[t][s];
    tip.hidden = false;
    tip.style.left = Math.min(W - 190, e.clientX - r.left + 14) + "px";
    tip.style.top = Math.max(4, e.clientY - r.top - 34) + "px";
    tip.innerHTML = `${hmTimeLabel(j.times[t], j.mode, true)} · <b>${fmtPx(strikes[s], state.symbol)}</b> · ` +
      `<span class="${v >= 0 ? "green" : "red"}">${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(1)}M</span>`;
  };
  canvas.onmouseleave = () => { $("hm-tip").hidden = true; };
}

function hmTimeLabel(t, mode, full) {
  const d = new Date(t * 1000);
  const hmStr = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
  if (mode === "hist" || full || hm.multiDay) {
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "America/New_York" }) + " " + hmStr;
  }
  return hmStr + " ET";
}
window.addEventListener("resize", () => { if (hm.open && hm.data && hm.data.available) renderHeatmap(); queueGamma(); queueDraw(); drawHeroSpark(); });

/* ---------------- statut de marché + horloge ET ---------------- */
function updateMarketStatus() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(), min = et.getHours() * 60 + et.getMinutes();
  const chip = $("market-status"), label = $("ms-label");
  $("et-clock").textContent = et.toLocaleTimeString("en-GB", { hour12: false }) + " ET";
  let open;
  if (CRYPTO.has(state.symbol)) {
    open = true;                       // crypto : jamais de séance fermée
  } else if (FUTURES.has(state.symbol)) {
    // CME: dim 18h -> ven 17h, pause 17h-18h
    if (day === 5 && min >= 17 * 60) open = false;
    else if (day === 6) open = false;
    else if (day === 0 && min < 18 * 60) open = false;
    else open = !(min >= 17 * 60 && min < 18 * 60);
  } else {
    open = day >= 1 && day <= 5 && min >= 9 * 60 + 30 && min < 16 * 60;
  }
  const session = state.symbols.find(s => s.symbol === state.symbol)?.session;
  if (session && Date.now()/1000-session.checked_at<30) open=session.open;
  chip.className = "chip " + (open ? "open" : "closed");
  label.textContent = CRYPTO.has(state.symbol) ? "24/7 · CRYPTO"
    : (open ? "MARCHÉ OUVERT" : "MARCHÉ FERMÉ");
}
setInterval(updateMarketStatus, 1000);

/* ---------------- onglets ---------------- */
async function refreshTabs() {
  try {
    const r = await fetch("/api/symbols");
    state.symbols = await r.json();
    const nav = $("tabs");
    if (!nav.children.length) {
      for (const s of state.symbols) {
        const b = document.createElement("button");
        b.dataset.sym = s.symbol;
        b.innerHTML = `<span class="t-sym">${s.symbol}</span><span class="t-px mono">—</span><span class="t-chg mono">—</span><span class="t-spark"></span>`;
        b.addEventListener("click", () => switchSymbol(s.symbol));
        nav.appendChild(b);
      }
    }
    for (const b of nav.children) {
      const s = state.symbols.find((x) => x.symbol === b.dataset.sym);
      if (!s) continue;
      if (s.symbol === state.symbol && s.next_refresh) state.nextRefresh = s.next_refresh;
      tweenNum(b.querySelector(".t-px"), s.price, (x) => fmtPx(x, s.symbol));
      if (s.spark && s.spark.length > 1 && !state.sparks[s.symbol]) state.sparks[s.symbol] = s.spark.slice();
      const spk = state.sparks[s.symbol];
      if (spk && spk.length > 1) b.querySelector(".t-spark").innerHTML = sparkSVG(spk, s.change_pct >= 0 ? "var(--green)" : "var(--red)");
      const ch = b.querySelector(".t-chg");
      ch.textContent = (s.change_pct >= 0 ? "+" : "") + s.change_pct.toFixed(2) + " %";
      ch.className = "t-chg mono " + (s.change_pct >= 0 ? "up" : "down");
      b.classList.toggle("active", s.symbol === state.symbol);
      if (s.symbol === state.symbol) setMode(s.mode);
    }
  } catch { /* serveur en démarrage */ }
}

async function switchSymbol(sym) {
  if (sym === state.symbol) return;
  closeWS();                       // l'ancien instrument s'arrête AVANT les fetch
  stopFlowPoll();
  state.symbol = sym;
  state.prevPrice = null;
  state.lastBar = null;
  state.bars = new Map();          // plus aucune barre de l'autre instrument
  state.levels = {};
  state.flowBig = []; state.flowAbsorb = []; state.flowHits = [];
  state.flowBars = []; flowAbsSeq = 0; flowBigSeq = 0;
  stopFlowBarsPoll();
  await loadSymbol();
  refreshTabs();
  updateMarketStatus();
}

async function loadSymbol() {
  try {
    initChart();
    skeletons(true);
    $("live-price").textContent = "—";
    try { await loadHistory(); } catch (e) { err("Bougies indisponibles : " + e.message); }
    await loadGex();
    connectWS();
    // cartes futures : basis + carnet d'ordres
    const isFut = FUTURES.has(state.symbol);
    $("basis-card").hidden = !isFut;
    $("dom-card").hidden = !isFut;
    $("fut-none").hidden = isFut;
    drawLoad(); queueDraw();
    stopDomPoll();
    if (isFut) { loadBasis(); startDomPoll(); }
    startFlowPoll();
    startFlowBarsPoll();
    loadDerivs();
    if (hm.open) fetchHeatmap();
    if (scen.open) runScenario();
    loadAlerts();
  } catch (e) {
    skeletons(false);
    err("Erreur de chargement : " + e.message);
  }
}

/* ---------------- modale Rithmic ---------------- */
let rithPoll = null, lastRithState = null;

async function openSettings() {
  $("modal-overlay").hidden = false;
  if (adminToken) await refreshSettings();
  rithPoll = setInterval(refreshSettings, 2500);
}
function closeSettings() {
  $("modal-overlay").hidden = true;
  clearInterval(rithPoll); rithPoll = null;
}

async function refreshSettings() {
  if (!adminToken) return;
  try {
    const r = await adminFetch("/api/rithmic");
    const j = await r.json();
    const cfg = j.config, st = j.status;

    // presets (une seule fois)
    const sel = $("rt-preset");
    if (sel.options.length <= 1) {
      for (const p of j.presets) {
        const o = document.createElement("option");
        o.value = p.system_name + "|" + p.url; o.textContent = p.label;
        sel.appendChild(o);
      }
    }
    const want = (cfg.system_name || "") + "|" + (cfg.url || "");
    if ([...sel.options].some((o) => o.value === want)) sel.value = want;
    // champs
    if (document.activeElement.id !== "rt-user") $("rt-user").value = cfg.user || "";
    $("rt-pass").placeholder = cfg.password ? "•••••••• (enregistré — vide = inchangé)" : "mot de passe";
    if (document.activeElement.id !== "rt-system") $("rt-system").value = cfg.system_name || "";
    if (document.activeElement.id !== "rt-url") $("rt-url").value = cfg.url || "";
    $("rt-appname").value = cfg.app_name || "";
    $("rt-appver").value = cfg.app_version || "";
    $("rt-auto").checked = !!(cfg.enabled && cfg.auto_connect);

    // mappings
    const tbody = $("rt-mappings").querySelector("tbody");
    const tabs = Object.keys(cfg.mappings);
    if (tbody.children.length !== tabs.length) {
      tbody.innerHTML = "";
      for (const t of tabs) {
        const m = cfg.mappings[t];
        const tr = document.createElement("tr");
        tr.dataset.tab = t;
        tr.innerHTML =
          `<td class="sym">${t}</td>` +
          `<td><input data-k="exchange" value="${m.exchange || ""}" style="width:78px"></td>` +
          `<td><input data-k="contract" value="${m.contract || ""}" placeholder="${m.root} (front month)" style="width:130px"></td>` +
          `<td><select data-k="mode" style="width:88px"><option value="direct"${m.mode === "direct" ? " selected" : ""}>direct</option><option value="anchor"${m.mode === "anchor" ? " selected" : ""}>anchor</option></select></td>` +
          `<td class="stat-col">—</td>`;
        tbody.appendChild(tr);
      }
    }
    // statut par contrat
    for (const tr of tbody.children) {
      const t = tr.dataset.tab;
      const m = cfg.mappings[t];
      const cur = (tr.querySelector("[data-k=exchange]"));
      if (document.activeElement !== cur) cur.value = m.exchange || "";
      const cc = tr.querySelector("[data-k=contract]");
      if (document.activeElement !== cc) cc.value = m.contract || "";
      const c = st.contracts[t];
      tr.lastElementChild.innerHTML = c && c.last_price != null
        ? `<span class="green">${c.contract} · ${c.last_price.toFixed(2)} · ${c.ticks} ticks</span>`
        : (st.state === "connected" ? `<span>${(c && c.contract) || "?"} · en attente…</span>` : "—");
    }

    // bannière statut
    const box = $("rith-status");
    box.className = "rstatus " + st.state;
    const labels = { disconnected: "Déconnecté", connecting: "Connexion en cours…", connected: "Connecté", error: "Erreur" };
    $("rs-state").textContent = labels[st.state] || st.state;
    $("rs-msg").textContent = st.message || "";
    const nC = Object.values(st.contracts).filter((c) => c.last_price != null).length;
    $("rs-contracts").textContent = st.state === "connected" ? `${nC}/${Object.keys(cfg.mappings).length} flux actifs` : "";

    if (lastRithState != null && st.state !== lastRithState) {
      if (st.state === "connected") toast("Rithmic connecté — ticks temps réel actifs", "ok");
      else if (st.state === "error") toast("Rithmic : " + (st.message || "erreur"), "err", 8000);
    }
    lastRithState = st.state;
  } catch (e) { $("rs-msg").textContent = e.message; }
}

function collectRithForm() {
  const mappings = {};
  for (const tr of $("rt-mappings").querySelector("tbody").children) {
    mappings[tr.dataset.tab] = {
      exchange: tr.querySelector("[data-k=exchange]").value.trim().toUpperCase(),
      contract: tr.querySelector("[data-k=contract]").value.trim().toUpperCase(),
      mode: tr.querySelector("[data-k=mode]").value,
    };
  }
  const body = {
    user: $("rt-user").value.trim(),
    system_name: $("rt-system").value.trim(),
    url: $("rt-url").value.trim(),
    app_name: $("rt-appname").value.trim(),
    app_version: $("rt-appver").value.trim(),
    enabled: $("rt-auto").checked,
    auto_connect: $("rt-auto").checked,
    mappings,
  };
  if ($("rt-pass").value) body.password = $("rt-pass").value;
  return body;
}

$("rt-preset").addEventListener("change", (e) => {
  if (!e.target.value) return;
  const [sys, url] = e.target.value.split("|");
  $("rt-system").value = sys; $("rt-url").value = url;
});
$("admin-token").addEventListener("change", (e) => { adminToken = e.target.value; refreshSettings(); });
$("settings-btn").addEventListener("click", openSettings);
$("modal-close").addEventListener("click", closeSettings);
$("modal-overlay").addEventListener("click", (e) => { if (e.target === $("modal-overlay")) closeSettings(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSettings(); });

$("rt-save").addEventListener("click", async () => {
  try {
  const r = await adminFetch("/api/rithmic/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(collectRithForm()) });
  if (r.ok) { toast("Configuration enregistrée", "ok", 2500); refreshSettings(); }
  else err("Échec de l'enregistrement");
  } catch (e) { err(e.message); }
});
$("rt-connect").addEventListener("click", async () => {
  try {
  const body = collectRithForm();
  body.enabled = true;
  const r = await adminFetch("/api/rithmic/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { err("Échec de l'enregistrement"); return; }
  await adminFetch("/api/rithmic/connect", { method: "POST" });
  toast("Connexion à Rithmic en cours…", "warn", 3000);
  $("rt-pass").value = "";
  refreshSettings();
  } catch (e) { err(e.message); }
});
$("rt-disconnect").addEventListener("click", async () => {
  try {
  await adminFetch("/api/rithmic/disconnect", { method: "POST" });
  refreshSettings();
  } catch (e) { err(e.message); }
});

/* ---------------- contrôles chart ---------------- */
document.querySelectorAll("#intervals button").forEach((b) =>
  b.addEventListener("click", async () => {
    document.querySelectorAll("#intervals button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.interval = b.dataset.iv;
    state.lastBar = null;   // évite qu'un tick pousse une bougie d'un autre TF pendant le fetch
    try { await loadHistory(); drawLevels(state.levels, state.profile); } catch (e) { err(e.message); }
    loadFlowBars();
    queueFlow();
  })
);
document.querySelectorAll("#win-seg button").forEach((b) =>
  b.addEventListener("click", async () => {
    document.querySelectorAll("#win-seg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.win = Number(b.dataset.w);
    localStorage.setItem("gex.win", String(state.win));
    try { await loadGex(); connectWS(); } catch (e) { err(e.message); }
  })
);
document.querySelectorAll("#lvl-toggles .ltgl").forEach((b) =>
  b.addEventListener("click", () => {
    const t = b.dataset.t;
    state.ltgl[t] = !state.ltgl[t];
    b.classList.toggle("active", !!state.ltgl[t]);
    localStorage.setItem("gex.ltgl", JSON.stringify(state.ltgl));
    if (t === "heat" && state.ltgl.heat) fetchHeat(true);
    drawLevels(state.levels, state.profile);
  })
);
document.querySelectorAll("#win-seg button").forEach((b) =>
  b.classList.toggle("active", Number(b.dataset.w) === state.win));
document.querySelectorAll("#lvl-toggles .ltgl").forEach((b) =>
  b.classList.toggle("active", !!state.ltgl[b.dataset.t]));
document.querySelectorAll("#filters button").forEach((b) =>
  b.addEventListener("click", async () => {
    document.querySelectorAll("#filters button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.filter = b.dataset.f;
    closeWS();
    clearScenario();
    try { await loadGex(); connectWS(); } catch (e) { err(e.message); }
  })
);

/* ---------------- boot ---------------- */

/* ================= v3 : thèmes, couleurs, architecture, vivant, dessin ================= */
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* ---------------- thèmes ---------------- */
const THEMES = ["midnight", "daylight", "oled", "phosphor"];
function applyTheme(th, save = true) {
  if (!THEMES.includes(th)) th = "midnight";
  document.documentElement.dataset.theme = th;
  document.querySelectorAll("#theme-seg button").forEach((b) => b.classList.toggle("active", b.dataset.th === th));
  if (save) localStorage.setItem("gex.theme", th);
  if (!localStorage.getItem("gex.colors")) {
    state.colors = { up: cssVar("--up"), down: cssVar("--down") };
    syncColorInputs();
  }
  applyCandleColors(false);
  rethemeChart();
}
function rethemeChart() {
  if (!state.chart) return;
  state.chart.applyOptions({
    layout: { textColor: cssVar("--muted") },
    grid: { vertLines: { color: cssVar("--grid") }, horzLines: { color: cssVar("--grid") } },
    rightPriceScale: { borderColor: cssVar("--border") },
    timeScale: { borderColor: cssVar("--border") },
    crosshair: { vertLine: { labelBackgroundColor: cssVar("--elev") }, horzLine: { labelBackgroundColor: cssVar("--elev") } },
  });
  queueGamma(); queueDraw(); drawHeroSpark();
}
document.querySelectorAll("#theme-seg button").forEach((b) =>
  b.addEventListener("click", () => applyTheme(b.dataset.th)));

/* ---------------- couleurs de bougies ---------------- */
function syncColorInputs() { $("ap-up").value = state.colors.up; $("ap-down").value = state.colors.down; }
function applyCandleColors(save = true) {
  if (save) localStorage.setItem("gex.colors", JSON.stringify(state.colors));
  state.candles?.applyOptions({
    upColor: state.colors.up, downColor: state.colors.down,
    wickUpColor: state.colors.up + "bf", wickDownColor: state.colors.down + "bf",
  });
  document.querySelectorAll("#candle-presets button").forEach((b) =>
    b.classList.toggle("active", b.dataset.up === state.colors.up && b.dataset.down === state.colors.down));
  refreshTabs(); drawHeroSpark();
}
$("ap-up").addEventListener("input", (e) => { state.colors.up = e.target.value; applyCandleColors(); });
$("ap-down").addEventListener("input", (e) => { state.colors.down = e.target.value; applyCandleColors(); });
document.querySelectorAll("#candle-presets button").forEach((b) =>
  b.addEventListener("click", () => { state.colors = { up: b.dataset.up, down: b.dataset.down }; syncColorInputs(); applyCandleColors(); }));

/* ---------------- spark du héro ---------------- */
let heroQueued = false;
function queueHeroSpark() { if (heroQueued) return; heroQueued = true; requestAnimationFrame(() => { heroQueued = false; drawHeroSpark(); }); }
function drawHeroSpark() {
  const cv = $("hero-spark"); if (!cv) return;
  const vals = state.sparks[state.symbol];
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H || !vals || vals.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const mn = Math.min(...vals), mx = Math.max(...vals), rg = (mx - mn) || 1;
  const up = vals[vals.length - 1] >= vals[0];
  const col = up ? state.colors.up : state.colors.down;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = (i / (vals.length - 1)) * W, y = H - 4 - ((v - mn) / rg) * (H - 10);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, col + "55"); g.addColorStop(1, col + "00");
  ctx.fillStyle = g; ctx.fill();
}

/* ---------------- sidebar : onglets, repli, zen ---------------- */
document.querySelectorAll("#sb-tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("#sb-tabs button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".sb-panel").forEach((pn) => pn.classList.toggle("active", pn.id === "sbp-" + b.dataset.p));
  }));
$("flow-src").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-src]");
  if (b) setFlowSrc(b.dataset.src);
});

/* Découverte R|Protocol : quels systèmes sert ce gateway, et quels gateways
   régionaux existent (templates 16 et 20). Chips cliquables pour remplir le
   formulaire — utile pour retrouver le couple system_name + URL d'un compte. */
async function discoverRithmic() {
  const btn = $("rt-discover"), out = $("rt-discover-out");
  const small = 'style="padding:2px 6px;font-size:9px;margin:2px"';
  btn.disabled = true;
  out.hidden = false;
  out.textContent = "interrogation du gateway…";
  const q = new URLSearchParams();
  const url = $("rt-url").value.trim(), system = $("rt-system").value.trim();
  if (url) q.set("url", url);
  if (system) q.set("system", system);
  try {
    const j = await (await adminFetch(`/api/rithmic/discover?${q}`)).json();
    if (j.error) { out.textContent = `échec : ${j.error}`; return; }
    const systems = j.systems || [], gws = j.gateways || [];
    out.innerHTML =
      `<div><b>${systems.length} systèmes</b> servis par ${j.url}</div>` +
      (systems.length ? `<div>` + systems.map((s) =>
        `<button class="btn" ${small} data-sys="${s}">${s}</button>`).join("") + `</div>` : "") +
      `<div style="margin-top:6px"><b>${gws.length} gateways R|Protocol</b></div>` +
      gws.map((g) => `<div><button class="btn" ${small} data-url="${g.uri.replace("wss://", "")}">${g.name}</button><span>${g.uri}</span></div>`).join("") +
      (j.gateway_error ? `<div style="margin-top:4px;color:var(--yellow)">${j.gateway_error}</div>` : "");
    out.querySelectorAll("button[data-sys]").forEach((b) =>
      b.addEventListener("click", () => { $("rt-system").value = b.dataset.sys; }));
    out.querySelectorAll("button[data-url]").forEach((b) =>
      b.addEventListener("click", () => { $("rt-url").value = b.dataset.url; }));
  } catch (e) {
    out.textContent = "échec : " + e.message;
  } finally {
    btn.disabled = false;
  }
}
$("rt-discover").addEventListener("click", discoverRithmic);
$("sb-collapse").addEventListener("click", () => {
  document.body.classList.toggle("sb-collapsed");
  $("sb-collapse").textContent = document.body.classList.contains("sb-collapsed") ? "▶" : "◀";
  queueGamma(); queueDraw();
});
$("zen-toggle").addEventListener("click", () => {
  document.body.classList.toggle("zen");
  $("zen-toggle").classList.toggle("active", document.body.classList.contains("zen"));
  queueGamma(); queueDraw(); drawHeroSpark();
});

/* ---------------- palette de commandes Ctrl+K ---------------- */
const cmdk = { open: false, items: [], sel: 0 };
function cmdkCommands() {
  const c = [];
  for (const sy of state.symbols || []) c.push({ label: `Aller sur ${sy.symbol}`, hint: "symbole", run: () => switchSymbol(sy.symbol) });
  for (const iv of ["1m", "5m", "15m", "30m", "1h", "1d"]) c.push({ label: `Intervalle ${iv}`, hint: "chart", run: () => document.querySelector(`#intervals button[data-iv="${iv}"]`)?.click() });
  for (const th of THEMES) c.push({ label: `Thème ${th}`, hint: "apparence", run: () => applyTheme(th) });
  c.push({ label: "Toggle pane GAMMA", hint: "chart", run: () => $("gp-toggle").click() });
  c.push({ label: "Toggle NIVEAUX (walls dans l'échelle)", hint: "chart", run: () => $("fit-toggle").click() });
  c.push({ label: "Ouvrir HEATMAP", hint: "chart", run: () => $("hm-toggle").click() });
  c.push({ label: "Ouvrir SCÉNARIO", hint: "chart", run: () => $("scen-toggle").click() });
  c.push({ label: "Mode zen", hint: "layout", run: () => $("zen-toggle").click() });
  c.push({ label: "Replier / déplier la sidebar", hint: "layout", run: () => $("sb-collapse").click() });
  c.push({ label: "Ouvrir Apparence / Rithmic", hint: "réglages", run: () => openSettings() });
  c.push({ label: "Rejouer le tour guidé", hint: "aide", run: () => startTour(true) });
  for (const t of ["trend", "ray", "hline", "vline", "rect", "fib"]) c.push({ label: `Outil dessin : ${t}`, hint: "dessin", run: () => setDrawTool(t) });
  return c;
}
function cmdkRender(filter = "") {
  const f = filter.toLowerCase();
  cmdk.items = cmdkCommands().filter((x) => x.label.toLowerCase().includes(f));
  cmdk.sel = 0;
  $("cmdk-list").innerHTML = cmdk.items.map((x, i) =>
    `<div class="cmdk-item${i === cmdk.sel ? " sel" : ""}" data-i="${i}">${x.label}<small>${x.hint}</small></div>`).join("") ||
    `<div class="cmdk-item muted">Aucune commande</div>`;
  $("cmdk-list").querySelectorAll(".cmdk-item[data-i]").forEach((el) =>
    el.addEventListener("click", () => cmdkRun(+el.dataset.i)));
}
function cmdkRun(i) { const it = cmdk.items[i]; cmdkClose(); if (it) it.run(); }
function cmdkOpen() { cmdk.open = true; $("cmdk").hidden = false; $("cmdk-input").value = ""; cmdkRender(); $("cmdk-input").focus(); }
function cmdkClose() { cmdk.open = false; $("cmdk").hidden = true; }
$("cmdk-input").addEventListener("input", (e) => cmdkRender(e.target.value));
$("cmdk-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cmdk.sel = (cmdk.sel + (e.key === "ArrowDown" ? 1 : -1) + cmdk.items.length) % cmdk.items.length;
    $("cmdk-list").querySelectorAll(".cmdk-item").forEach((el, i) => el.classList.toggle("sel", i === cmdk.sel));
    $("cmdk-list").children[cmdk.sel]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") cmdkRun(cmdk.sel);
});
$("cmdk").addEventListener("click", (e) => { if (e.target === $("cmdk")) cmdkClose(); });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); cmdk.open ? cmdkClose() : cmdkOpen(); }
  if (e.key === "Escape" && cmdk.open) cmdkClose();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && draw.shapes.length && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { e.preventDefault(); draw.shapes.pop(); draw.sel = -1; drawSave(); queueDraw(); }
});

/* ---------------- skeletons ---------------- */
function skeletons(on) {
  document.querySelectorAll(".tile-value").forEach((el) => el.classList.toggle("skel", on));
}

/* ---------------- tour guidé ---------------- */
const TOUR = [
  { sel: "#topbar", t: "Instruments & statut", d: "Chaque onglet affiche prix, variation et sparkline 5 min en direct. Le héro reprend le prix du symbole actif avec son régime gamma." },
  { sel: "#chart-toolbar", t: "Outils du chart", d: "GAMMA (pane gamma synchronisée), NIVEAUX (walls dans l'échelle), SCÉNARIO (chocs spot/IV), HEATMAP, ZEN… et la barre verticale à gauche du chart : outils de dessin." },
  { sel: "#chart-area", t: "Chart & pane gamma", d: "Zones ombrées = régime gamma par strike, histogramme à droite = GEX net, cône bleu = ±1σ de session. Dessine dessus : trendlines, fibres, zones — persistants par symbole." },
  { sel: "#sidebar", t: "Sidebar GEX", d: "Zone map, tiles de niveaux et profil par strike dans l'onglet GEX ; franchissements dans ALERTES ; flux d'ordres (gros trades, absorption) dans FLUX ; basis + carnet L2 dans FUTURES. Repliable via ◀." },
  { sel: "#statusbar", t: "Fraîcheur des données", d: "Countdown du prochain pull CBOE, âge de la chaîne et compteur de ticks. Ctrl+K ouvre la palette de commandes." },
];
let tourIdx = 0;
function startTour() { if (localStorage.getItem("gex.tour") && !arguments[0]) return; tourIdx = 0; $("tour").hidden = false; showTour(); }
function showTour() {
  const st = TOUR[tourIdx];
  const el = document.querySelector(st.sel);
  const hole = $("tour-hole"), card = $("tour-card");
  if (el) {
    const r = el.getBoundingClientRect();
    hole.style.left = (r.left - 4) + "px"; hole.style.top = (r.top - 4) + "px";
    hole.style.width = (r.width + 8) + "px"; hole.style.height = (r.height + 8) + "px";
    const below = r.bottom + 190 < innerHeight;
    card.style.left = Math.max(12, Math.min(innerWidth - 352, r.left)) + "px";
    card.style.top = (below ? r.bottom + 14 : Math.max(12, r.top - 190)) + "px";
  }
  $("tour-title").textContent = st.t; $("tour-text").textContent = st.d;
  $("tour-step").textContent = `${tourIdx + 1} / ${TOUR.length}`;
  $("tour-next").textContent = tourIdx === TOUR.length - 1 ? "Terminer ✓" : "Suivant →";
}
$("tour-next").addEventListener("click", () => { if (tourIdx < TOUR.length - 1) { tourIdx++; showTour(); } else endTour(); });
$("tour-skip").addEventListener("click", endTour);
function endTour() { $("tour").hidden = true; localStorage.setItem("gex.tour", "1"); }

/* ---------------- outils de dessin ---------------- */
const draw = { tool: "none", shapes: [], sel: -1, draft: null, drag: null, queued: false };
function drawLoad() { try { draw.shapes = JSON.parse(localStorage.getItem("gex.draw." + state.symbol)) || []; } catch { draw.shapes = []; } draw.sel = -1; }
function drawSave() { localStorage.setItem("gex.draw." + state.symbol, JSON.stringify(draw.shapes)); }
function setDrawTool(t) {
  draw.tool = t; draw.draft = null;
  document.querySelectorAll("#draw-bar button[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  const cv = $("draw-canvas");
  cv.className = t === "none" ? "idle" : (t === "cursor" ? "sel" : "drawing");
  if (t !== "cursor") { draw.sel = -1; $("draw-opts").hidden = true; }
  queueDraw();
}
document.querySelectorAll("#draw-bar button[data-tool]").forEach((b) =>
  b.addEventListener("click", () => setDrawTool(b.dataset.tool)));
$("draw-undo").addEventListener("click", () => { draw.shapes.pop(); draw.sel = -1; drawOptsSync(); drawSave(); queueDraw(); });
$("draw-clear").addEventListener("click", () => { draw.shapes = []; draw.sel = -1; $("draw-opts").hidden = true; drawSave(); queueDraw(); });
$("draw-del").addEventListener("click", () => drawDelete());
$("draw-dup").addEventListener("click", () => drawDuplicate());
$("draw-color").addEventListener("input", (e) => { if (draw.sel >= 0) { draw.shapes[draw.sel].color = e.target.value; drawSave(); queueDraw(); } });
$("draw-width").addEventListener("change", (e) => { if (draw.sel >= 0) { draw.shapes[draw.sel].width = +e.target.value; drawSave(); queueDraw(); } });
$("draw-opacity").addEventListener("input", (e) => {
  const v = +e.target.value;
  $("draw-opacity-val").textContent = v + "%";
  if (draw.sel >= 0) { draw.shapes[draw.sel].opacity = v / 100; drawSave(); queueDraw(); }
});

// --- édition : propriétés du tracé sélectionné ---------------------------------
function drawOpacity() { return +$("draw-opacity").value / 100; }
function drawOptsSync() {
  const sh = draw.shapes[draw.sel];
  $("draw-opts").hidden = !sh;
  if (!sh) return;
  $("draw-color").value = sh.color || "#22d3ee";
  $("draw-width").value = String(sh.width || 2);
  $("draw-opacity").value = String(Math.round((sh.opacity ?? 1) * 100));
  $("draw-opacity-val").textContent = Math.round((sh.opacity ?? 1) * 100) + "%";
}
function drawDelete() {
  if (draw.sel < 0) return;
  draw.shapes.splice(draw.sel, 1);
  draw.sel = -1; drawOptsSync(); drawSave(); queueDraw();
}
function drawDuplicate() {
  if (draw.sel < 0) return;
  const copy = JSON.parse(JSON.stringify(draw.shapes[draw.sel]));
  // décalage visible de 12 px en prix, pour que la copie ne se superpose pas
  const c = state.candles;
  const y0 = c?.priceToCoordinate(0), y1 = c?.priceToCoordinate(1);
  const perPx = (y0 != null && y1 != null) ? (y0 - y1) : 0;
  copy.pts = copy.pts.map((p) => ({ ...p, p: p.p == null ? p.p : p.p + perPx * 12 }));
  draw.shapes.push(copy);
  draw.sel = draw.shapes.length - 1;
  drawOptsSync(); drawSave(); queueDraw();
}
// raccourcis clavier : Suppr / Retour arrière suppriment, Échap désélectionne,
// Ctrl+D duplique — actifs tant qu'on n'écrit pas dans un champ
window.addEventListener("keydown", (e) => {
  const el = document.activeElement || {};
  const typing = el.tagName === "TEXTAREA" || el.tagName === "SELECT" ||
    (el.tagName === "INPUT" && !["range", "checkbox", "radio", "button"].includes(el.type));
  if (typing) return;   // le curseur d'opacité reste pilotable aux flèches
  if (draw.sel < 0) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); drawDelete(); }
  else if (e.key === "Escape") { draw.sel = -1; drawOptsSync(); queueDraw(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); drawDuplicate(); }
});

function drawPt(e) {
  const r = $("draw-canvas").getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function drawTP(x, y) {   // pixels -> {t, p}
  const t = state.chart.timeScale().coordinateToTime(x);
  const p = state.candles.coordinateToPrice(y);
  return { t: t ?? state.lastBar?.time ?? null, p };
}
function drawXY(pt) {     // {t,p} -> pixels
  if (pt.t == null || pt.p == null) return null;
  const x = state.chart.timeScale().timeToCoordinate(pt.t);
  const y = state.candles.priceToCoordinate(pt.p);
  return x == null || y == null ? null : { x, y };
}
function shapePts(sh) { return (sh.pts || []).map(drawXY).filter(Boolean); }
function hitShape(x, y) {
  for (let i = draw.shapes.length - 1; i >= 0; i--) {
    const ps = shapePts(draw.shapes[i]);
    if (!ps.length) continue;
    const tol = 7;
    if (draw.shapes[i].tool === "hline") { if (Math.abs(y - ps[0].y) < tol) return i; continue; }
    if (draw.shapes[i].tool === "vline") { if (Math.abs(x - ps[0].x) < tol) return i; continue; }
    if (draw.shapes[i].tool === "rect" && ps.length === 2) {
      const [a, b] = ps;
      if (x > Math.min(a.x, b.x) - tol && x < Math.max(a.x, b.x) + tol && y > Math.min(a.y, b.y) - tol && y < Math.max(a.y, b.y) + tol) return i;
      continue;
    }
    for (let k = 0; k < ps.length - 1; k++) {
      const a = ps[k], b = ps[k + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const d = Math.abs((b.x - a.x) * (a.y - y) - (a.x - x) * (b.y - a.y)) / L;
      if (d < tol && Math.min(a.x, b.x) - tol <= x && x <= Math.max(a.x, b.x) + tol) return i;
    }
    if (ps.length === 1 && Math.hypot(ps[0].x - x, ps[0].y - y) < tol) return i;
  }
  return -1;
}
function hitHandle(x, y) {
  if (draw.sel < 0) return -1;
  const ps = shapePts(draw.shapes[draw.sel]);
  for (let k = 0; k < ps.length; k++) if (Math.hypot(ps[k].x - x, ps[k].y - y) < 8) return k;
  return -1;
}
(function drawEvents() {
  const cv = $("draw-canvas");
  cv.addEventListener("pointerdown", (e) => {
    const { x, y } = drawPt(e);
    if (draw.tool === "cursor") {
      const h = hitHandle(x, y);
      if (h >= 0) { draw.drag = { kind: "handle", h }; }
      else { const i = hitShape(x, y); draw.sel = i; drawOptsSync();
        if (i >= 0) draw.drag = { kind: "move", y0: y, p0: draw.shapes[i].pts.map((p) => p.p) }; }
      queueDraw(); cv.setPointerCapture(e.pointerId); return;
    }
    if (draw.tool === "none") return;
    const pt = drawTP(x, y);
    if (["hline", "vline"].includes(draw.tool)) {
      draw.shapes.push({ tool: draw.tool, pts: [pt], color: $("draw-color").value, width: +$("draw-width").value, opacity: drawOpacity() });
      drawSave(); queueDraw(); return;
    }
    draw.draft = { tool: draw.tool, pts: [pt, pt], color: $("draw-color").value, width: +$("draw-width").value, opacity: drawOpacity() };
    cv.setPointerCapture(e.pointerId); queueDraw();
  });
  cv.addEventListener("pointermove", (e) => {
    const { x, y } = drawPt(e);
    if (draw.drag && draw.sel >= 0) {
      const sh = draw.shapes[draw.sel];
      if (draw.drag.kind === "handle") { sh.pts[draw.drag.h] = drawTP(x, y); }
      else { const dp = state.candles.coordinateToPrice(y) - state.candles.coordinateToPrice(draw.drag.y0);
        sh.pts = sh.pts.map((p, i) => ({ ...p, p: draw.drag.p0[i] + dp })); draw.drag.y0 = y; draw.drag.p0 = sh.pts.map((p) => p.p); }
      drawSave(); queueDraw(); return;
    }
    if (draw.draft) { draw.draft.pts[1] = drawTP(x, y); queueDraw(); }
  });
  cv.addEventListener("pointerup", () => {
    if (draw.draft) {
      const [a, b] = draw.draft.pts;
      if (a.t !== b.t || a.p !== b.p) draw.shapes.push(draw.draft);
      draw.draft = null; drawSave(); queueDraw();
    }
    draw.drag = null;
  });
})();
function queueDraw() { if (draw.queued) return; draw.queued = true; requestAnimationFrame(() => { draw.queued = false; drawRender(); }); }
function drawRender() {
  const cv = $("draw-canvas");
  if (!state.chart || !state.candles) return;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  ctx.font = "700 9.5px 'JetBrains Mono', monospace";
  const all = draw.draft ? [...draw.shapes, draw.draft] : draw.shapes;
  all.forEach((sh, i) => {
    const ps = shapePts(sh);
    if (!ps.length) return;
    const col = sh.color || "#22d3ee", lw = sh.width || 2;
    const op = Math.min(1, Math.max(0.05, sh.opacity ?? 1));   // opacité réglable
    const isSel = i === draw.sel;
    ctx.globalAlpha = op;
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.setLineDash([]);
    const label = (x, y, txt) => {
      const w = ctx.measureText(txt).width + 8;
      ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x, y - 8, w, 15, 4); ctx.fill();
      ctx.fillStyle = "#0b0e14"; ctx.fillText(txt, x + 4, y + 3);
    };
    if (sh.tool === "hline") {
      ctx.beginPath(); ctx.moveTo(0, ps[0].y); ctx.lineTo(W, ps[0].y); ctx.stroke();
      label(6, ps[0].y - 4, fmtPrice(ps[0].p ?? state.candles.coordinateToPrice(ps[0].y)));
    } else if (sh.tool === "vline") {
      ctx.beginPath(); ctx.moveTo(ps[0].x, 0); ctx.lineTo(ps[0].x, H); ctx.stroke();
    } else if (sh.tool === "trend" && ps.length === 2) {
      ctx.beginPath(); ctx.moveTo(ps[0].x, ps[0].y); ctx.lineTo(ps[1].x, ps[1].y); ctx.stroke();
      label(ps[1].x + 6, ps[1].y, fmtPrice(sh.pts[1].p));
    } else if (sh.tool === "ray" && ps.length === 2) {
      const dx = ps[1].x - ps[0].x || 1, dy = ps[1].y - ps[0].y;
      const k = (W - ps[0].x) / dx;
      ctx.beginPath(); ctx.moveTo(ps[0].x, ps[0].y); ctx.lineTo(ps[0].x + dx * k, ps[0].y + dy * k); ctx.stroke();
    } else if (sh.tool === "rect" && ps.length === 2) {
      const [a, b] = ps;
      ctx.fillStyle = col;
      ctx.globalAlpha = op * 0.12;   // remplissage homothétique à l'opacité
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.globalAlpha = op;
      ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else if (sh.tool === "fib" && ps.length === 2) {
      const [a, b] = ps; const p0 = sh.pts[0].p, p1 = sh.pts[1].p;
      const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
      [0, .236, .382, .5, .618, .786, 1].forEach((r) => {
        const y = a.y + (b.y - a.y) * r;
        ctx.setLineDash(r === 0 || r === 1 ? [] : [5, 4]);
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
        ctx.fillStyle = col; ctx.fillText((r * 100).toFixed(1) + " %  " + fmtPrice(p0 + (p1 - p0) * r), x1 + 4, y - 3);
      });
      ctx.setLineDash([]);
    }
    if (isSel) {
      ctx.globalAlpha = 1;           // poignées toujours lisibles
      ctx.fillStyle = col;
      ps.forEach((q) => { ctx.beginPath(); ctx.rect(q.x - 4, q.y - 4, 8, 8); ctx.fill(); ctx.strokeStyle = "#0b0e14"; ctx.lineWidth = 1; ctx.stroke(); ctx.strokeStyle = col; ctx.lineWidth = lw; });
    }
    ctx.globalAlpha = 1;
  });
}

window.state = state;   // debug/introspection
(async function boot() {
  await (window.gexAccessReady || Promise.resolve());
  applyTheme(localStorage.getItem("gex.theme") || "midnight", false);
  try { const cc = JSON.parse(localStorage.getItem("gex.colors")); if (cc) { state.colors = cc; syncColorInputs(); } } catch {}
  updateMarketStatus();
  await refreshTabs();
  if (!$("tabs").children.length) {
    err("Le serveur charge les chaînes d'options… nouvelle tentative dans 5 s");
    setMode("DELAYED");
    setTimeout(boot, 5000);
    return;
  }
  await loadSymbol();
  renderRules();
  drawLoad(); queueDraw();
  if (!localStorage.getItem("gex.tour")) setTimeout(startTour, 900);
  setInterval(refreshTabs, 10000);
  setInterval(() => { if (CRYPTO.has(state.symbol)) loadDerivs(); }, 60000);
  setInterval(renderReaction, 30000);
})();
