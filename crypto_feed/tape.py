"""Flux d'ordres temps réel : Binance Futures (aggTrade) → Bybit (publicTrade).

Deux exchanges, un seul contrat normalisé :

    trade = {ts, price, qty, notional, buy}

`qty` est la taille en coin (BTC) ; `notional` = qty × prix en USD, c'est cette
unité qui sert aux seuils de gros trade / absorption (comparable entre BTC et
ETH, et insensible au prix).

Convention d'agression :
  - Binance `aggTrade.m` = true → l'acheteur est le taker, donc c'est une
    VENTE agressive. `buy = not m`.
  - Bybit v5 `publicTrade.S` = "Buy" / "Sell" → côté du taker directement.

Reconnexion : backoff exponentiel avec jitter, réabonnement complet à chaque
session. Si Binance répond 451 (restriction géographique) ou reste
injoignable, on bascule automatiquement sur Bybit sans redémarrer le process.
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import aiohttp
import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .config import Config

log = logging.getLogger("crypto_feed.tape")

TradeHandler = Callable[[dict[str, Any]], Awaitable[None] | None]
StatusHandler = Callable[[dict[str, Any]], Awaitable[None] | None]
DepthHandler = Callable[[dict[str, Any]], Awaitable[None] | None]


async def _maybe_await(value: Any) -> None:
    if asyncio.iscoroutine(value):
        await value


# --------------------------------------------------------------------- flux
class FlowState:
    """Delta, CVD, gros trades et absorptions — alimenté trade par trade."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.reset()

    # ------------------------------------------------------------- reset
    def reset(self) -> None:
        self.started = time.time()
        self.trades = 0
        self.volume = 0.0          # coin
        self.notional = 0.0        # USD
        self.buy_notional = 0.0
        self.sell_notional = 0.0
        self.session_delta = 0.0   # USD, jamais remis à zéro dans la session
        self.cvd = 0.0             # USD, remis à zéro selon cfg.cvd_reset
        self.cvd_bucket: int | None = None
        self.cvd_series: deque[dict[str, Any]] = deque(maxlen=240)
        self.big: deque[dict[str, Any]] = deque(maxlen=self.cfg.keep_events)
        self.absorb: deque[dict[str, Any]] = deque(maxlen=self.cfg.keep_events)
        self.last_price: float | None = None
        self.last_ts: float | None = None
        self._buy_seq = 0
        self._sell_seq = 0
        self._big_seq = 0
        self._abs_seq = 0
        self._last_absorb = {"buy": 0.0, "sell": 0.0}
        self._window: deque[tuple[float, float, bool, float]] = deque()
        self._vwap_num = 0.0
        self._vwap_den = 0.0

    # --------------------------------------------------------------- ingress
    def add(self, ts: float, price: float, qty: float, buy: bool) -> dict[str, Any] | None:
        """Ajoute un trade ; retourne l'événement d'absorption éventuel."""
        if price <= 0 or qty <= 0:
            return None
        notional = price * qty
        self.trades += 1
        self.volume += qty
        self.notional += notional
        self._vwap_num += price * qty
        self._vwap_den += qty
        signed = notional if buy else -notional
        self.session_delta += signed
        self.last_price = price
        self.last_ts = ts

        # ---- reset du CVD : par bougie (bucket) ou par session
        bucket = None
        if self.cfg.cvd_reset == "candle":
            bucket = int(ts // self.cfg.candle_seconds())
            if self.cvd_bucket is None:
                self.cvd_bucket = bucket
            elif bucket != self.cvd_bucket:
                if self.cvd != 0:
                    self.cvd_series.append({"t": self.cvd_bucket * self.cfg.candle_seconds(),
                                            "cvd": round(self.cvd, 2)})
                self.cvd_bucket = bucket
                self.cvd = 0.0
        self.cvd += signed

        if buy:
            self.buy_notional += notional
            self._buy_seq += 1
        else:
            self.sell_notional += notional
            self._sell_seq += 1

        # ---- gros trade (notionnel USD)
        if notional >= self.cfg.big_trade_usd:
            self._big_seq += 1
            self.big.append({
                "seq": self._big_seq, "ts": round(ts, 3), "price": price,
                "qty": qty, "notional": round(notional, 2), "buy": buy,
                "side": "buy" if buy else "sell",
            })

        return self._check_absorption(ts, price, notional, buy)

    def _check_absorption(self, ts: float, price: float, notional: float,
                          buy: bool) -> dict[str, Any] | None:
        """Volume agressif concentré + prix immobile ⇒ absorption."""
        w = self._window
        w.append((ts, price, notional, buy))
        horizon = ts - self.cfg.absorb_window_s
        while w and w[0][0] < horizon:
            w.popleft()
        if len(w) < 3:
            return None
        buy_vol = sum(x[2] for x in w if x[3])
        sell_vol = sum(x[2] for x in w if not x[3])
        lo = min(x[1] for x in w)
        hi = max(x[1] for x in w)
        rng_bps = (hi - lo) / price * 10_000 if price else 0.0
        if rng_bps > self.cfg.absorb_range_bps:
            return None
        side = "buy" if buy_vol >= sell_vol else "sell"
        vol = max(buy_vol, sell_vol)
        if vol < self.cfg.absorb_usd:
            return None
        if ts - self._last_absorb[side] < self.cfg.absorb_cooldown_s:
            return None
        self._last_absorb[side] = ts
        self._abs_seq += 1
        event = {
            "seq": self._abs_seq, "ts": round(ts, 3), "price": price,
            "side": side, "usd": round(vol, 2), "window_s": self.cfg.absorb_window_s,
            "range_bps": round(rng_bps, 2),
            "threshold_usd": self.cfg.absorb_usd,
        }
        self.absorb.append(event)
        return event

    # -------------------------------------------------------------- snapshot
    def snapshot(self) -> dict[str, Any]:
        return {
            "trades": self.trades,
            "volume": round(self.volume, 6),
            "notional": round(self.notional, 2),
            "buy_notional": round(self.buy_notional, 2),
            "sell_notional": round(self.sell_notional, 2),
            "delta_session": round(self.session_delta, 2),
            "delta": round(self.cvd, 2),
            "delta_mode": self.cfg.cvd_reset,
            "candle": self.cfg.cvd_candle if self.cfg.cvd_reset == "candle" else None,
            "cvd_bucket_ts": (self.cvd_bucket * self.cfg.candle_seconds()
                              if self.cvd_bucket is not None else None),
            "cvd_series": list(self.cvd_series),
            "vwap": round(self._vwap_num / self._vwap_den, 4) if self._vwap_den else None,
            "last_price": self.last_price,
            "last_ts": self.last_ts,
            "big_threshold_usd": self.cfg.big_trade_usd,
            "big": list(self.big),
            "absorb": list(self.absorb),
        }


# --------------------------------------------------------------------- carnet
class OrderBook:
    """Carnet L2 minimal : snapshot + deltas, contrôle des séquences."""

    def __init__(self, depth: int = 20) -> None:
        self.depth = depth
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}
        self.ts = 0.0
        self.update_id: int | None = None
        self.synced = False

    def apply_snapshot(self, bids: list[list[float]], asks: list[list[float]],
                       update_id: int | None = None) -> None:
        self.bids = {float(p): float(q) for p, q in bids if float(q) > 0}
        self.asks = {float(p): float(q) for p, q in asks if float(q) > 0}
        self.update_id = update_id
        self.ts = time.time()
        self.synced = True

    def apply_delta(self, bids: list[list[float]], asks: list[list[float]]) -> None:
        for p, q in bids:
            price, qty = float(p), float(q)
            if qty <= 0:
                self.bids.pop(price, None)
            else:
                self.bids[price] = qty
        for p, q in asks:
            price, qty = float(p), float(q)
            if qty <= 0:
                self.asks.pop(price, None)
            else:
                self.asks[price] = qty
        self.ts = time.time()

    def snapshot(self) -> dict[str, Any] | None:
        if not self.bids or not self.asks:
            return None
        bid_rows = sorted(self.bids.items(), reverse=True)[: self.depth]
        ask_rows = sorted(self.asks.items())[: self.depth]
        bid_vol = sum(q for _, q in bid_rows)
        ask_vol = sum(q for _, q in ask_rows)
        total = bid_vol + ask_vol
        best_bid, best_ask = bid_rows[0][0], ask_rows[0][0]
        mid = (best_bid + best_ask) / 2
        return {
            "ts": self.ts,
            "synced": self.synced,
            "bids": [[round(p, 4), round(q, 6)] for p, q in bid_rows],
            "asks": [[round(p, 4), round(q, 6)] for p, q in ask_rows],
            "bid_vol": round(bid_vol, 4),
            "ask_vol": round(ask_vol, 4),
            "imbalance": round((bid_vol - ask_vol) / total, 4) if total else 0.0,
            "spread_bps": round((best_ask - best_bid) / mid * 10_000, 4) if mid else None,
        }


