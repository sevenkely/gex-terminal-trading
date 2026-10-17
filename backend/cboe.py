"""CBOE delayed-quotes chain fetcher with on-disk cache (15-min freshness)."""
from __future__ import annotations

import json
import os
import time

import httpx

BASE = "https://cdn.cboe.com/api/global/delayed_quotes/options"
URLS = {
    "SPX": f"{BASE}/_SPX.json",
    "SPY": f"{BASE}/SPY.json",
    "QQQ": f"{BASE}/QQQ.json",
    "GLD": f"{BASE}/GLD.json",
    "NDX": f"{BASE}/_NDX.json",
}
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
TTL = 900  # 15 minutes, matches the CBOE delay cadence
HEADERS = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) GexTerminal/1.0"}


def _cache_path(symbol: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, f"chain_{symbol}.json")


def fetch_chain(symbol: str, force: bool = False) -> dict:
    """Return the raw CBOE JSON for `symbol`, using cache when fresh."""
    path = _cache_path(symbol)
    if not force and os.path.exists(path) and time.time() - os.path.getmtime(path) < TTL:
        with open(path) as f:
            return json.load(f)
    with httpx.Client(timeout=60, follow_redirects=True, headers=HEADERS) as c:
        r = c.get(URLS[symbol])
        r.raise_for_status()
        raw = r.json()
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(raw, f)
    os.replace(tmp, path)
    return raw
