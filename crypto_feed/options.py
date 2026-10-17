"""Chaîne d'options Deribit → open interest et gamma exposure par strike.

Source : API publique REST Deribit, sans clé ni authentification.

    GET /public/get_book_summary_by_currency?currency=BTC&kind=option

Chaque entrée porte `instrument_name` (ex. `BTC-27MAR26-90000-C`),
`open_interest` (contrats), `mark_iv` (vol en %, annualisée) et
`underlying_price`. Le gamma est recalculé par Black-Scholes à partir de ces
champs, puis converti en exposition en dollars par variation de 1 % du
sous-jacent (convention GEX) :

    Γ        = φ(d1) / (S · σ · √T)
    GEX($)   = Γ · OI · contract_size · S² · 0,01     (call : +, put : −)

Le signe suit la convention « dealers long calls / short puts ». C'est une
hypothèse de modélisation, pas une donnée de marché : elle est documentée ici
et reprise dans le README.
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timezone
from typing import Any, Iterable

import aiohttp

from .config import Config

log = logging.getLogger("crypto_feed.options")

#: Les options Deribit expirent à 08:00 UTC.
EXPIRY_UTC = dtime(8, 0)
SECONDS_PER_YEAR = 365.0 * 24 * 3600
_MONTHS = {m: i for i, m in enumerate(
    ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"), 1)}
_SQRT_2PI = math.sqrt(2.0 * math.pi)


class DeribitError(RuntimeError):
    """Erreur applicative renvoyée par Deribit (ou réponse inattendue)."""


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / _SQRT_2PI


def bs_gamma(spot: float, strike: float, vol: float, years: float,
             rate: float = 0.0) -> float:
    """Gamma Black-Scholes d'une option européenne (sans dividende).

    Retourne 0 pour les entrées dégénérées (T ≤ 0, σ ≤ 0, S ≤ 0, K ≤ 0)
    plutôt que de propager NaN/inf dans les agrégats.
    """
    if spot <= 0 or strike <= 0 or vol <= 0 or years <= 0:
        return 0.0
    sqrt_t = math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * sqrt_t)
    return _norm_pdf(d1) / (spot * vol * sqrt_t)


@dataclass(frozen=True)
class OptionQuote:
    instrument: str
    expiry: datetime
    strike: float
    kind: str            # "C" | "P"
    oi: float            # contrats
    iv: float            # vol annualisée (0.62 = 62 %)
    mark_price: float
    underlying: float


@dataclass
class ChainSnapshot:
    """Résultat prêt à être sérialisé (JSON) pour l'état partagé."""

    ts: float
    currency: str
    spot: float
    filter: str
    expiries: list[str] = field(default_factory=list)
    strikes: list[dict[str, Any]] = field(default_factory=list)
    call_wall: dict[str, Any] | None = None
    put_wall: dict[str, Any] | None = None
    zero_gamma: float | None = None
    net_gex: float = 0.0
    total_oi: float = 0.0
    contracts: int = 0
    iv30: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ts": self.ts,
            "ts_iso": datetime.fromtimestamp(self.ts, timezone.utc).isoformat(),
            "currency": self.currency,
            "spot": self.spot,
            "filter": self.filter,
            "expiries": self.expiries,
            "strikes": self.strikes,
            "call_wall": self.call_wall,
            "put_wall": self.put_wall,
            "zero_gamma": self.zero_gamma,
            "net_gex": self.net_gex,
            "total_oi": self.total_oi,
            "contracts": self.contracts,
            "iv30": self.iv30,
        }


def parse_instrument(name: str) -> tuple[datetime, float, str] | None:
    """`BTC-27MAR26-90000-C` → (échéance UTC 08:00, strike, type).

    Retourne None si le nom ne suit pas le format Deribit (options uniquement).
    """
    parts = name.split("-")
    if len(parts) != 4:
        return None
    _base, raw_exp, raw_strike, kind = parts
    if kind not in ("C", "P"):
        return None
    try:
        day = int(raw_exp[:2])
        month = _MONTHS[raw_exp[2:5].upper()]
        year = 2000 + int(raw_exp[5:])
        strike = float(raw_strike)
    except (ValueError, KeyError, IndexError):
        return None
    expiry = datetime(year, month, day, EXPIRY_UTC.hour, EXPIRY_UTC.minute,
                      tzinfo=timezone.utc)
    return expiry, strike, kind


def expiry_bucket(expiry: datetime, now: datetime, flt: str) -> bool:
    """Filtre d'échéance demandé par l'utilisateur."""
    dte = (expiry - now).total_seconds() / 86400.0
    if dte < -0.5:
        return False
    if flt == "0dte":
        return expiry.date() == now.date()
    if flt == "weekly":
        return dte <= 7.0
    if flt == "monthly":
        return 7.0 < dte <= 45.0
    return True


