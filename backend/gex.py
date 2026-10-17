"""
GEX Engine — Dealer Gamma Exposure computed from CBOE delayed option chains.

Methodology (standard SpotGamma-style convention):
  - Dealers are assumed LONG calls / SHORT puts (classic hedge-dealer model).
  - Per contract:  GEX = sign * gamma * OI * spot^2 * 0.01 * 100
      sign = +1 for calls, -1 for puts
      0.01 -> exposure to a 1% move in the underlying
      100  -> contract multiplier
  - Greeks are re-priced at any hypothetical spot with Black-Scholes using the
    IV from the feed, so walls / zero-GEX move live with the underlying price.
  - Options with no usable IV fall back to the feed gamma scaled by (S0/S)^2
    (these are deep ITM/OTM contracts with negligible gamma).
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from market_calendar import settlement_epoch
from pricing import model_inputs, rates_for

import numpy as np

ET = ZoneInfo("America/New_York")
RISK_FREE = 0.04                      # configurable
YEAR_SECONDS = 365.25 * 24 * 3600
OPT_RE = re.compile(r"^([A-Z]+?)(\d{6})([CP])(\d{8})$")
_SQRT_2PI = math.sqrt(2.0 * math.pi)

# expiry filters -> max calendar days to expiry (None = no limit)
FILTERS = {
    "all": None,
    "0dte": 0,        # expiring today (ET)
    "weekly": 7,
    "monthly": 35,
}


def _npdf(x: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * x * x) / _SQRT_2PI


def _expiry_epoch(yymmdd: str, am_settled: bool = False) -> float:
    """SPX standard root: AM settlement; SPXW/ETF: PM convention."""
    day = datetime(2000 + int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:6])).date()
    return settlement_epoch(day, am_settled)



@dataclass
class Chain:
    symbol: str
    spot: float                 # CBOE delayed snapshot price
    prev_close: float
    open: float
    high: float
    low: float
    iv30: float                 # percent, e.g. 12.7
    ts: str                     # snapshot time (ET, ISO)
    ts_epoch: float
    # per-contract arrays
    strike: np.ndarray
    is_call: np.ndarray
    oi: np.ndarray
    iv: np.ndarray              # decimal
    feed_gamma: np.ndarray
    exp_epoch: np.ndarray
    exp_days: np.ndarray        # calendar days to expiry at snapshot
    multiplier: float = 100.0   # taille du contrat (100 actions, 1 BTC chez Deribit)
    rate: float = 0.04
    dividend_yield: float = 0.0
    rate_curve: tuple = ()
    model_source: str = "assumed_flat_inputs"
    model_asof: float | None = None


def chain_from_cboe(symbol: str, raw: dict) -> Chain:
    data = raw["data"]
    ts_str = data.get("last_trade_time") or raw.get("timestamp") or ""
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        ts_epoch = (dt if dt.tzinfo else dt.replace(tzinfo=ET)).timestamp()
    except (ValueError,TypeError,AttributeError) as exc:
        raise ValueError("CBOE source timestamp missing/invalid; refusing fabricated freshness") from exc
    if not math.isfinite(ts_epoch) or ts_epoch > datetime.now(timezone.utc).timestamp()+5:
        raise ValueError("CBOE timestamp is future-dated")
    native_spot=float(data["current_price"])
    if not math.isfinite(native_spot) or native_spot<=0:
        raise ValueError("Invalid CBOE spot")

    strikes, calls, oi, iv, gam, exps = [], [], [], [], [], []
    for o in data["options"]:
        m = OPT_RE.match(o["option"])
        if not m:
            continue
        yymmdd, cp, k = m.group(2), m.group(3), int(m.group(4)) / 1000.0
        qty = float(o.get("open_interest") or 0.0)
        if not math.isfinite(qty) or qty <= 0:
            continue
        try:
            ee = _expiry_epoch(yymmdd, am_settled=m.group(1) in ("SPX", "NDX"))
        except ValueError:
            continue  # non-session expiry: never invent a settlement time
        if ee <= ts_epoch:      # already expired
            continue
        strikes.append(k)
        calls.append(cp == "C")
        oi.append(qty)
        iv_raw = float(o.get("iv") or 0.0)
        # CBOE IV is decimal: 1.8 means 180%, not 1.8%. Never infer units by value.
        iv.append(iv_raw if math.isfinite(iv_raw) and iv_raw > 0 else 0.0)
        feed_gamma=float(o.get("gamma") or 0.0)
        gam.append(feed_gamma if math.isfinite(feed_gamma) and feed_gamma>0 else 0.0)
        exps.append(ee)

    strike = np.asarray(strikes, dtype=np.float64)
    exp_epoch = np.asarray(exps, dtype=np.float64)
    return Chain(
        symbol=symbol,
        spot=float(data["current_price"]),
        prev_close=float(data.get("prev_day_close") or data["current_price"]),
        open=float(data.get("open") or data["current_price"]),
        high=float(data.get("high") or data["current_price"]),
        low=float(data.get("low") or data["current_price"]),
        iv30=float(data.get("iv30") or 0.0),
        ts=ts_str,
        ts_epoch=ts_epoch,
        strike=strike,
        is_call=np.asarray(calls, dtype=bool),
        oi=np.asarray(oi, dtype=np.float64),
        iv=np.asarray(iv, dtype=np.float64),
        feed_gamma=np.asarray(gam, dtype=np.float64),
        exp_epoch=exp_epoch,
        exp_days=(exp_epoch - ts_epoch) / 86400.0,
        **model_inputs(symbol, ts_epoch),
    )


def chain_from_deribit(symbol: str, raw: dict) -> Chain:
    """Chaîne d'options BTC (Deribit) → même structure que le CBOE.

    Le feed ne fournit pas de gamma par contrat : on re-price en BS à partir de
    la mark IV, comme pour les spots hypothétiques du heatmap. L'OI Deribit est
    en contrats de 1 BTC → multiplicateur 1 (au lieu de 100 actions).
    """
    ts_epoch = float(raw["ts_epoch"])
    if not math.isfinite(ts_epoch) or ts_epoch > datetime.now(timezone.utc).timestamp()+5:
        raise ValueError("Invalid Deribit timestamp")
    perp = raw.get("perp") or {}
    spot = float(raw.get("index_price") or perp.get("mark_price") or 0.0)
    if not math.isfinite(spot) or spot<=0:
        raise ValueError("Invalid Deribit index price")
    # variation 24 h du perp ramenée en points d'index (repris comme « J-1 »)
    chg = perp.get("price_change")
    prev = spot / (1.0 + float(chg) / 100.0) if chg not in (None, 0) else spot
    rows = raw.get("options") or []

    strike, calls, oi, iv, exps = [], [], [], [], []
    for r in rows:
        ee = float(r["expiry_ms"]) / 1000.0
        if ee <= ts_epoch:        # déjà expiré
            continue
        strike.append(float(r["strike"]))
        calls.append(bool(r["is_call"]))
        oi.append(float(r["oi"]))
        iv.append(float(r["iv_pct"]) / 100.0)
        exps.append(ee)

    exp_epoch = np.asarray(exps, dtype=np.float64)
    return Chain(
        symbol=symbol,
        spot=spot,
        prev_close=prev,
        open=float(perp.get("last") or prev),
        high=float(perp.get("high") or prev),
        low=float(perp.get("low") or prev),
        iv30=float(raw.get("iv30") or 0.0),
        ts=datetime.fromtimestamp(ts_epoch, ET).isoformat(timespec="seconds"),
        ts_epoch=ts_epoch,
        strike=np.asarray(strike, dtype=np.float64),
        is_call=np.asarray(calls, dtype=bool),
        oi=np.asarray(oi, dtype=np.float64),
        iv=np.asarray(iv, dtype=np.float64),
        feed_gamma=np.zeros(len(strike), dtype=np.float64),
        exp_epoch=exp_epoch,
        exp_days=(exp_epoch - ts_epoch) / 86400.0,
        multiplier=1.0,
        **model_inputs(symbol, ts_epoch),
    )


def _valuation_epoch(valuation_time: float | None) -> float:
    return datetime.now(timezone.utc).timestamp() if valuation_time is None else valuation_time


def _mask_for(chain: Chain, filt: str, valuation_time: float | None = None) -> np.ndarray:
    """Calendar filters at valuation time; never silently substitute another expiry.

    Equity dates use New York; Deribit expiries use UTC (08:00 settlement).
    Explicit valuation_time is required when reconstructing a past snapshot.
    """
    now = _valuation_epoch(valuation_time)
    max_days = FILTERS.get(filt)
    remaining = chain.exp_epoch - now
    keep = remaining > 0
    if max_days == 0:
        tz = timezone.utc if chain.symbol == "BTC" else ET
        day = datetime.fromtimestamp(now, tz).replace(hour=0, minute=0, second=0, microsecond=0)
        keep &= (chain.exp_epoch >= day.timestamp()) & (chain.exp_epoch < (day + timedelta(days=1)).timestamp())
    elif max_days is not None:
        keep &= remaining <= max_days * 86400
    return keep & (chain.oi > 0)


def _gamma_at(chain: Chain, spot: float, filt: str,
              valuation_time: float | None = None) -> tuple:
    """Vectorised BS gamma. Live time by default, explicit time for replay."""
    now = _valuation_epoch(valuation_time)
    T = (chain.exp_epoch - now) / YEAR_SECONDS
    mask = _mask_for(chain, filt, now)
    gamma = np.zeros(len(T))
    good = mask & (chain.iv > 1e-4)
    if good.any():
        K, vol = chain.strike[good], chain.iv[good]
        # Numerical floor only: expired contracts remain excluded by mask.
        t = np.maximum(T[good], 1.0 / YEAR_SECONDS)
        d1 = (np.log(spot / K) + (rates_for(chain, t) - chain.dividend_yield + 0.5 * vol * vol) * t) / (vol * np.sqrt(t))
        gamma[good] = np.exp(-chain.dividend_yield*t) * _npdf(d1) / (spot * vol * np.sqrt(t))
    fb = mask & (chain.iv <= 1e-4) & (chain.feed_gamma > 0)
    gamma[fb] = chain.feed_gamma[fb] * (chain.spot / spot) ** 2
    return mask, gamma, T


def gex_at(chain: Chain, spot: float, filt: str = "all",
           valuation_time: float | None = None) -> np.ndarray:
    """Per-contract dealer GEX ($ per 1% move) at a given spot."""
    valuation_time = _valuation_epoch(valuation_time)
    mask, gamma, _ = _gamma_at(chain, spot, filt, valuation_time)
    sign = np.where(chain.is_call, 1.0, -1.0)
    gex = np.zeros(len(gamma))
    gex[mask] = (sign[mask] * gamma[mask] * chain.oi[mask] * spot * spot
                 * 0.01 * chain.multiplier)
    return gex


def gex_matrix(chain: Chain, spots, filt: str = "all", chunk: int = 24):
    """Matrice (n_strikes × n_temps) du GEX net dealer, chaque colonne
    re-pricée en Black-Scholes au spot historique correspondant.
    (Reconstruction indicative : OI, IV et temps du snapshot constants.)"""
    mask = _mask_for(chain, filt, chain.ts_epoch)
    K = chain.strike[mask]
    iv = chain.iv[mask]
    oi = chain.oi[mask]
    fg = chain.feed_gamma[mask]
    isc = chain.is_call[mask]
    T = (chain.exp_epoch[mask] - chain.ts_epoch) / YEAR_SECONDS
    sign = np.where(isc, 1.0, -1.0)
    base = sign * oi * (chain.multiplier / 100.0)   # 0.01 * multiplicateur
    good = iv > 1e-4
    strikes = np.unique(K)
    idx = np.searchsorted(strikes, K)
    nS = len(strikes)
    spots = np.asarray(spots, dtype=np.float64)
    nT = len(spots)
    out = np.zeros((nS, nT))
    Kg, ivg, Tg = K[good], iv[good], T[good]
    sqrtT = np.sqrt(Tg)
    fb = (~good) & (fg > 0)
    for t0 in range(0, nT, chunk):
        S = spots[t0:t0 + chunk]
        d1 = (np.log(S[None, :] / Kg[:, None])
              + (rates_for(chain, Tg) - chain.dividend_yield + 0.5 * ivg ** 2)[:, None] * Tg[:, None]) \
            / (ivg[:, None] * sqrtT[:, None])
        g = np.zeros((len(K), len(S)))
        g[good] = np.exp(-chain.dividend_yield*Tg[:, None]) * _npdf(d1) / (S[None, :] * ivg[:, None] * sqrtT[:, None])
        if fb.any():
            g[fb] = fg[fb][:, None] * (chain.spot / S[None, :]) ** 2
        gex = base[:, None] * g * (S ** 2)[None, :]
        for j in range(g.shape[1]):
            out[:, t0 + j] = np.bincount(idx, weights=gex[:, j], minlength=nS)
    return strikes, out


def compute_profile(chain: Chain, spot: float, filt: str = "all",
                    compute_zero: bool = True, win: float = 0.03,
                    valuation_time: float | None = None) -> dict:
    """Full GEX profile aggregated by strike + key levels."""
    valuation_time = _valuation_epoch(valuation_time)
    mask, gamma, _ = _gamma_at(chain, spot, filt, valuation_time)
    sign = np.where(chain.is_call, 1.0, -1.0)
    gex = (sign[mask] * gamma[mask] * chain.oi[mask] * spot * spot * 0.01
           * chain.multiplier)

    K = chain.strike[mask]
    isc = chain.is_call[mask]
    oi = chain.oi[mask]

    strikes = np.unique(K)
    idx = np.searchsorted(strikes, K)
    n = len(strikes)
    ic, ip = idx[isc], idx[~isc]
    call_gex = np.bincount(ic, weights=gex[isc], minlength=n)
    put_gex = np.bincount(ip, weights=gex[~isc], minlength=n)
    call_oi = np.bincount(ic, weights=oi[isc], minlength=n)
    put_oi = np.bincount(ip, weights=oi[~isc], minlength=n)
    net = call_gex + put_gex

    out: dict = {
        "available": bool(mask.any()),
        "filtered_contracts": int(mask.sum()),
        "filtered_oi": float(chain.oi[mask].sum()),
        "valuation_time": valuation_time,
        "reason": None if mask.any() else (
            "Aucune option non expirée avec OI positif pour ce filtre. "
            "Le 0DTE ne contient que les échéances du jour (ET pour actions, UTC pour BTC). "
            "Après expiration, le week-end ou sans OI publié : aucun niveau à afficher."),
        "strikes": strikes.tolist(),
        "call_gex": call_gex.tolist(),
        "put_gex": put_gex.tolist(),
        "net_gex": net.tolist(),
        "call_oi": call_oi.tolist(),
        "put_oi": put_oi.tolist(),
    }

    # ---- key levels -------------------------------------------------------
    levels = compute_levels(chain, spot, filt, strikes, call_gex, put_gex,
                            net, call_oi, put_oi, compute_zero=compute_zero,
                            win=win, valuation_time=valuation_time)
    out.update(levels)
    return out


def compute_walls(strikes, call_gex, put_gex, call_oi, put_oi, net,
                  spot: float, win: float = 0.03, topn: int = 5) -> dict:
    """Niveaux facon plateformes pro (SpotGamma / MenthorQ / GEXBot).

    - call walls  : top `topn` strikes AU-DESSUS du spot, classes par call GEX
    - put walls   : top `topn` strikes EN-DESSOUS du spot, classes par |put GEX|
    - gamma flip  : computed separately from aggregate GEX vs hypothetical spot
    - max pain    : strike minimisant le payout total des option holders
    Le tout dans une fenetre +/- `win` autour du spot (defaut 3 %).
    """
    strikes = np.asarray(strikes, dtype=float)
    call_gex = np.asarray(call_gex, dtype=float)
    put_gex = np.asarray(put_gex, dtype=float)
    call_oi = np.asarray(call_oi, dtype=float)
    put_oi = np.asarray(put_oi, dtype=float)
    net = np.asarray(net, dtype=float)
    w = np.abs(strikes - spot) <= win * spot

    def _top(mask: np.ndarray, arr: np.ndarray, oi: np.ndarray, desc: bool):
        cand = np.where(mask)[0]
        if not len(cand):
            return []
        order = cand[np.argsort(arr[cand])]
        order = order[::-1] if desc else order
        return [{"strike": float(strikes[i]), "gex": float(arr[i]),
                 "oi": float(oi[i])} for i in order[:topn]]

    cm = w & (strikes > spot) & (call_gex > 0)
    if not cm.any(): cm = (strikes > spot) & (call_gex > 0)
    pm = w & (strikes < spot) & (put_gex < 0)
    if not pm.any(): pm = (strikes < spot) & (put_gex < 0)
    call_w = _top(cm, call_gex, call_oi, True)
    put_w = _top(pm, put_gex, put_oi, False)

    # Cumulative strike crossings are NOT a dealer gamma flip.
    flip = None
    pain_strike = max_pain(strikes, call_oi, put_oi)

    return {"call": call_w, "put": put_w, "flip": flip, "pain": pain_strike}


def max_pain(strikes, call_oi, put_oi) -> float | None:
    """Minimum option-holder payout, O(n log n), shared by all views."""
    k = np.asarray(strikes, dtype=float)
    if not len(k):
        return None
    order = np.argsort(k)
    k = k[order]
    c, p = np.asarray(call_oi, dtype=float)[order], np.asarray(put_oi, dtype=float)[order]
    cq, cv = np.cumsum(c), np.cumsum(c * k)
    pq, pv = np.cumsum(p), np.cumsum(p * k)
    payout = k * cq - cv + (pv[-1] - pv) - k * (pq[-1] - pq)
    return float(k[np.argmin(payout)])


def compute_levels(chain: Chain, spot: float, filt: str,
                   strikes=None, call_gex=None, put_gex=None, net=None,
                   call_oi=None, put_oi=None, compute_zero: bool = True,
                   win: float = 0.03, valuation_time: float | None = None) -> dict:
    if strikes is None:
        prof = compute_profile(chain, spot, filt, compute_zero=False, win=win, valuation_time=valuation_time)
        strikes = np.asarray(prof["strikes"])
        call_gex = np.asarray(prof["call_gex"])
        put_gex = np.asarray(prof["put_gex"])
        net = np.asarray(prof["net_gex"])
        call_oi = np.asarray(prof["call_oi"])
        put_oi = np.asarray(prof["put_oi"])

    net_total = float(net.sum())

    # walls structurels (gros OI, bande +/-10 %) : contexte swing uniquement
    def _oi_wall(oi_arr: np.ndarray, above: bool, band: float = 0.10):
        if above:
            cand = np.where((oi_arr > 0) & (strikes >= spot) & (strikes <= spot * (1 + band)))[0]
            if not len(cand):
                cand = np.where((oi_arr > 0) & (strikes >= spot))[0]
        else:
            cand = np.where((oi_arr > 0) & (strikes <= spot) & (strikes >= spot * (1 - band)))[0]
            if not len(cand):
                cand = np.where((oi_arr > 0) & (strikes <= spot))[0]
        if not len(cand):
            return None
        return float(strikes[cand[int(np.argmax(oi_arr[cand]))]])

    struct_call = _oi_wall(call_oi, True) if len(strikes) else None
    struct_put = _oi_wall(put_oi, False) if len(strikes) else None

    walls = compute_walls(strikes, call_gex, put_gex, call_oi, put_oi, net,
                          spot, win=win) if len(strikes) else {
        "call": [], "put": [], "flip": None, "pain": None}
    call_wall = walls["call"][0]["strike"] if walls["call"] else None
    put_wall = walls["put"][0]["strike"] if walls["put"] else None

    # gamma peaks (reference intraday)
    gamma_peak_call = float(strikes[int(np.argmax(call_gex))]) if len(strikes) and call_gex.max() > 0 else None
    gamma_peak_put = float(strikes[int(np.argmin(put_gex))]) if len(strikes) and put_gex.min() < 0 else None

    # expected move (1 sigma, daily) from IV30
    sigma_d = spot * (chain.iv30 / 100.0) / math.sqrt(365.0 if chain.symbol == "BTC" else 252.0) if chain.iv30 else 0.0

    zero = None
    if compute_zero and len(strikes):
        zero = _zero_gex(chain, spot, filt, valuation_time)

    walls["flip"] = zero
    return {
        "spot": spot,
        "net_gex_total": net_total,
        "regime": ("unavailable" if not len(strikes) or not (np.abs(call_gex).sum()+np.abs(put_gex).sum()) else
                   "neutral" if abs(net_total) < 1e-9 else
                   "long_gamma" if net_total > 0 else "short_gamma"),
        "call_wall": call_wall,
        "put_wall": put_wall,
        "struct_call": struct_call,
        "struct_put": struct_put,
        "walls": walls,
        "gamma_flip": zero,
        "max_pain": walls["pain"],
        "window_pct": win * 100,
        "gamma_peak_call": gamma_peak_call,
        "gamma_peak_put": gamma_peak_put,
        "zero_gex": zero,
        "em_sigma": sigma_d,
        "em_up": spot + sigma_d if len(strikes) else None,
        "em_down": spot - sigma_d if len(strikes) else None,
        "iv30": chain.iv30,
    }


def _zero_gex(chain: Chain, spot: float, filt: str,
              valuation_time: float | None = None) -> float | None:
    """Nearest spot level (to current) where aggregate dealer gamma flips sign."""
    valuation_time = _valuation_epoch(valuation_time)
    grid = spot * np.linspace(0.86, 1.14, 161)
    totals = np.empty(len(grid))
    for i, s in enumerate(grid):
        totals[i] = gex_at(chain, float(s), filt, valuation_time).sum()
    signs = np.sign(totals)
    nonzero = np.flatnonzero(totals != 0)
    brackets = [(int(a),int(b)) for a,b in zip(nonzero[:-1],nonzero[1:]) if np.sign(totals[a])*np.sign(totals[b])<0]
    if not brackets:
        return None  # underflow to zero in a tail is not a regime crossing
    # linear interpolation, pick crossing nearest current spot
    best, bestd = None, 1e18
    for i,j in brackets:
        s0, s1, t0, t1 = grid[i], grid[j], totals[i], totals[j]
        for _ in range(24):
            mid = (s0 + s1) / 2
            total = float(gex_at(chain, mid, filt, valuation_time).sum())
            if total == 0:
                s0 = s1 = mid
                break
            if np.sign(t0) * np.sign(total) < 0:
                s1 = mid
            else:
                s0, t0 = mid, total
        z = (s0 + s1) / 2
        d = abs(z - spot)
        if d < bestd:
            best, bestd = float(z), d
    return best