# ------------------------------------------------------------------- websocket
class TapeFeed:
    """Superviseur des deux websockets, avec bascule automatique Binance → Bybit."""

    def __init__(self, cfg: Config, flow: FlowState) -> None:
        self.cfg = cfg
        self.flow = flow
        self.book = OrderBook(cfg.depth_levels) if cfg.depth_enabled else None
        self.status: dict[str, Any] = {
            "state": "starting", "source": None, "stream": None, "error": None,
            "connected_at": None, "last_msg_ts": None, "reconnects": 0,
            "fallback": False, "depth": bool(cfg.depth_enabled),
        }
        self._session: aiohttp.ClientSession | None = None
        self._fallback_reason: str | None = None
        #: streams muets récemment, avec l'horodatage de réautorisation.
        self.blocked: dict[str, float] = {}

    # ------------------------------------------------------------- transport
    async def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=10, connect=6))
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def _set_status(self, on_status: StatusHandler | None, **kw: Any) -> None:
        self.status.update(kw)
        if on_status:
            await _maybe_await(on_status(dict(self.status)))

    async def probe_binance(self) -> tuple[bool, str | None]:
        """Teste l'accessibilité avant d'ouvrir le WS (451 = pays bloqué)."""
        try:
            session = await self._http()
            async with session.get(f"{self.cfg.binance_rest}/fapi/v1/time") as resp:
                if resp.status == 451:
                    return False, "HTTP 451 — Binance restreint ce pays"
                if resp.status == 403:
                    return False, "HTTP 403 — Binance refuse la requête"
                if resp.status != 200:
                    return False, f"HTTP {resp.status} sur /fapi/v1/time"
                await resp.json(content_type=None)
                return True, None
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            return False, f"Binance injoignable ({type(exc).__name__})"

    # ------------------------------------------------------------------ run
    def targets(self) -> list[tuple[str, str | None]]:
        """Ordre d'essai : Binance (chaque stream) puis Bybit en secours."""
        out: list[tuple[str, str | None]] = []
        if self.cfg.source in ("auto", "binance"):
            out += [("binance", kind) for kind in self.cfg.binance_streams]
        if self.cfg.source == "bybit" or self.cfg.allow_bybit_fallback:
            out.append(("bybit", None))
        return out or [("bybit", None)]

    async def run(self, on_trade: TradeHandler | None = None,
                  on_status: StatusHandler | None = None,
                  on_depth: DepthHandler | None = None,
                  stop: asyncio.Event | None = None) -> None:
        """Boucle infinie : (re)connexion, streaming, backoff, bascule de source."""
        delay = self.cfg.reconnect_min_s
        plan = self.targets()
        idx = 0
        probe_ok = True
        probe_msg: str | None = None

        if any(src == "binance" for src, _ in plan) and self.cfg.source != "binance":
            probe_ok, probe_msg = await self.probe_binance()
            if not probe_ok:
                log.warning("Binance indisponible (%s)", probe_msg)
                self._fallback_reason = probe_msg
                await self._set_status(on_status, fallback=True, error=probe_msg)

        while not (stop and stop.is_set()):
            source, kind = plan[idx % len(plan)]
            label = f"{source}:{kind}" if kind else source
            if source == "binance" and not probe_ok:
                idx += 1
                continue
            until = self.blocked.get(label, 0.0)
            if until > time.time():
                idx += 1
                continue

            try:
                await self._set_status(on_status, state="connecting",
                                       source=source, stream=kind)
                handler = self._binance if source == "binance" else self._bybit
                got_data = await handler(kind, on_trade, on_status, on_depth, stop)
                if stop and stop.is_set():
                    break
                if got_data:
                    # des trades ont circulé : on reste sur cette source
                    delay = self.cfg.reconnect_min_s
                    self.blocked.pop(label, None)
                    raise ConnectionClosed(None, None)  # session terminée proprement
                # connecté mais muet : proxy qui filtre le flux
                self.blocked[label] = time.time() + self.cfg.retry_blocked_s
                if source == "binance":
                    self._fallback_reason = (f"stream {label} muet "
                                             f"({self.cfg.data_timeout_s:.0f}s sans donnée)")
                await self._set_status(on_status, state="reconnecting", stream=kind,
                                       error=self._fallback_reason)
                log.warning("%s : aucune donnée en %.0fs — stream suivant",
                            label, self.cfg.data_timeout_s)
                idx += 1
                continue
            except asyncio.CancelledError:
                raise
            except InvalidStatus as exc:
                status = exc.response.status_code
                self.blocked[label] = time.time() + self.cfg.retry_blocked_s
                await self._set_status(on_status, state="error", stream=kind,
                                       error=f"handshake HTTP {status} ({label})")
                log.warning("%s : handshake HTTP %s", label, status)
                if source == "binance" and status in (403, 451):
                    probe_ok = False
                    self._fallback_reason = f"HTTP {status} — Binance restreint ce pays"
                    await self._set_status(on_status, fallback=True,
                                           error=self._fallback_reason)
                idx += 1
                continue
            except (ConnectionClosed, OSError, asyncio.TimeoutError) as exc:
                await self._set_status(on_status, state="reconnecting", stream=kind,
                                       error=str(exc)[:200])
                log.warning("%s déconnecté : %s", label, exc)
            except Exception as exc:  # noqa: BLE001 — le superviseur ne doit jamais mourir
                await self._set_status(on_status, state="error", stream=kind,
                                       error=str(exc)[:200])
                log.exception("%s : erreur inattendue", label)
                self.blocked[label] = time.time() + self.cfg.retry_blocked_s
                idx += 1
                continue

            self.status["reconnects"] += 1
            if stop and stop.is_set():
                break
            jitter = random.uniform(0, delay * 0.3)
            log.info("reconnexion %s dans %.1fs", label, delay + jitter)
            try:
                if stop:
                    await asyncio.wait_for(stop.wait(), timeout=delay + jitter)
                    break
                await asyncio.sleep(delay + jitter)
            except asyncio.TimeoutError:
                pass
            delay = min(self.cfg.reconnect_max_s, delay * 2)

        await self._set_status(on_status, state="stopped")

    # --------------------------------------------------------------- Binance
    async def _binance(self, kind: str | None, on_trade: TradeHandler | None,
                       on_status: StatusHandler | None,
                       on_depth: DepthHandler | None,
                       stop: asyncio.Event | None) -> bool:
        """Stream Binance (`aggTrade` ou `trade`). Retourne True si des trades
        ont été reçus ; False si la connexion est restée muette (proxy filtrant)."""
        url = f"{self.cfg.binance_ws}/{self.cfg.binance_stream(kind)}"
        got_data = False
        log.info("Binance connecté : %s", url)
        async with websockets.connect(
                url, ping_interval=self.cfg.ws_ping_s, ping_timeout=self.cfg.ws_ping_s,
                open_timeout=15, max_queue=4096) as ws:
            await self._set_status(on_status, state="connected", source="binance",
                                   stream=kind, connected_at=time.time(), error=None)
            tasks = []
            if self.book is not None:
                tasks.append(asyncio.create_task(
                    self._binance_depth(on_depth, stop), name="binance-depth"))
            try:
                while not (stop and stop.is_set()):
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=self.cfg.data_timeout_s)
                    except asyncio.TimeoutError:
                        if got_data:
                            # silence prolongé après des données : simple veille
                            continue
                        return False
                    msg = json.loads(raw)
                    event = msg.get("e")
                    if event in ("aggTrade", "trade"):
                        got_data = True
                        self.status["last_msg_ts"] = time.time()
                        await self._emit(on_trade, self._binance_trade(msg, event))
                    elif msg.get("data") and isinstance(msg["data"], dict):
                        inner = msg["data"]          # flux combiné
                        if inner.get("e") in ("aggTrade", "trade"):
                            got_data = True
                            self.status["last_msg_ts"] = time.time()
                            await self._emit(on_trade, self._binance_trade(inner, inner["e"]))
            finally:
                for t in tasks:
                    t.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
        return got_data

    @staticmethod
    def _binance_trade(msg: dict[str, Any], event: str = "aggTrade") -> dict[str, Any]:
        price = float(msg["p"])
        qty = float(msg["q"])
        buy = not bool(msg["m"])          # m = acheteur maker ⇒ vente agressive
        return {
            "ts": float(msg["T"]) / 1000.0,
            "price": price, "qty": qty, "notional": round(price * qty, 4),
            "buy": buy, "source": "binance", "stream": event,
            "id": msg.get("a") or msg.get("t"),
        }

    async def _binance_depth(self, on_depth: DepthHandler | None,
                             stop: asyncio.Event | None) -> None:
        """Snapshot REST + flux `@depth@100ms`, avec contrôle des updateId."""
        url = f"{self.cfg.binance_ws}/{self.cfg.symbol.lower()}@depth@{self.cfg.depth_ms}ms"
        assert self.book is not None
        try:
            session = await self._http()
            async with session.get(f"{self.cfg.binance_rest}/fapi/v1/depth",
                                   params={"symbol": self.cfg.symbol, "limit": 1000}) as resp:
                snap = await resp.json(content_type=None)
            self.book.apply_snapshot(snap["bids"], snap["asks"], int(snap["lastUpdateId"]))
            buffered: list[dict[str, Any]] = []
            async with websockets.connect(url, ping_interval=self.cfg.ws_ping_s,
                                          ping_timeout=self.cfg.ws_ping_s,
                                          open_timeout=15) as ws:
                while not (stop and stop.is_set()):
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                    if msg.get("e") != "depthUpdate":
                        continue
                    first, last = int(msg["U"]), int(msg["u"])
                    if self.book.update_id is not None and last <= self.book.update_id:
                        continue
                    if (self.book.update_id is not None
                            and first > self.book.update_id + 1
                            and not self.book.synced):
                        buffered.append(msg)
                        continue
                    if (self.book.update_id is not None
                            and first > self.book.update_id + 1 and buffered):
                        log.warning("carnet Binance désynchronisé — resynchronisation")
                        self.book.synced = False
                        buffered.clear()
                        continue
                    self.book.apply_delta(msg["b"], msg["a"])
                    self.book.update_id = last
                    if on_depth and self.book.synced:
                        await _maybe_await(on_depth(self.book.snapshot() or {}))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("carnet Binance indisponible : %s", exc)
            self.book.synced = False

    # ----------------------------------------------------------------- Bybit
    async def _bybit(self, _kind: str | None, on_trade: TradeHandler | None,
                     on_status: StatusHandler | None,
                     on_depth: DepthHandler | None,
                     stop: asyncio.Event | None) -> bool:
        got_data = False
        args = [self.cfg.bybit_topic]
        if self.book is not None:
            args.append(self.cfg.bybit_depth_topic)
        log.info("Bybit connecté : %s (%s)", self.cfg.bybit_ws, ", ".join(args))
        async with websockets.connect(self.cfg.bybit_ws, ping_interval=None,
                                      open_timeout=15, max_queue=4096) as ws:
            await ws.send(json.dumps({"op": "subscribe", "args": args}))
            await self._set_status(on_status, state="connected", source="bybit",
                                   stream=None, connected_at=time.time(), error=None)
            last_ping = time.time()
            while not (stop and stop.is_set()):
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=self.cfg.data_timeout_s)
                except asyncio.TimeoutError:
                    if time.time() - last_ping > 18:
                        await ws.send(json.dumps({"op": "ping"}))
                        last_ping = time.time()
                    continue
                msg = json.loads(raw)
                if msg.get("op") == "subscribe" and not msg.get("success", True):
                    raise RuntimeError(f"abonnement Bybit refusé : {msg.get('ret_msg')}")
                topic = msg.get("topic", "")
                if topic == self.cfg.bybit_topic:
                    got_data = True
                    self.status["last_msg_ts"] = time.time()
                    for row in msg.get("data") or []:
                        await self._emit(on_trade, self._bybit_trade(row))
                elif topic == self.cfg.bybit_depth_topic and self.book is not None:
                    self._bybit_depth(msg, on_depth)
                elif msg.get("op") == "pong":
                    last_ping = time.time()
        return got_data

    @staticmethod
    def _bybit_trade(row: dict[str, Any]) -> dict[str, Any]:
        price = float(row["p"])
        qty = float(row["v"])
        return {
            "ts": float(row["T"]) / 1000.0,
            "price": price, "qty": qty, "notional": round(price * qty, 4),
            "buy": str(row.get("S", "")).lower() == "buy",
            "source": "bybit", "id": row.get("i"),
        }

    def _bybit_depth(self, msg: dict[str, Any], on_depth: DepthHandler | None) -> None:
        assert self.book is not None
        data = msg.get("data") or {}
        bids = data.get("b") or []
        asks = data.get("a") or []
        if msg.get("type") == "snapshot":
            self.book.apply_snapshot(bids, asks)
        else:
            self.book.apply_delta(bids, asks)
        if on_depth and self.book.synced:
            async def _push() -> None:
                await _maybe_await(on_depth(self.book.snapshot() or {}))
            asyncio.create_task(_push())

    # ------------------------------------------------------------------ util
    @staticmethod
    async def _emit(handler: TradeHandler | None, trade: dict[str, Any]) -> None:
        if handler:
            await _maybe_await(handler(trade))


def utc_iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None
