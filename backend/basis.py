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
        out.append({"t": b["time"], "v": round(v, 4)})
    # downsample to <= 600 points
    if len(out) > 600:
        step = len(out) / 600.0
        out = [out[int(i * step)] for i in range(600)] + [out[-1]]
    _cache[key] = (now, out)
    return out
