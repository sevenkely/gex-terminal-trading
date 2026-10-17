"""Configuration centralisée du feed crypto (options Deribit + tape Binance/Bybit).

Tout est surchargeable par variable d'environnement (`CRYPTO_FEED_*`) ou par les
options de la ligne de commande de `crypto_feed.main`, ce qui permet de lancer
plusieurs instances (BTC/ETH, perp/options) sans toucher au code.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from typing import Literal

ExpiryFilter = Literal["all", "0dte", "weekly", "monthly"]
CvdReset = Literal["candle", "session"]


def _env(name: str, default: str) -> str:
    return os.environ.get(f"CRYPTO_FEED_{name}", default)


def _env_f(name: str, default: float) -> float:
    try:
        return float(_env(name, str(default)))
    except ValueError:
        return default


def _env_b(name: str, default: bool) -> bool:
    return _env(name, "1" if default else "0").strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Config:
    """Paramètres du feed. Les valeurs par défaut visent BTC/USDT perp."""

    # ---- instruments -----------------------------------------------------
    currency: str = field(default_factory=lambda: _env("CURRENCY", "BTC").upper())
    #: Symbole du perpétuel suivi pour le flux d'ordres (Binance & Bybit).
    symbol: str = field(default_factory=lambda: _env("SYMBOL", "BTCUSDT").upper())

    # ---- options (Deribit, API publique, sans clé) ------------------------
    deribit_url: str = field(default_factory=lambda: _env(
        "DERIBIT_URL", "https://www.deribit.com/api/v2"))
    #: "all" | "0dte" | "weekly" (<= 7 j) | "monthly" (8..45 j)
    expiry_filter: ExpiryFilter = field(
        default_factory=lambda: _env("EXPIRY", "all").lower())  # type: ignore[arg-type]
    #: Rafraîchissement de la chaîne d'options (3 min par défaut).
    options_refresh_s: float = field(default_factory=lambda: _env_f("OPTIONS_REFRESH", 180.0))
    #: Taux sans risque annualisé utilisé par Black-Scholes (gamma).
    risk_free: float = field(default_factory=lambda: _env_f("RISK_FREE", 0.04))
    #: Taille d'un contrat d'option Deribit (1 BTC pour BTC, 1 ETH pour ETH).
    contract_size: float = field(default_factory=lambda: _env_f("CONTRACT_SIZE", 1.0))
    #: Seuil minimal d'open interest pour retenir un strike dans les murs.
    min_strike_oi: float = field(default_factory=lambda: _env_f("MIN_STRIKE_OI", 0.0))

    # ---- flux d'ordres (Binance Futures -> Bybit en secours) --------------
    binance_ws: str = field(default_factory=lambda: _env(
        "BINANCE_WS", "wss://fstream.binance.com/ws"))
    binance_rest: str = field(default_factory=lambda: _env(
        "BINANCE_REST", "https://fapi.binance.com"))
    bybit_ws: str = field(default_factory=lambda: _env(
        "BYBIT_WS", "wss://stream.bybit.com/v5/public/linear"))
    #: Forcer une source : "auto" (Binance puis Bybit), "binance", "bybit".
    source: str = field(default_factory=lambda: _env("SOURCE", "auto").lower())
    #: Streams Binance essayés dans l'ordre. `aggTrade` est agrégé et préférable ;
    #: certains réseaux le laissent muet (proxy filtrant) alors que `trade` passe,
    #: d'où la liste de repli.
    binance_streams: tuple[str, ...] = field(default_factory=lambda: tuple(
        s.strip() for s in _env("BINANCE_STREAMS", "aggTrade,trade").split(",") if s.strip()))
    #: Bascule automatique vers Bybit si Binance est injoignable / HTTP 451.
    allow_bybit_fallback: bool = field(default_factory=lambda: _env_b("BYBIT_FALLBACK", True))
    #: Une connexion qui n'envoie AUCUNE donnée pendant ce délai est considérée
    #: comme morte (proxy qui accepte le handshake puis filtre le flux).
    data_timeout_s: float = field(default_factory=lambda: _env_f("DATA_TIMEOUT", 12.0))
    #: Durée avant de retenter un stream précédemment déclaré muet (secondes).
    retry_blocked_s: float = field(default_factory=lambda: _env_f("RETRY_BLOCKED", 300.0))
    reconnect_min_s: float = field(default_factory=lambda: _env_f("RECONNECT_MIN", 1.0))
    reconnect_max_s: float = field(default_factory=lambda: _env_f("RECONNECT_MAX", 30.0))
    ws_ping_s: float = field(default_factory=lambda: _env_f("WS_PING", 20.0))

    # ---- indicateurs dérivés ---------------------------------------------
    #: Remise à zéro du delta/CVD : à chaque bougie ou à chaque session UTC.
    cvd_reset: CvdReset = field(
        default_factory=lambda: _env("CVD_RESET", "candle").lower())  # type: ignore[arg-type]
    #: Taille de la bougie de référence ("30s", "1m", "5m", "15m", "1h").
    cvd_candle: str = field(default_factory=lambda: _env("CVD_CANDLE", "1m").lower())
    #: Notionnel minimal d'un « gros trade » (USD).
    big_trade_usd: float = field(default_factory=lambda: _env_f("BIG_TRADE_USD", 50_000.0))
    #: Notionnel agressif cumulé déclenchant une absorption (USD).
    absorb_usd: float = field(default_factory=lambda: _env_f("ABSORB_USD", 250_000.0))
    #: Fenêtre glissante d'absorption (secondes).
    absorb_window_s: float = field(default_factory=lambda: _env_f("ABSORB_WINDOW", 6.0))
    #: Amplitude maximale du prix sur la fenêtre pour parler d'absorption (bps).
    absorb_range_bps: float = field(default_factory=lambda: _env_f("ABSORB_RANGE_BPS", 1.5))
    #: Anti-rebond entre deux absorptions du même côté (secondes).
    absorb_cooldown_s: float = field(default_factory=lambda: _env_f("ABSORB_COOLDOWN", 20.0))
    #: Nombre d'événements conservés dans l'état partagé.
    keep_events: int = field(default_factory=lambda: int(_env_f("KEEP_EVENTS", 120)))

    # ---- carnet d'ordres optionnel ---------------------------------------
    depth_enabled: bool = field(default_factory=lambda: _env_b("DEPTH", False))
    #: Fréquence du stream de carnet Binance (100 ms par défaut).
    depth_ms: int = field(default_factory=lambda: int(_env_f("DEPTH_MS", 100)))
    #: Nombre de niveaux conservés de chaque côté.
    depth_levels: int = field(default_factory=lambda: int(_env_f("DEPTH_LEVELS", 20)))

    # ---- logs -------------------------------------------------------------
    log_level: str = field(default_factory=lambda: _env("LOG_LEVEL", "INFO").upper())

    # ---------------------------------------------------------------- helpers
    @property
    def perp(self) -> str:
        """Nom lisible du perpétuel (ex. BTC-PERPETUAL chez Deribit)."""
        base = self.currency
        return f"{base}-PERPETUAL"

    def binance_stream(self, kind: str | None = None) -> str:
        """Nom du stream Binance (`btcusdt@aggTrade` par défaut)."""
        kind = kind or (self.binance_streams[0] if self.binance_streams else "aggTrade")
        return f"{self.symbol.lower()}@{kind}"

    @property
    def bybit_topic(self) -> str:
        return f"publicTrade.{self.symbol}"

    @property
    def bybit_depth_topic(self) -> str:
        return f"orderbook.50.{self.symbol}"

    def candle_seconds(self) -> int:
        """Durée de la bougie de reset CDC en secondes."""
        raw = self.cvd_candle.strip().lower()
        unit = raw[-1]
        try:
            n = int(raw[:-1] or "1")
        except ValueError:
            return 60
        return n * {"s": 1, "m": 60, "h": 3600, "d": 86400}.get(unit, 60)

    def with_overrides(self, **kw: object) -> "Config":
        """Copie avec surcharges (les valeurs None sont ignorées)."""
        clean = {k: v for k, v in kw.items() if v is not None}
        return replace(self, **clean)  # type: ignore[arg-type]


DEFAULT = Config()
