"""
Live price engine — pluggable tick source.

Modes (per symbol)
------------------
DELAYED : last source snapshot, frozen until refresh (default without live feed).
SIM     : explicit GEX_DEMO_MODE only, never an automatic failover.
RITHMIC / DERIBIT : external price ticks.
STALE   : missing external ticks (> EXTERNAL_STALE seconds), last price frozen.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from market_calendar import session_info

log = logging.getLogger("live_feed")

TICK_INTERVAL = 1.2          # seconds between simulated ticks
TRADING_SECONDS = 6.5 * 3600 # regular session length
TICKS_PER_DAY = TRADING_SECONDS / TICK_INTERVAL
EXTERNAL_STALE = 20          # seconds before an external feed is considered dead

ET = ZoneInfo("America/New_York")
FUTURES_SYMBOLS = {"ES", "NQ", "GC"}
CRYPTO_SYMBOLS = {"BTC"}          # 24 h / 24, 7 j / 7 : jamais « fermé »
EXTERNAL_MODES = ("RITHMIC", "DERIBIT")


def market_open(symbol: str, ts: float | None = None) -> bool:
    """Séance en cours pour ce symbole, en heure de New York : RTH pour le
    cash (lun-ven 9 h 30 - 16 h), quasi 24 h pour les futures CME (dim 18 h →
    ven 17 h, pause 17-18 h), toujours ouvert pour la crypto. Sert à figer les
    ticks SIM hors séance."""
    return session_info(symbol, ts)["open"]


class PriceEngine:
    def __init__(self) -> None:
        self.prices: dict[str, float] = {}
        self.base: dict[str, float] = {}        # CBOE delayed anchor
        self.sigma_daily: dict[str, float] = {} # from iv30
        self.last_tick: dict[str, float] = {}
        self.events: dict[str, asyncio.Event] = {}
        self.modes: dict[str, str] = {}         # SIM / RITHMIC per symbol
        self.external_ts: dict[str, float] = {}
        self.on_external = None

    # ------------------------------------------------------------------ setup
    def seed(self, symbol: str, price: float, iv30: float) -> None:
        self.base[symbol] = price
        if symbol not in self.prices:
            self.prices[symbol] = price
        self.sigma_daily[symbol] = max(iv30, 1.0) / 100.0 / math.sqrt(252.0)
        self.events.setdefault(symbol, asyncio.Event())
        self.modes.setdefault(symbol, "SIM" if os.getenv("GEX_DEMO_MODE", "").lower() in ("1", "true", "yes") else "DELAYED")

    def rebase(self, symbol: str, price: float, iv30: float) -> None:
        """Chain refresh: move the anchor; keep live price continuity."""
        self.seed(symbol, price, iv30)
        if self.mode_for(symbol) == "DELAYED":
            self.prices[symbol] = price

    # --------------------------------------------------------- external feed
    def set_external(self, symbol: str, price: float, ts: float,
                     mode: str = "RITHMIC") -> None:
        if not math.isfinite(price) or price <= 0 or not math.isfinite(ts) or ts>time.time()+5:
            return
        if ts < self.external_ts.get(symbol, 0):
            return  # ignore late/out-of-order ticks
        self.prices[symbol] = price
        self.external_ts[symbol] = ts
        self.modes[symbol] = mode
        self.last_tick[symbol] = ts
        if self.on_external is not None:
            self.on_external(symbol, price, ts, mode)
        ev = self.events.get(symbol)
        if ev:
            ev.set()

    def drop_external(self, symbol: str) -> None:
        self.external_ts.pop(symbol, None)
        self.modes[symbol] = "STALE"

    def mode_for(self, symbol: str) -> str:
        mode = self.modes.get(symbol, "DELAYED")
        if mode in EXTERNAL_MODES and time.time() - self.external_ts.get(symbol, 0) > EXTERNAL_STALE:
            return "STALE"
        return mode

    # ------------------------------------------------------------------- loop
    async def run_sim(self) -> None:
        rng = random.Random(1234)
        while True:
            for sym, px in list(self.prices.items()):
                if self.mode_for(sym) != "SIM":
                    continue                   # real ticks drive this symbol
                if not market_open(sym):
                    # hors séance : prix figé (pas de dérive SIM trompeuse),
                    # mais le flux continue pour tenir l'horloge UI à jour
                    self.last_tick[sym] = time.time()
                    ev = self.events.get(sym)
                    if ev:
                        ev.set()
                    continue
                sd = self.sigma_daily.get(sym, 0.005)
                per_tick = sd / math.sqrt(TICKS_PER_DAY)
                # random walk + weak mean reversion to the delayed anchor
                drift = 0.0004 * (self.base.get(sym, px) - px)
                new = px * (1.0 + rng.gauss(0.0, per_tick)) + drift
                self.prices[sym] = max(new, 0.01)
                self.last_tick[sym] = time.time()
                ev = self.events.get(sym)
                if ev:
                    ev.set()
            await asyncio.sleep(TICK_INTERVAL)

    # ------------------------------------------------------------------ reads
    async def wait_tick(self, symbol: str, timeout: float = 5.0) -> float:
        ev = self.events.setdefault(symbol, asyncio.Event())
        try:
            await asyncio.wait_for(ev.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        ev.clear()
        return self.prices.get(symbol, self.base.get(symbol, 0.0))

    def price(self, symbol: str) -> float:
        return self.prices.get(symbol, self.base.get(symbol, 0.0))
