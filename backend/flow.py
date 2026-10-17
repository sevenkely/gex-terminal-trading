"""
Order-flow indicators — big trades, absorption, delta cumulé.

Alimenté par les ticks LAST_TRADE de Rithmic (async_rithmic) : prix, taille,
aggressor (1 = BUY, 2 = SELL). Sans compte Rithmic il n'y a pas de tape réel :
les indicateurs restent indisponibles (les ticks SIM n'ont pas de carnet).

Heuristiques (simples et assumées) :
  - gros trade  : taille >= max(MIN_BIG, K_BIG × taille médiane glissante) ;
  - absorption  : volume agressif cumulé sur une fenêtre courte (WINDOW s)
                  >= max(ABSORB_MIN, ABSORB_K × médiane) alors que le prix n'a
                  pas bougé de plus de RANGE_TICKS ticks -> les ordres passifs
                  absorbent l'agression (cooldown par côté) ;
  - delta       : somme signée du volume agressif (achats − ventes), séance ET.

Le médian glissant est recalculé au plus une fois par seconde (les prints CME
peuvent dépasser 100/s sur ES).
"""
from __future__ import annotations

import statistics
import math
import time
import threading
import logging
import re
from collections import deque
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")

WINDOW = 6.0            # fenêtre d'absorption (secondes)
MED_WINDOW = 300        # échantillons pour la médiane des tailles
MIN_BIG = 10            # taille minimale d'un « gros » trade
K_BIG = 8.0             # ou K_BIG × taille médiane
ABSORB_MIN = 40         # volume agressif minimal sur la fenêtre
ABSORB_K = 12.0         # ou ABSORB_K × taille médiane
ABSORB_COOLDOWN = 25.0  # secondes entre deux absorptions du même côté
RANGE_TICKS = 2.0       # mouvement maximal du prix pour parler d'absorption
TICK_SIZES = {"ES": 0.25, "NQ": 0.25, "GC": 0.1}

# Bougies d'agrégation du tape : delta agressif, volume et OHLC par intervalle.
# Elles alimentent la bande delta/CVD sous le graphique (GET /api/flow/{sym}/bars).
BAR_PERIODS: dict[str, int] = {"30s": 30, "1m": 60, "5m": 300, "15m": 900,
                               "30m": 1800, "1h": 3600, "1d": 86400}
# Cash Yahoo hourly bars start at :30, unlike the UTC-aligned crypto hour.
BAR_BUCKETS = {**BAR_PERIODS, "1h@1800": 3600}
BAR_HISTORY = 420        # bougies conservées par intervalle et par contrat

# Calibration par instrument. Pour la crypto, la « taille » d'un print est un
# notionnel USD (perp Deribit) ou la prime payée en USD (options), donc les
# seuils sont en dollars et non en contrats.
# Seuils BTC calibrés sur 500 prints réels mesurés (Deribit, jour calme) :
#   perp    : p50 = 0,5 k$ · p90 = 8,2 k$ · p99 = 22,7 k$ (notionnel USD) →
#             min_big 15 k$ (~p98) et absorption 50 k$ agressifs en 6 s ;
#   options : p50 = 81 $ · p90 = 1,7 k$ · p99 = 40 k$ (prime payée) →
#             min_big 5 k$ (~p96) et absorption 25 k$ de prime en 6 s.
CALIB: dict[str, dict] = {
    "ES": {"tick": 0.25},
    "BTC-PERPETUAL": {"tick": 0.5, "min_big": 15_000, "k_big": 8.0,
                      "absorb_min": 50_000, "absorb_k": 10.0, "unit": "USD"},
    "BTC-OPTIONS": {"tick": 0.5, "min_big": 5_000, "k_big": 20.0,
                    "absorb_min": 25_000, "absorb_k": 20.0, "unit": "USD"},
}   # BTC-OPTIONS : la « taille » = prime payée (contrats × prix × index)
DEFAULT_CALIB = {"tick": 0.25, "min_big": MIN_BIG, "k_big": K_BIG,
                 "absorb_min": ABSORB_MIN, "absorb_k": ABSORB_K,
                 "unit": "contrats"}


def calib_for(symbol: str, kind: str = "perp") -> dict:
    out = dict(DEFAULT_CALIB)
    out["tick"] = TICK_SIZES.get(symbol, out["tick"])
    out.update(CALIB.get(symbol, {}))
    out.update(CALIB.get(f"{symbol}-OPTIONS", {}) if kind == "options" else {})
    return out


