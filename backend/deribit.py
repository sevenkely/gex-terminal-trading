"""Deribit — données publiques BTC (chaîne d'options + tape temps réel).

Aucun compte, aucune clé : tout passe par l'API publique v2.

- chaîne d'options : `get_book_summary_by_currency` (OI, mark_iv, sous-jacent)
  joint à `get_instruments` (strike, échéance, type) → un `gex.Chain` construit
  comme ceux du CBOE, mais rafraîchi toutes les 30 s.
- temps réel (WS) : `deribit_price_index.btc_usd` (spot), tape perp
  `trades.BTC-PERPETUAL.100ms`, tape options `trades.option.BTC.100ms`.
  Les canaux `.raw` exigent une authentification, les canaux agrégés 100 ms non.
- bougies : `get_tradingview_chart_data` (mêmes intervalles que Yahoo côté actions).

Unités Deribit : les options sont cotées en BTC et l'OI est en contrats de 1 BTC
(d'où le multiplicateur 1 sur la chaîne) ; le perp a un contrat de 10 $ et son
`amount` de trade est déjà un notionnel USD.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time

import httpx

log = logging.getLogger("gex.deribit")

BASE = "https://www.deribit.com/api/v2/public/"
WS_URL = "wss://www.deribit.com/ws/api/v2"
HEADERS = {"User-Agent": "GexTerminal/1.0 (+deribit public api)"}
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
TTL = 30                      # fraîcheur de la chaîne (M) — options BTC bougent vite

PERP = "BTC-PERPETUAL"
INDEX = "btc_usd"
# intervalle app -> (résolution Deribit, profondeur en jours)
CHART_RES = {"1m": ("1", 7), "5m": ("5", 30), "15m": ("15", 60),
             "30m": ("30", 120), "1h": ("60", 365), "1d": ("1D", 900)}


# ------------------------------------------------------------------ REST utils
def _cache_path(symbol: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    return os.path.join(CACHE_DIR, f"chain_{symbol}.json")


def _get(method: str, tries: int = 4, **params) -> dict:
    """GET public avec quelques essais (le DNS de Deribit hoquette parfois)."""
    last: Exception | None = None
    for attempt in range(tries):
        try:
            with httpx.Client(timeout=25, headers=HEADERS) as c:
                r = c.get(BASE + method, params=params)
                r.raise_for_status()
                body = r.json()
            if "error" in body:
                raise RuntimeError(f"{method}: {body['error'].get('message')}")
            return body["result"]
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"deribit {method} KO: {last}")


# -------------------------------------------------------------------- chain
def _iv30(rows: list[dict], ts: float) -> float:
    """IV implicite ~30 j : moyenne pondérée par l'OI sur 20-40 jours."""
    import numpy as np
    near = [(r, (r["expiry_ms"] / 1000.0 - ts) / 86400.0) for r in rows
            if r.get("iv_pct") and r.get("oi")]
    sel = [(r, d) for r, d in near if 20.0 <= d <= 40.0] or \
          [(r, d) for r, d in near if 7.0 <= d <= 60.0]
    if not sel:
        ivs = [r["iv_pct"] for r in rows if r.get("iv_pct")]
        return float(np.median(ivs)) if ivs else 0.0
    w = np.asarray([r["oi"] for r, _ in sel], dtype=float)
    v = np.asarray([r["iv_pct"] for r, _ in sel], dtype=float)
    return float((v * w).sum() / w.sum()) if w.sum() else float(v.mean())


def fetch_chain(symbol: str = "BTC", force: bool = False) -> dict:
    """Chaîne d'options BTC + contexte perp/index, mise en cache 30 s."""
    path = _cache_path(symbol)
    if not force and os.path.exists(path) and time.time() - os.path.getmtime(path) < TTL:
        with open(path) as f:
            return json.load(f)

    ts = time.time()
    instruments = _get("get_instruments", currency=symbol, kind="option",
                       expired="false")
    summaries = _get("get_book_summary_by_currency", currency=symbol, kind="option")
    meta = {i["instrument_name"]: i for i in instruments}

    rows = []
    underlyings = []
    for s in summaries:
        m = meta.get(s.get("instrument_name") or "")
        if not m:
            continue
        oi = float(s.get("open_interest") or 0.0)
        if oi <= 0:
            continue
        iv = float(s.get("mark_iv") or 0.0)
        if iv <= 0:
            continue
        if s.get("underlying_price"):
            underlyings.append(float(s["underlying_price"]))
        rows.append({
            "instrument_name": m["instrument_name"],
            "strike": float(m["strike"]),
            "expiry_ms": float(m["expiration_timestamp"]),
            "is_call": m.get("option_type") == "call",
            "oi": oi,
            "iv_pct": iv,
            "mark_price": float(s.get("mark_price") or 0.0),
            "volume": float(s.get("volume") or 0.0),
            "volume_usd": float(s.get("volume_usd") or 0.0),
        })

    try:
        index_price = float(_get("get_index_price", index_name=INDEX)["index_price"])
    except Exception:  # noqa: BLE001
        index_price = sum(underlyings) / len(underlyings) if underlyings else 0.0
    try:
        perp = _get("get_book_summary_by_instrument", instrument_name=PERP)[0]
    except Exception:  # noqa: BLE001
        perp = {}

    raw = {
        "symbol": symbol,
        "ts_epoch": ts,
        "index_price": index_price,
        "perp": {k: perp.get(k) for k in
                 ("last", "high", "low", "mark_price", "price_change",
                  "open_interest", "volume", "current_funding",
                  "estimated_delivery_price")},
        "options": rows,
    }
    raw["iv30"] = _iv30(rows, ts)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(raw, f)
    os.replace(tmp, path)
    return raw