class DeribitOptions:
    """Client REST minimal, avec retry/backoff et calcul du GEX par strike."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self._session: aiohttp.ClientSession | None = None

    # ------------------------------------------------------------- transport
    async def _session_get(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=25, connect=10)
            self._session = aiohttp.ClientSession(timeout=timeout)
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    async def _get(self, path: str, params: dict[str, Any] | None = None,
                   attempts: int = 4) -> Any:
        """GET avec backoff exponentiel + jitter (2 s → 16 s)."""
        url = f"{self.cfg.deribit_url}{path}"
        last: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                session = await self._session_get()
                async with session.get(url, params=params) as resp:
                    body = await resp.text()
                    if resp.status in (429, 500, 502, 503, 504):
                        raise DeribitError(f"HTTP {resp.status} sur {path}")
                    if resp.status != 200:
                        raise DeribitError(f"HTTP {resp.status} sur {path}: {body[:160]}")
                    payload = await resp.json(content_type=None)
            except (aiohttp.ClientError, asyncio.TimeoutError, DeribitError, ValueError) as exc:
                last = exc
                if attempt == attempts:
                    break
                delay = min(16.0, 2.0 ** attempt) + random.uniform(0, 0.5)
                log.warning("Deribit %s : %s — retry %d/%d dans %.1fs",
                            path, exc, attempt, attempts - 1, delay)
                await asyncio.sleep(delay)
                continue
            if not isinstance(payload, dict):
                raise DeribitError(f"réponse inattendue sur {path}")
            if "error" in payload:
                raise DeribitError(f"Deribit: {payload['error']}")
            return payload.get("result")
        raise DeribitError(f"Deribit injoignable ({path}): {last}")

    # ---------------------------------------------------------------- données
    async def book_summary(self) -> list[dict[str, Any]]:
        result = await self._get("/public/get_book_summary_by_currency",
                                 {"currency": self.cfg.currency, "kind": "option"})
        if not isinstance(result, list) or not result:
            raise DeribitError(
                f"chaîne d'options vide pour {self.cfg.currency} (marché fermé ?)")
        return result

    async def index_price(self) -> float:
        result = await self._get("/public/get_index_price",
                                 {"index_name": f"{self.cfg.currency.lower()}_usd"})
        return float(result["index_price"])

    # ------------------------------------------------------------- agrégation
    def build(self, rows: Iterable[dict[str, Any]], now: float | None = None,
              spot: float | None = None) -> ChainSnapshot:
        """Agrège la chaîne : OI par strike (calls/puts) et GEX en dollars."""
        ts = time.time() if now is None else now
        now_dt = datetime.fromtimestamp(ts, timezone.utc)
        quotes: list[OptionQuote] = []
        underlying = spot or 0.0

        for row in rows:
            parsed = parse_instrument(str(row.get("instrument_name", "")))
            if not parsed:
                continue
            expiry, strike, kind = parsed
            if not expiry_bucket(expiry, now_dt, self.cfg.expiry_filter):
                continue
            oi = float(row.get("open_interest") or 0.0)
            if oi <= 0:
                continue
            iv = float(row.get("mark_iv") or 0.0) / 100.0
            if iv <= 0:
                continue
            quotes.append(OptionQuote(
                instrument=str(row["instrument_name"]), expiry=expiry,
                strike=strike, kind=kind, oi=oi, iv=iv,
                mark_price=float(row.get("mark_price") or 0.0),
                underlying=float(row.get("underlying_price") or 0.0),
            ))
            if not underlying and row.get("underlying_price"):
                underlying = float(row["underlying_price"])

        if not underlying:
            # Repli : strike à la monnaie du plus gros OI, puis moyenne d'IV.
            if quotes:
                underlying = max(quotes, key=lambda q: q.oi).strike
        if not quotes or underlying <= 0:
            return ChainSnapshot(ts=ts, currency=self.cfg.currency, spot=0.0,
                                 filter=self.cfg.expiry_filter)

        by_strike: dict[float, dict[str, Any]] = {}
        expiries: set[str] = set()
        total_oi = 0.0
        net = 0.0
        iv_weight = 0.0
        iv_wsum = 0.0

        for q in quotes:
            years = (q.expiry - now_dt).total_seconds() / SECONDS_PER_YEAR
            years = max(years, 1.0 / (SECONDS_PER_YEAR * 24.0))  # 0DTE : 1 h mini
            gamma = bs_gamma(underlying, q.strike, q.iv, years, self.cfg.risk_free)
            usd_per_1pct = gamma * q.oi * self.cfg.contract_size * underlying ** 2 * 0.01
            signed = usd_per_1pct if q.kind == "C" else -usd_per_1pct

            slot = by_strike.setdefault(q.strike, {
                "strike": q.strike, "call_oi": 0.0, "put_oi": 0.0,
                "call_gex": 0.0, "put_gex": 0.0, "net_gex": 0.0,
                "call_iv": None, "put_iv": None, "expiries": [],
            })
            expiries.add(q.expiry.date().isoformat())
            total_oi += q.oi
            net += signed
            if q.kind == "C":
                slot["call_oi"] += q.oi
                slot["call_gex"] += usd_per_1pct
                slot["call_iv"] = q.iv
            else:
                slot["put_oi"] += q.oi
                slot["put_gex"] += usd_per_1pct
                slot["put_iv"] = q.iv
            slot["net_gex"] += signed
            if q.expiry.date().isoformat() not in slot["expiries"]:
                slot["expiries"].append(q.expiry.date().isoformat())

            # IV à 30 jours, pondérée par l'OI (indicatif).
            if 20 <= years * 365.0 <= 45:
                iv_weight += q.oi
                iv_wsum += q.iv * q.oi

        strikes = sorted(by_strike.values(), key=lambda s: s["strike"])
        strikes = [s for s in strikes if s["call_oi"] + s["put_oi"] >= self.cfg.min_strike_oi]
        for s in strikes:
            for key in ("call_gex", "put_gex", "net_gex"):
                s[key] = round(s[key], 2)

        spot = round(underlying, 2)
        call_wall = self._wall(strikes, "call_oi", spot, "call")
        put_wall = self._wall(strikes, "put_oi", spot, "put")
        zero_gamma = self._zero_gamma(strikes, spot)

        return ChainSnapshot(
            ts=ts, currency=self.cfg.currency, spot=spot,
            filter=self.cfg.expiry_filter,
            expiries=sorted(expiries)[:12],
            strikes=strikes,
            call_wall=call_wall, put_wall=put_wall, zero_gamma=zero_gamma,
            net_gex=round(net, 2), total_oi=round(total_oi, 4),
            contracts=len(quotes),
            iv30=round(iv_wsum / iv_weight, 4) if iv_weight else None,
        )

    @staticmethod
    def _wall(strikes: list[dict[str, Any]], oi_key: str, spot: float,
              kind: str) -> dict[str, Any] | None:
        if not strikes:
            return None
        best = max(strikes, key=lambda s: s[oi_key])
        if not best[oi_key]:
            return None
        # Deuxième mur, à un autre strike, pour situer la zone.
        rest = [s for s in strikes if s["strike"] != best["strike"]]
        second = max(rest, key=lambda s: s[oi_key]) if rest else None
        return {
            "strike": best["strike"], "kind": kind, "oi": best[oi_key],
            "gex": best["call_gex"] if kind == "call" else best["put_gex"],
            "distance_pct": round((best["strike"] / spot - 1) * 100, 3) if spot else None,
            "second": ({"strike": second["strike"], "oi": second[oi_key]}
                       if second else None),
        }

    @staticmethod
    def _zero_gamma(strikes: list[dict[str, Any]], spot: float) -> float | None:
        """Strike où le GEX cumulé (du bas vers le haut) change de signe.

        Approximation usuelle du « gamma flip » : on cherche le passage à zéro
        le plus proche du spot, puis on interpole linéairement entre les deux
        strikes encadrants.
        """
        if len(strikes) < 3:
            return None
        cum = 0.0
        prev: tuple[float, float] | None = None
        crossings: list[float] = []
        for s in strikes:
            cum += s["net_gex"]
            if prev and (prev[1] < 0 <= cum or prev[1] > 0 >= cum) and prev[1] != cum:
                x0, y0 = prev
                x1, y1 = s["strike"], cum
                crossings.append(x0 + (x1 - x0) * (-y0) / (y1 - y0))
            prev = (s["strike"], cum)
        if not crossings:
            return None
        return round(min(crossings, key=lambda x: abs(x - spot)), 2)

    async def refresh(self) -> ChainSnapshot:
        rows = await self.book_summary()
        try:
            spot = await self.index_price()
        except DeribitError as exc:  # l'index est un bonus, pas un prérequis
            log.debug("index price indisponible: %s", exc)
            spot = 0.0
        snap = self.build(rows, spot=spot)
        log.info("chaîne %s : %d contrats, %d strikes, spot %.2f, net GEX %.2f M$",
                 self.cfg.currency, snap.contracts, len(snap.strikes),
                 snap.spot, snap.net_gex / 1e6)
        return snap

    async def run(self, on_snapshot, *, stop: asyncio.Event | None = None) -> None:
        """Boucle de rafraîchissement (3 min par défaut), jamais fatale."""
        while not (stop and stop.is_set()):
            started = time.time()
            try:
                await on_snapshot(await self.refresh())
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — une chaîne momentanément vide ne doit pas tuer le feed
                log.exception("rafraîchissement de la chaîne d'options échoué")
            elapsed = time.time() - started
            wait = max(5.0, self.cfg.options_refresh_s - elapsed)
            if stop:
                try:
                    await asyncio.wait_for(stop.wait(), timeout=wait)
                except asyncio.TimeoutError:
                    pass
            else:
                await asyncio.sleep(wait)