class SymbolFlow:
    """Flux d'un contrat (résolution fine : key = (exchange, contract))."""

    def __init__(self, symbol: str, kind: str = "perp") -> None:
        self.symbol = symbol
        self.kind = kind
        self.root = next((root for root in TICK_SIZES
                          if symbol == root or re.fullmatch(re.escape(root) + r"[FGHJKMNQUVXZ]\d{1,2}", symbol)), symbol)
        calib = calib_for(self.root, kind)
        self.tick = calib["tick"]
        self.min_big = calib["min_big"]
        self.k_big = calib["k_big"]
        self.absorb_min = calib["absorb_min"]
        self.absorb_k = calib["absorb_k"]
        self.unit = calib["unit"]
        self.trade_ids = deque(maxlen=4096)
        self.sizes: deque[float] = deque(maxlen=MED_WINDOW)
        self.recent: deque[tuple[float, float, float, str | None]] = deque()
        self.big: deque[dict] = deque(maxlen=40)
        self.absorb: deque[dict] = deque(maxlen=20)
        self._median = 1.0
        self._median_ts = 0.0
        self._big_seq = 0
        self._absorb_seq = 0
        self._last_absorb: dict[str, float] = {"buy": 0.0, "sell": 0.0}
        self.coverage_start: float | None = None
        self.bars: dict[str, deque] = {k: deque(maxlen=BAR_HISTORY) for k in BAR_BUCKETS}
        self.cur_bar: dict[str, dict] = {}
        self.reset_session("")

    # ------------------------------------------------------------- session
    def reset_session(self, day: str) -> None:
        self.day = day
        self.delta = 0.0
        self.buy_vol = 0.0
        self.sell_vol = 0.0
        self.volume = 0.0
        self.trades = 0
        self.big.clear()
        self.absorb.clear()
        self.last_price: float | None = None
        self.last_ts: float | None = None
        self.recent.clear()
        self.sizes.clear()
        self._median = 1.0
        self._median_ts = 0.0
        self._last_absorb = {"buy":0.0, "sell":0.0}

    def _median_size(self, now: float) -> float:
        if now - self._median_ts > 1.0 and self.sizes:
            self._median = statistics.median(self.sizes)
            self._median_ts = now
        return self._median

    # ----------------------------------------------------------------- add
    def add(self, ts: float, price: float, size: float, aggressor: int,
            instrument: str | None = None) -> None:
        if not all(math.isfinite(v) for v in (ts, price, size)) or price <= 0 or size <= 0:
            return
        if self.last_ts is not None and ts < self.last_ts:
            return  # do not rewrite closed bars or reset session with a late print
        if self.symbol.startswith("BTC"):
            day = datetime.fromtimestamp(ts, timezone.utc).date().isoformat()
        else:
            dt = datetime.fromtimestamp(ts, ET)
            day = (dt.date() + timedelta(days=1) if self.root in TICK_SIZES and dt.hour >= 18 else dt.date()).isoformat()
        if day != self.day:
            self.reset_session(day)

        self.trades += 1
        self.volume += size
        self.last_price = price
        self.last_ts = ts
        side = "buy" if aggressor == 1 else "sell" if aggressor == 2 else None
        if side:
            self.delta += size if side == "buy" else -size
            if side == "buy":
                self.buy_vol += size
            else:
                self.sell_vol += size
        if size > 0:
            self.sizes.append(size)

        if self.coverage_start is None:
            self.coverage_start = ts
        self._add_bar(ts, price, size, side)

        med = self._median_size(ts)
        thr = max(self.min_big, round(self.k_big * med))
        if size >= thr:
            self._mark("big", size, side)
            self._big_seq += 1
            self.big.append({
                "seq": self._big_seq, "ts": round(ts, 3), "price": price,
                "size": size, "side": side, "threshold": thr,
                "instrument": instrument,
            })

        # ---- absorption : volume agressif concentré, prix immobile
        self.recent.append((ts, price, size, side))
        while self.recent and ts - self.recent[0][0] > WINDOW:
            self.recent.popleft()
        if len(self.recent) >= 3:
            buy_vol = sell_vol = 0.0
            lo = hi = price
            for _t, p, s, sd in self.recent:
                if sd == "buy":
                    buy_vol += s
                elif sd == "sell":
                    sell_vol += s
                lo = min(lo, p)
                hi = max(hi, p)
            rng = hi - lo
            limit = max(self.absorb_min, round(self.absorb_k * med))
            for sd, vol in (("buy", buy_vol), ("sell", sell_vol)):
                if vol < limit:
                    continue
                if rng > RANGE_TICKS * self.tick:
                    continue
                if ts - self._last_absorb[sd] < ABSORB_COOLDOWN:
                    continue
                self._last_absorb[sd] = ts
                self._mark("abs", vol, sd)
                self._absorb_seq += 1
                self.absorb.append({
                    "seq": self._absorb_seq, "ts": round(ts, 3), "price": price,
                    "side": sd, "volume": vol, "window_s": WINDOW,
                    "threshold": limit, "instrument": instrument,
                })

    def _mark(self, kind: str, size: float, side: str | None) -> None:
        """Accumulate once per detection, not once per snapshot/poll.

        These bounded candle summaries outlive the small recent-event deques.
        Absorption is assigned to its detection candle (not back-distributed to
        the individual execution candles in the lookback window). Same-side
        windows are disjoint because cooldown 25s > lookback 6s.
        """
        for cur in self.cur_bar.values():
            cur[kind + "_n"] = cur.get(kind + "_n", 0) + 1
            cur[kind + "_total"] = cur.get(kind + "_total", 0.) + size
            key = kind + "_" + (side if side in ("buy", "sell") else "unknown")
            cur[key] = cur.get(key, 0.) + size

    # --------------------------------------------------------------- bougies
    def _add_bar(self, ts: float, price: float, size: float, side: str | None) -> None:
        """Agrège le print dans chaque intervalle (OHLC + delta agressif)."""
        for name, secs in BAR_BUCKETS.items():
            if name == "1d":
                # Date label of the CME trading session (UTC calendar for BTC).
                start = datetime.fromisoformat(self.day).replace(tzinfo=timezone.utc).timestamp()
            elif name == "1h@1800":
                start = ((ts - 1800) // secs) * secs + 1800
            else:
                start = ts - (ts % secs)
            cur = self.cur_bar.get(name)
            if cur is None or cur["t"] != start:
                if cur is not None:
                    self.bars[name].append(cur)
                cur = self.cur_bar[name] = {
                    "t": start, "o": price, "h": price, "l": price, "c": price,
                    "buy": 0.0, "sell": 0.0, "vol": 0.0, "n": 0,
                }
            cur["h"] = max(cur["h"], price)
            cur["l"] = min(cur["l"], price)
            cur["c"] = price
            cur["vol"] += size
            cur["n"] += 1
            if side == "buy":
                cur["buy"] += size
            elif side == "sell":
                cur["sell"] += size

    def bars_snapshot(self, interval: str = "5m", limit: int = 240) -> list[dict]:
        """Bougies closes + la bougie en cours, avec delta et CVD cumulé.

        Le CVD est cumulé **sur la fenêtre retournée** (il repart de zéro au bord
        gauche), pour que la ligne soit lisible telle quelle côté client.
        """
        secs = BAR_BUCKETS.get(interval, 300)
        rows = list(self.bars.get(interval, ()))[-max(1, limit):]
        cur = self.cur_bar.get(interval)
        if cur is not None:
            rows = rows + [cur]
        rows = rows[-max(1, limit):]
        out: list[dict] = []
        cvd = 0.0
        for b in rows:
            delta = b["buy"] - b["sell"]
            cvd += delta
            out.append({
                "t": b["t"], "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"],
                "buy": round(b["buy"], 4), "sell": round(b["sell"], 4),
                "vol": round(b["vol"], 4), "n": b["n"],
                "delta": round(delta, 4), "cvd": round(cvd, 4),
                "interval_s": secs,
                **{k: b.get(k, 0) for k in (
                    "big_n", "big_total", "big_buy", "big_sell", "big_unknown",
                    "abs_n", "abs_total", "abs_buy", "abs_sell")},
            })
        return out

    # ------------------------------------------------------------ snapshot
    def snapshot(self) -> dict:
        return {
            "symbol": self.symbol,
            "kind": self.kind,
            "unit": self.unit,
            "tick": self.tick,
            "day": self.day,
            "delta": self.delta,
            "buy_vol": self.buy_vol,
            "sell_vol": self.sell_vol,
            "volume": self.volume,
            "trades": self.trades,
            "median_size": round(self._median, 2),
            "big_threshold": max(self.min_big, round(self.k_big * self._median)),
            "window_s": WINDOW,
            "big": list(self.big),
            "absorb": list(self.absorb),
            "last_price": self.last_price,
            "last_ts": self.last_ts,
            "coverage_start": self.coverage_start,
        }