def recent_trades(kind: str = "option", count: int = 100, symbol: str = "BTC") -> list[dict]:
    """Derniers trades (amorce du tape au démarrage ; l'API est publique)."""
    res = _get("get_last_trades_by_currency", currency=symbol, kind=kind, count=count)
    return list(res.get("trades") or [])


# ------------------------------------------------------------------ candles
def fetch_candles(interval: str = "1d", instrument: str = PERP) -> list[dict]:
    """Bougies OHLCV Deribit, même format que history.fetch_history (Yahoo)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    res, days = CHART_RES.get(interval, CHART_RES["1d"])
    now = int(time.time() * 1000)
    out = _get("get_tradingview_chart_data", instrument_name=instrument,
               start_timestamp=now - days * 86400_000, end_timestamp=now,
               resolution=res)
    et = ZoneInfo("America/New_York")
    bars = []
    for i, t in enumerate(out.get("ticks") or []):
        o, h, l, c = (out["open"][i], out["high"][i], out["low"][i], out["close"][i])
        if c is None or o is None or c <= 0:
            continue
        key = (datetime.fromtimestamp(t / 1000, et).strftime("%Y-%m-%d")
               if interval == "1d" else int(t / 1000))
        bars.append({"time": key, "open": round(o, 2), "high": round(h, 2),
                     "low": round(l, 2), "close": round(c, 2),
                     "volume": round(float((out.get("volume") or [0] * len(out["ticks"]))[i] or 0), 4)})
    dedup = {b["time"]: b for b in bars}
    return [dedup[k] for k in sorted(dedup, key=str)]


# --------------------------------------------------------------- temps réel
class DeribitFeed:
    """Flux WS public : index BTC (spot), tape perp et tape options.

    Les callbacks sont appelés dans la boucle asyncio du serveur :
      on_price(px, ts)                         -> moteur de prix de l'onglet BTC
      on_trade(kind, ts, price, amount, side, instrument, index_price)
                                               -> moteur de flux (flow.py)
    """

    CHANNELS = [f"deribit_price_index.{INDEX}",
                f"trades.{PERP}.100ms",
                "trades.option.BTC.100ms"]

    def __init__(self) -> None:
        self.on_price = None
        self.on_trade = None
        self.price = 0.0
        self.status: dict = {
            "state": "init", "since": time.time(), "error": None,
            "connected_at": None, "last_msg": None, "reconnects": 0,
            "counts": {"index": 0, "perp": 0, "options": 0},
        }

    def _set_state(self, state: str, error: str | None = None) -> None:
        self.status.update(state=state, since=time.time(), error=error)

    async def run(self) -> None:
        backoff = 2.0
        while True:
            try:
                import websockets
                self._set_state("connecting")
                async with websockets.connect(WS_URL, ping_interval=20,
                                              ping_timeout=20, max_size=2 ** 22) as ws:
                    await ws.send(json.dumps({
                        "jsonrpc": "2.0", "id": 1, "method": "public/subscribe",
                        "params": {"channels": self.CHANNELS}}))
                    self.status.update(connected_at=time.time(), last_msg=time.time())
                    self._set_state("connected")
                    log.info("deribit connecté (%d canaux)", len(self.CHANNELS))
                    backoff = 2.0
                    await self._pump(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                msg = f"{type(exc).__name__}: {exc}"[:200]
                self.status["reconnects"] += 1
                self._set_state("error", msg)
                log.warning("deribit déconnecté (%s) — reconnexion dans %.0fs", msg, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _pump(self, ws) -> None:
        """Boucle de lecture + `public/test` quand le flux est calme."""
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=20)
            except asyncio.TimeoutError:
                await ws.send(json.dumps({"jsonrpc": "2.0",
                                          "id": int(time.time() * 1000) % 1_000_000,
                                          "method": "public/test"}))
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if msg.get("method") != "subscription":
                continue
            params = msg.get("params") or {}
            channel = params.get("channel") or ""
            data = params.get("data")
            self.status["last_msg"] = time.time()
            if channel.startswith("deribit_price_index"):
                self.status["counts"]["index"] += 1
                self._emit_price(data)
            elif channel.startswith("trades.option"):
                self.status["counts"]["options"] += 1
                self._emit_trades("options", data)
            elif channel.startswith("trades."):
                self.status["counts"]["perp"] += 1
                self._emit_trades("perp", data)

    def _emit_price(self, data) -> None:
        try:
            px = float(data["price"])
        except (TypeError, KeyError, ValueError):
            return
        self.price = px
        if self.on_price:
            self.on_price(px, float(data.get("timestamp", time.time() * 1000)) / 1000.0)

    def _emit_trades(self, kind: str, data) -> None:
        if not self.on_trade:
            return
        for t in (data if isinstance(data, list) else [data]):
            try:
                ts = float(t.get("timestamp", time.time() * 1000)) / 1000.0
                amount = float(t.get("amount") or t.get("contracts") or 0)
                if amount <= 0:
                    continue
                self.on_trade(kind, ts, float(t.get("price") or 0), amount,
                              t.get("direction"), t.get("instrument_name") or "",
                              float(t.get("index_price") or self.price or 0))
            except (TypeError, KeyError, ValueError):
                continue
