"""État partagé entre les deux pipelines (options et flux d'ordres).

Les deux coroutines tournent dans la même boucle asyncio : la « sécurité
thread » se résume donc à un `asyncio.Lock` autour de l'état mutable, et
`get_state()` renvoie toujours une copie profonde sérialisable en JSON. Aucun
appelant ne peut ainsi muter l'état par inadvertance, et un consommateur
(API HTTP, script, UI) peut lire un snapshot cohérent pendant que le tape écrit.
"""
from __future__ import annotations

import asyncio
import copy
import time
from datetime import datetime, timezone
from typing import Any

from .config import Config


class SharedState:
    """Snapshot cohérent de la chaîne d'options et du flux temps réel."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._lock = asyncio.Lock()
        self.options: dict[str, Any] | None = None
        self.options_error: str | None = None
        self.options_updated: float | None = None
        self.flow: dict[str, Any] = {}
        self.depth: dict[str, Any] | None = None
        self.feed: dict[str, Any] = {"state": "starting"}
        self.started = time.time()
        self.absorptions = 0
        self.big_trades = 0

    # ------------------------------------------------------------------ writes
    async def set_options(self, snapshot: Any) -> None:
        payload = snapshot.as_dict() if hasattr(snapshot, "as_dict") else dict(snapshot)
        async with self._lock:
            self.options = payload
            self.options_updated = time.time()
            self.options_error = None

    async def set_options_error(self, message: str) -> None:
        async with self._lock:
            self.options_error = message[:300]

    async def set_flow(self, snapshot: dict[str, Any]) -> None:
        async with self._lock:
            self.flow = snapshot

    async def set_feed(self, status: dict[str, Any]) -> None:
        async with self._lock:
            self.feed = dict(status)

    async def set_depth(self, snapshot: dict[str, Any]) -> None:
        async with self._lock:
            self.depth = snapshot or None

    async def note_events(self, trade: dict[str, Any] | None,
                          absorption: dict[str, Any] | None) -> None:
        async with self._lock:
            if trade:
                self.big_trades += 1
            if absorption:
                self.absorptions += 1

    # ------------------------------------------------------------------- reads
    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            return copy.deepcopy({
                "ts": time.time(),
                "ts_iso": datetime.now(timezone.utc).isoformat(),
                "config": {
                    "currency": self.cfg.currency,
                    "symbol": self.cfg.symbol,
                    "expiry_filter": self.cfg.expiry_filter,
                    "options_refresh_s": self.cfg.options_refresh_s,
                    "cvd_reset": self.cfg.cvd_reset,
                    "cvd_candle": self.cfg.cvd_candle,
                    "depth": self.cfg.depth_enabled,
                },
                "options": self.options,
                "options_error": self.options_error,
                "options_age_s": (round(time.time() - self.options_updated, 1)
                                  if self.options_updated else None),
                "flow": self.flow,
                "depth": self.depth,
                "feed": self.feed,
                "counters": {"absorptions": self.absorptions,
                             "big_trades": self.big_trades},
            })


_STATE: SharedState | None = None


def configure(cfg: Config) -> SharedState:
    """Crée (ou recrée) l'état singleton du module."""
    global _STATE
    _STATE = SharedState(cfg)
    return _STATE


async def get_state() -> dict[str, Any]:
    """Snapshot public : niveaux d'options + flux courant.

    >>> state = await get_state()
    >>> state["options"]["call_wall"]["strike"], state["flow"]["delta"]
    """
    if _STATE is None:
        raise RuntimeError("crypto_feed.state.configure() n'a pas été appelé")
    return await _STATE.snapshot()
