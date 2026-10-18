"""Historique du basis (future − cash) / ratio (future ÷ cash) via Yahoo."""
from __future__ import annotations

import asyncio
import time

import history

_cache: dict[tuple, tuple[float, list]] = {}
TTL = 300


async def basis_series(fut: str, src: str, kind: str,
                       interval: str = "5m") -> list[dict]:
    """Série alignée [{t, v}] du basis (additif) ou ratio (multiplicatif)
    entre le contrat future et son sous-jacent cash."""
    key = (fut, src, interval)
    now = time.time()
    if key in _cache and now - _cache[key][0] < TTL:
        return _cache[key][1]

    f_bars, s_bars = await asyncio.gather(
        history.fetch_history(fut, interval),
        history.fetch_history(src, interval),
    )
    s_map = {b["time"]: b["close"] for b in s_bars}
    out = []
    for b in f_bars:
        c = s_map.get(b["time"])
        if c is None or not c:
            continue
        v = (b["close"] - c) if kind == "basis" else (b["close"] / c)
        out.append({"t": b["time"], "v": round(v, 4), "future_price":b["close"],"cash_price":c})
    # downsample to <= 600 points
    if len(out) > 600:
        step = len(out) / 600.0
        out = [out[int(i * step)] for i in range(600)] + [out[-1]]
    _cache[key] = (now, out)
    return out


def synchronized_projection(future_quote: dict, cash_quote: dict, kind: str,
                            now: float | None = None, max_skew=60, max_age=1800) -> dict:
    """Never subtract prices observed at materially different times.

    Both quotes must originate from the same provider; callers must preserve
    instrument identity (Yahoo continuous != a verified Rithmic contract).
    """
    import math
    now = time.time() if now is None else now
    fp, cp = float(future_quote['price']), float(cash_quote['price'])
    ft, ct = float(future_quote['ts']), float(cash_quote['ts'])
    if not all(math.isfinite(x) for x in (fp, cp, ft, ct)) or min(fp, cp) <= 0:
        raise ValueError('invalid_projection_inputs')
    if max(ft, ct) > now+5 or now-min(ft, ct) > max_age:
        raise ValueError('stale_projection_inputs')
    if abs(ft-ct) > max_skew:
        raise ValueError('unsynchronized_projection_inputs')
    if kind not in ('basis','ratio'):
        raise ValueError('unknown_projection_kind')
    return dict(kind=kind, v=fp-cp if kind=='basis' else fp/cp,
                future_ts=ft, cash_ts=ct, qts=min(ft,ct), skew_seconds=abs(ft-ct),
                quote_provider='yahoo',
                future_instrument=future_quote.get('instrument'),
                cash_instrument=cash_quote.get('instrument'),
                contract_identity_verified=False,
                limitation='Yahoo continuous contract: equivalence to Rithmic delivery contract is not verified.')
