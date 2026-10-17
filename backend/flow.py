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
        calib = calib_for(symbol, kind)
        self.tick = calib["tick"]
        self.min_big = calib["min_big"]
        self.k_big = calib["k_big"]
        self.absorb_min = calib["absorb_min"]
        self.absorb_k = calib["absorb_k"]
        self.unit = calib["unit"]
        self.sizes: deque[float] = deque(maxlen=MED_WINDOW)
        self.recent: deque[tuple[float, float, float, str | None]] = deque()
        self.big: deque[dict] = deque(maxlen=40)
        self.absorb: deque[dict] = deque(maxlen=20)
        self._median = 1.0
        self._median_ts = 0.0
        self._big_seq = 0
        self._absorb_seq = 0
        self._last_absorb: dict[str, float] = {"buy": 0.0, "sell": 0.0}
        self.bars: dict[str, deque] = {k: deque(maxlen=BAR_HISTORY) for k in BAR_PERIODS}
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
            day = (dt.date() + timedelta(days=1) if self.symbol in TICK_SIZES and dt.hour >= 18 else dt.date()).isoformat()
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

        self._add_bar(ts, price, size, side)

        med = self._median_size(ts)
        thr = max(self.min_big, round(self.k_big * med))
        if size >= thr:
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
                self._absorb_seq += 1
                self.absorb.append({
                    "seq": self._absorb_seq, "ts": round(ts, 3), "price": price,
                    "side": sd, "volume": vol, "window_s": WINDOW,
                    "threshold": limit, "instrument": instrument,
                })

    # --------------------------------------------------------------- bougies
    def _add_bar(self, ts: float, price: float, size: float, side: str | None) -> None:
        """Agrège le print dans chaque intervalle (OHLC + delta agressif)."""
        for name, secs in BAR_PERIODS.items():
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
        secs = BAR_PERIODS.get(interval, 300)
        rows = list(self.bars.get(interval, ()))[-max(1, limit):]
        cur = self.cur_bar.get(interval)
        if cur is not None:
            rows = rows + [cur]
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
        }


class OrderFlowEngine:
    """Un SymbolFlow par contrat Rithmic (exchange, contract)."""

    def __init__(self) -> None:
        self.by_contract: dict[tuple, SymbolFlow] = {}

    def add_trade(self, key: tuple, symbol: str, ts: float, price: float,
                  size: float, aggressor: int, kind: str = "perp",
                  instrument: str | None = None) -> None:
        fl = self.by_contract.get(key)
        if fl is None:
            fl = self.by_contract[key] = SymbolFlow(symbol, kind)
        fl.add(ts, price, size, aggressor, instrument)

    def get(self, key: tuple) -> dict | None:
        fl = self.by_contract.get(key)
        return fl.snapshot() if fl else None

    def bars(self, key: tuple, interval: str = "5m", limit: int = 240) -> list[dict]:
        """Delta/CVD par bougie pour un contrat (vide s'il n'a rien reçu)."""
        fl = self.by_contract.get(key)
        return fl.bars_snapshot(interval, limit) if fl else []

    def clear(self) -> None:
        self.by_contract.clear()