class OrderFlowEngine:
    """Un SymbolFlow par contrat Rithmic (exchange, contract)."""

    def __init__(self, store=None) -> None:
        self.store = store
        self.lock = threading.RLock()
        self.checkpoint_lock = threading.Lock()
        self.persistence_error = None
        self.last_checkpoint = None
        self.restore_error = None
        self.restored_contracts = 0
        self._versions = {}
        self._saved_versions = {}
        self.by_contract: dict[tuple, SymbolFlow] = {}
        if store:
            try:
                for key, data in store.load():
                    fl = SymbolFlow(data['symbol'], data['kind'])
                    for name, value in data.items():
                        if name not in ('symbol', 'kind', 'bars', 'cur_bar', 'sizes', 'recent', 'big', 'absorb', 'trade_ids'):
                            if name in fl.__dict__: setattr(fl, name, value)
                    for name in ('sizes','recent','big','absorb','trade_ids'):
                        getattr(fl, name).extend(data.get(name, []))
                    for name, bars in data['bars'].items():
                        if name in fl.bars: fl.bars[name].extend(bars)
                    fl.cur_bar = data['cur_bar']
                    self.by_contract[tuple(key)] = fl
                    self.restored_contracts += 1
            except Exception as exc:
                self.persistence_error = self.restore_error = type(exc).__name__
                logging.getLogger(__name__).exception('Flow checkpoint restore failed')

    def checkpoint(self):
        with self.checkpoint_lock:
            self._checkpoint()

    def _checkpoint(self):
        if not self.store: return
        with self.lock:
            rows = []
            versions = dict(self._versions)
            for key, fl in self.by_contract.items():
                if versions.get(key) == self._saved_versions.get(key): continue
                data = {k:v for k,v in fl.__dict__.items() if k not in ('bars','sizes','recent','big','absorb','trade_ids')}
                data.update(bars={k:list(v)[-BAR_HISTORY:] for k,v in fl.bars.items()},
                            **{k:list(getattr(fl,k)) for k in ('sizes','recent','big','absorb','trade_ids')})
                # Freeze while holding the lock; SQLite must not block callbacks.
                import json
                rows.append((key, json.loads(json.dumps(data))))
        if not rows: return
        try:
            self.store.save(rows)
            with self.lock:
                self._saved_versions.update(versions)
            self.last_checkpoint = time.time()
            self.persistence_error = None
        except Exception as exc:
            self.persistence_error = type(exc).__name__
            logging.getLogger(__name__).exception('Flow checkpoint failed')

    def diagnostics(self, key, interval='5m'):
        with self.lock:
            fl = self.by_contract.get(key)
            bars = fl.bars_snapshot(interval,420) if fl else []
            return dict(observed_bars=len(bars), big_bars=sum(b['big_n']>0 for b in bars),
                        absorption_bars=sum(b['abs_n']>0 for b in bars),
                        first_observed_ts=fl.coverage_start if fl else None,
                        last_observed_ts=fl.last_ts if fl else None,
                        persistence_enabled=bool(self.store), last_checkpoint=self.last_checkpoint,
                        restored_contracts=self.restored_contracts, restore_error=self.restore_error,
                        persistence_error=self.persistence_error,
                        historical_coverage='partial', no_backfill=True)


    def add_trade(self, key: tuple, symbol: str, ts: float, price: float,
                  size: float, aggressor: int, kind: str = "perp",
                  instrument: str | None = None, trade_id=None) -> None:
        with self.lock:
            fl = self.by_contract.get(key)
            if fl is None:
                fl = self.by_contract[key] = SymbolFlow(symbol, kind)
            if trade_id is not None and str(trade_id) in fl.trade_ids: return
            if not all(math.isfinite(v) for v in (ts, price, size)) or price <= 0 or size <= 0: return
            if fl.last_ts is not None and ts < fl.last_ts: return
            fl.add(ts, price, size, aggressor, instrument)
            if trade_id is not None: fl.trade_ids.append(str(trade_id))
            self._versions[key] = self._versions.get(key, 0) + 1

    def get(self, key: tuple) -> dict | None:
        with self.lock:
            fl = self.by_contract.get(key)
            return fl.snapshot() if fl else None

    def bars(self, key: tuple, interval: str = "5m", limit: int = 240) -> list[dict]:
        """Delta/CVD par bougie pour un contrat (vide s'il n'a rien reçu)."""
        with self.lock:
            fl = self.by_contract.get(key)
            return fl.bars_snapshot(interval, limit) if fl else []

    def clear(self) -> None:
        with self.lock:
            self.by_contract.clear()
