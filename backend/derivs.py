"""
Dérivés par échéance — structure par terme, skew 25Δ, OI et max pain.

Utilisé par `GET /api/derivs/{symbol}` : pour chaque échéance présente dans la
chaîne (Deribit pour BTC, CBOE sinon) on renvoie

  - l'IV ATM (interpolée en log-strike entre les deux strikes encadrant le spot),
  - le skew 25Δ (IV du put 25Δ − IV du call 25Δ, en points de vol),
  - l'open interest call / put et le max pain de l'échéance.

Les grecques sont calculées en Black-Scholes à taux nul (r = q = 0), ce qui est
l'usage sur les chaînes crypto et reste négligeable sur des échéances courtes
pour les futures actions.
"""
from __future__ import annotations

import math

import numpy as np

YEAR = 365.0


def _ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_delta(spot: float, strike: float, t_years: float, vol: float,
             is_call: bool) -> float:
    """Delta Black-Scholes (r = 0) : N(d1) call, N(d1) − 1 put."""
    if spot <= 0 or strike <= 0 or t_years <= 0 or vol <= 0:
        return 0.0
    s = vol * math.sqrt(t_years)
    d1 = (math.log(spot / strike) + 0.5 * vol * vol * t_years) / s
    return _ncdf(d1) if is_call else _ncdf(d1) - 1.0


def _atm_iv(strikes: np.ndarray, ivs: np.ndarray, spot: float) -> float | None:
    """IV au strike le plus proche, interpolée en log-strike si on l'encadre."""
    ok = (ivs > 0.01) & (ivs < 5.0) & (strikes > 0)
    if not ok.any():
        return None
    k, v = strikes[ok], ivs[ok]
    order = np.argsort(k)
    k, v = k[order], v[order]
    if spot <= k[0]:
        return float(v[0])
    if spot >= k[-1]:
        return float(v[-1])
    hi = int(np.searchsorted(k, spot))
    lo = max(0, hi - 1)
    if k[hi] <= k[lo]:
        return float(v[hi])
    w = (math.log(spot) - math.log(k[lo])) / (math.log(k[hi]) - math.log(k[lo]))
    return float(v[lo] + (v[hi] - v[lo]) * w)


def _delta_iv(strikes: np.ndarray, ivs: np.ndarray, deltas: np.ndarray,
              target: float) -> float | None:
    """IV du contrat dont le delta est le plus proche de `target`."""
    ok = np.isfinite(deltas) & (ivs > 0.01) & (ivs < 5.0)
    if not ok.any():
        return None
    d, v = np.abs(deltas[ok]), ivs[ok]
    i = int(np.argmin(np.abs(d - abs(target))))
    if abs(d[i] - abs(target)) > 0.18:      # trop loin du 25Δ : pas exploitable
        return None
    return float(v[i])


def _max_pain(strikes: np.ndarray, call_oi: np.ndarray,
              put_oi: np.ndarray) -> float | None:
    """Strike qui minimise le payout total des détenteurs d'options."""
    if not len(strikes):
        return None
    k = np.asarray(strikes, dtype=float)
    d = k[None, :] - k[:, None]            # (candidat, strike contrat)
    payout = (np.clip(d, 0, None) * call_oi[None, :]
              + np.clip(-d, 0, None) * put_oi[None, :]).sum(axis=1)
    if not np.isfinite(payout).any():
        return None
    return float(k[int(np.argmin(payout))])


def expiry_table(chain, spot: float, max_rows: int = 12) -> list[dict]:
    """Une ligne par échéance, triée par maturité croissante."""
    exp = np.asarray(chain.exp_epoch, dtype=float)
    days = np.asarray(chain.exp_days, dtype=float)
    by_exp: dict[float, list[int]] = {}
    for i, e in enumerate(exp):
        by_exp.setdefault(float(e), []).append(i)

    rows: list[dict] = []
    for e, idx in by_exp.items():
        idx_arr = np.asarray(idx, dtype=int)
        k = np.asarray(chain.strike, dtype=float)[idx_arr]
        is_c = np.asarray(chain.is_call, dtype=bool)[idx_arr]
        iv = np.asarray(chain.iv, dtype=float)[idx_arr]
        oi = np.asarray(chain.oi, dtype=float)[idx_arr]
        dte = float(days[idx_arr[0]])
        t = max(dte, 1.0 / 24.0) / YEAR

        deltas = np.array([bs_delta(spot, float(kk), t, float(vv), bool(cc))
                           for kk, vv, cc in zip(k, iv, is_c)])
        calls = is_c
        puts = ~is_c
        iv_call25 = _delta_iv(k[calls], iv[calls], deltas[calls], 0.25)
        iv_put25 = _delta_iv(k[puts], iv[puts], deltas[puts], 0.25)
        skew = (iv_put25 - iv_call25) * 100.0 if (iv_call25 and iv_put25) else None

        # max pain : OI par strike (call et put additionnés sur l'échéance)
        uniq = np.unique(k)
        c_oi = np.zeros_like(uniq)
        p_oi = np.zeros_like(uniq)
        for kk, cc, vv in zip(k, calls, oi):
            j = int(np.searchsorted(uniq, kk))
            if cc:
                c_oi[j] += vv
            else:
                p_oi[j] += vv

        rows.append({
            "expiry": int(e),
            "dte": round(dte, 2),
            "atm_iv": round(_atm_iv(k, iv, spot) or 0.0, 4) or None,
            "skew_25d": round(skew, 2) if skew is not None else None,
            "call_iv_25d": round(iv_call25 * 100, 2) if iv_call25 else None,
            "put_iv_25d": round(iv_put25 * 100, 2) if iv_put25 else None,
            "call_oi": float(oi[calls].sum()),
            "put_oi": float(oi[puts].sum()),
            "max_pain": _max_pain(uniq, c_oi, p_oi),
        })

    rows.sort(key=lambda r: r["dte"])
    return rows[:max_rows]


def payload(chain, spot: float) -> dict:
    rows = expiry_table(chain, spot)
    if not rows:
        return {"available": False, "reason": "aucune échéance dans la chaîne"}
    # skew « front » : moyenne pondérée des 3 premières échéances liquides
    live = [r for r in rows if r["skew_25d"] is not None][:3]
    front = sum(r["skew_25d"] for r in live) / len(live) if live else None
    atm = next((r["atm_iv"] for r in rows if r["atm_iv"]), None)
    total_c = sum(r["call_oi"] for r in rows)
    total_p = sum(r["put_oi"] for r in rows)
    return {
        "available": True,
        "spot": spot,
        "expiries": rows,
        "skew_25d": round(front, 2) if front is not None else None,
        "atm_iv": round(atm * 100, 2) if atm else None,
        "call_oi": total_c,
        "put_oi": total_p,
        "put_call_oi": round(total_p / total_c, 3) if total_c else None,
    }
