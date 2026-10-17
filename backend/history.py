"""Historical OHLCV candles (Yahoo Finance pour les actions, Deribit pour BTC)
avec cache disque."""
from __future__ import annotations

import asyncio
import json
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx

import deribit

ET = ZoneInfo("America/New_York")
YF_SYMBOLS = {
    "SPX": "^SPX", "SPY": "SPY", "QQQ": "QQQ", "GLD": "GLD", "NDX": "^NDX",
    "ES": "ES=F", "NQ": "NQ=F", "GC": "GC=F",
}
INTERVALS = {
    "1m":  ("1m", "7d", False),
    "5m":  ("5m", "5d", False),
    "15m": ("15m", "1mo", False),
    "30m": ("30m", "60d", False),
    "1h":  ("60m", "6mo", False),
    "1d":  ("1d", "2y", True),   # daily bars keyed by ET date string
}
# BTC : pas de contrat Yahoo, on prend le perp Deribit (cotation 24/7)
CRYPTO_SYMBOLS = {"BTC"}
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
TTL = 300
CRYPTO_TTL = 60          # la crypto bouge en continu : cache plus court
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
URL = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval={iv}&range={rg}"


def _cache_path(symbol: str, interval: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, f"hist_{symbol}_{interval}.json")


def _sanitize(bars: list[dict]) -> list[dict]:
    """Écarte les bougies aberrantes du feed (glitch Yahoo / holes de séance) :
    un high/high fantôme (ex. 8 000 sur SPY) écraserait tout l'autoscale."""
    out = []
    for b in bars:
        o, h, l, c = b.get("open"), b.get("high"), b.get("low"), b.get("close")
        if c is None or o is None:
            continue
        if h is None or l is None or h < l or h <= 0 or l <= 0:
            h, l = max(o, c), min(o, c)
        if h > 1.8 * c or l < 0.55 * c:      # incohérent vs close du même bar
            h, l = max(o, c), min(o, c)
        b = dict(b, high=round(h, 2), low=round(l, 2))
        out.append(b)
    return out


async def fetch_history(symbol: str, interval: str = "1d") -> list[dict]:
    if interval not in INTERVALS:
        interval = "1d"
    path = _cache_path(symbol, interval)
    ttl = CRYPTO_TTL if symbol in CRYPTO_SYMBOLS else TTL
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < ttl:
        with open(path) as f:
            return _sanitize(json.load(f))

    if symbol in CRYPTO_SYMBOLS:
        try:
            bars = await asyncio.to_thread(deribit.fetch_candles, interval)
        except Exception:  # noqa: BLE001
            bars = []
        if bars:
            tmp = path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(bars, f)
            os.replace(tmp, path)
        return _sanitize(bars)

    yiv, yrg, daily = INTERVALS[interval]
    url = URL.format(sym=YF_SYMBOLS[symbol], iv=yiv, rg=yrg)
    async with httpx.AsyncClient(timeout=30, follow_redirects=True, headers=HEADERS) as c:
        r = await c.get(url)
        r.raise_for_status()
        res = r.json()["chart"]["result"][0]

    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    bars = []
    for i, t in enumerate(ts):
        o, h, l, cl = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if cl is None or o is None:
            continue
        if daily:
            key = datetime.fromtimestamp(t, ET).strftime("%Y-%m-%d")
        else:
            key = int(t)
        bars.append({
            "time": key,
            "open": round(o, 2), "high": round(h, 2),
            "low": round(l, 2), "close": round(cl, 2),
            "volume": int(q["volume"][i] or 0),
        })
    # de-dupe (keep last) and sort
    dedup = {}
    for b in bars:
        dedup[b["time"]] = b
    bars = [dedup[k] for k in sorted(dedup, key=str)]
    bars = _sanitize(bars)

    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(bars, f)
    os.replace(tmp, path)
    return bars


QUOTE_TTL = 120


def fetch_quote(symbol: str) -> dict:
    """Sync latest quote (price + prev close) from Yahoo meta — used for
    futures basis/ratio mapping. Cached 2 minutes."""
    path = os.path.join(CACHE_DIR, f"quote_{symbol}.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < QUOTE_TTL:
        with open(path) as f:
            return json.load(f)
    url = URL.format(sym=YF_SYMBOLS[symbol], iv="1m", rg="1d")
    with httpx.Client(timeout=30, follow_redirects=True, headers=HEADERS) as c:
        r = c.get(url)
        r.raise_for_status()
        meta = r.json()["chart"]["result"][0]["meta"]
    out = {
        "price": float(meta["regularMarketPrice"]),
        "prev_close": float(meta.get("regularMarketPreviousClose")
                            or meta.get("previousClose")
                            or meta["regularMarketPrice"]),
        "ts": meta.get("regularMarketTime"),
    }
    os.makedirs(CACHE_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f)
    os.replace(tmp, path)
    return out


if __name__ == "__main__":
    print(len(asyncio.run(fetch_history("SPX", "1d"))), "daily bars for SPX")