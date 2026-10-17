"""Point d'entrée du feed crypto : options Deribit + flux Binance/Bybit.

Usage (depuis le dossier `gex-dashboard/`) :

    python -m crypto_feed.main                       # BTC, 3 min, console
    python -m crypto_feed.main --currency ETH --symbol ETHUSDT
    python -m crypto_feed.main --expiry 0dte --cvd-reset session --depth
    python -m crypto_feed.main --once --json         # un snapshot puis sortie
    python -m crypto_feed.main --duration 300 --json # 5 min puis snapshot

En bibliothèque :

    from crypto_feed.main import MarketFeed, get_state
    feed = MarketFeed()
    await feed.start()          # tasks asyncio
    state = await get_state()   # dict JSON : options + flow + depth
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import signal
import sys
import time
from typing import Any

from . import state as shared
from .config import Config
from .options import DeribitOptions
from .state import get_state
from .tape import FlowState, TapeFeed

log = logging.getLogger("crypto_feed")

__all__ = ["MarketFeed", "get_state", "main"]


class MarketFeed:
    """Orchestrateur : deux pipelines indépendants qui alimentent un état commun."""

    def __init__(self, cfg: Config | None = None) -> None:
        self.cfg = cfg or Config()
        self.state = shared.configure(self.cfg)
        self.flow = FlowState(self.cfg)
        self.options = DeribitOptions(self.cfg)
        self.tape = TapeFeed(self.cfg, self.flow)
        self.stop = asyncio.Event()
        self._tasks: list[asyncio.Task[Any]] = []
        self._last_publish = 0.0
        self._dirty = False

    # ------------------------------------------------------------------ hooks
    async def _on_trade(self, trade: dict[str, Any]) -> None:
        event = self.flow.add(trade["ts"], trade["price"], trade["qty"], trade["buy"])
        self._dirty = True
        if event:
            log.info("absorption %s %.0f k$ @ %.2f (%.1f bps sur %.0fs)",
                     event["side"], event["usd"] / 1e3, event["price"],
                     event["range_bps"], event["window_s"])
        if trade["notional"] >= self.cfg.big_trade_usd:
            log.info("gros trade %s %.0f k$ @ %.2f",
                     "ACHAT" if trade["buy"] else "VENTE",
                     trade["notional"] / 1e3, trade["price"])
        # publication au plus 4 fois par seconde : l'état reste frais sans spam
        now = time.time()
        if self._dirty and now - self._last_publish >= 0.25:
            self._last_publish = now
            self._dirty = False
            await self.state.set_flow(self.flow.snapshot())

    async def _publish_flow(self) -> None:
        """Filet de sécurité : garantit un état frais même sans trade.

        Republie aussi l'état de connexion (dernier message reçu, compteurs) que
        le superviseur met à jour sans repasser par l'état partagé.
        """
        while not self.stop.is_set():
            await asyncio.sleep(1.0)
            await self.state.set_flow(self.flow.snapshot())
            await self.state.set_feed(dict(self.tape.status))

    async def _on_status(self, status: dict[str, Any]) -> None:
        await self.state.set_feed(status)
        log.debug("feed: %s", status)

    async def _on_depth(self, snapshot: dict[str, Any]) -> None:
        await self.state.set_depth(snapshot)

    # ------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        """Démarre les pipelines ; ne bloque pas."""
        await self.tape._set_status(self._on_status, state="starting")
        self._tasks = [
            asyncio.create_task(self.options.run(self.state.set_options, stop=self.stop),
                                name="options"),
            asyncio.create_task(self.tape.run(self._on_trade, self._on_status,
                                              self._on_depth, stop=self.stop),
                                name="tape"),
            asyncio.create_task(self._publish_flow(), name="flow-publish"),
        ]

    async def run(self) -> None:
        """Démarre puis **joint les deux pipelines** via `asyncio.gather`.

        Les pipelines (options + tape) tournent indépendamment et ne rendent la
        main qu'à l'arrêt ; un `stop.set()` (Ctrl-C, durée, erreur fatale) fait
        sortir du gather, puis `close()` annule et ferme proprement.
        """
        await self.start()
        stopper = asyncio.create_task(self.stop.wait(), name="stop-watch")
        try:
            await asyncio.gather(*self._tasks, stopper, return_exceptions=True)
        finally:
            await self.close()

    async def close(self) -> None:
        self.stop.set()
        for t in self._tasks:
            t.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        await self.options.close()
        await self.tape.close()

    # ------------------------------------------------------------------ util
    async def one_shot(self) -> dict[str, Any]:
        """Rafraîchit la chaîne une fois et attend le premier trade (max 20 s)."""
        try:
            await self.state.set_options(await self.options.refresh())
        except Exception as exc:  # noqa: BLE001
            await self.state.set_options_error(str(exc))
            log.warning("chaîne d'options indisponible : %s", exc)
        await self.start()
        deadline = time.time() + 20
        while time.time() < deadline:
            await asyncio.sleep(0.4)
            if self.flow.trades:
                break
        await self.state.set_flow(self.flow.snapshot())
        snap = await get_state()
        await self.close()
        return snap


# --------------------------------------------------------------------- affichage
def _fmt_usd(v: float | None) -> str:
    if v is None:
        return "—"
    sign = "-" if v < 0 else "+"
    v = abs(v)
    if v >= 1e6:
        return f"{sign}{v / 1e6:.2f}M$"
    if v >= 1e3:
        return f"{sign}{v / 1e3:.1f}k$"
    return f"{sign}{v:.0f}$"


def render_console(snap: dict[str, Any]) -> str:
    opts = snap.get("options") or {}
    flow = snap.get("flow") or {}
    feed = snap.get("feed") or {}
    spot = opts.get("spot") or flow.get("last_price")
    cw = (opts.get("call_wall") or {}).get("strike")
    pw = (opts.get("put_wall") or {}).get("strike")
    zc = opts.get("zero_gamma")
    if not spot and not flow:
        return "en attente de données…"
    lines = [
        f"{snap['config']['currency']:4s} {spot:>10,.2f}   "
        f"src={feed.get('source') or '—':7s} état={feed.get('state') or '—':12s} "
        f"trades={flow.get('trades', 0):>6d}",
        f"  Δ séance {_fmt_usd(flow.get('delta_session')):>10s}   "
        f"CVD({flow.get('delta_mode')}/{flow.get('candle') or 'séance'}) "
        f"{_fmt_usd(flow.get('delta')):>10s}   VWAP {flow.get('vwap') or 0:,.2f}",
        f"  OPT  CW {cw or '—'}  PW {pw or '—'}  flip {zc or '—'}  "
        f"net GEX {_fmt_usd(opts.get('net_gex'))}  OI {opts.get('total_oi') or 0:,.0f}",
        f"  EVTS gros {len(flow.get('big') or []):>3d}  absorptions "
        f"{len(flow.get('absorb') or []):>3d}  carnet "
        f"{'ON' if feed.get('depth') else 'OFF'}",
    ]
    return "\n".join(lines)


# ------------------------------------------------------------------------- CLI
def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m crypto_feed.main",
        description="Options Deribit (OI/GEX par strike) + flux Binance/Bybit.")
    p.add_argument("--currency", help="devise sous-jacente (BTC, ETH…)")
    p.add_argument("--symbol", help="symbole du perpétuel (BTCUSDT…)")
    p.add_argument("--expiry", choices=["all", "0dte", "weekly", "monthly"],
                   help="filtre d'échéances")
    p.add_argument("--cvd-reset", choices=["candle", "session"],
                   help="remise à zéro du delta")
    p.add_argument("--cvd-candle", help="bougie de reset (30s, 1m, 5m, 15m, 1h)")
    p.add_argument("--big-trade-usd", type=float, help="seuil gros trade (USD)")
    p.add_argument("--absorb-usd", type=float, help="seuil absorption (USD)")
    p.add_argument("--absorb-window", type=float, help="fenêtre absorption (s)")
    p.add_argument("--source", choices=["auto", "binance", "bybit"],
                   help="source du flux (auto = Binance puis Bybit)")
    p.add_argument("--depth", action="store_true", default=None,
                   help="activer le carnet L2 (btcusdt@depth@100ms)")
    p.add_argument("--refresh", type=float, help="rafraîchissement options (s)")
    p.add_argument("--once", action="store_true", help="un snapshot puis sortie")
    p.add_argument("--duration", type=float, help="durée d'exécution (s)")
    p.add_argument("--json", action="store_true", help="sortie JSON (sans console)")
    p.add_argument("--verbose", "-v", action="store_true", help="logs DEBUG")
    return p


def build_config(args: argparse.Namespace) -> Config:
    cfg = Config()
    currency = (args.currency or cfg.currency).upper()
    symbol = (args.symbol or (f"{currency}USDT" if args.currency else cfg.symbol)).upper()
    depth = cfg.depth_enabled if args.depth is None else args.depth
    return cfg.with_overrides(
        currency=currency, symbol=symbol, expiry_filter=args.expiry,
        cvd_reset=args.cvd_reset, cvd_candle=args.cvd_candle,
        big_trade_usd=args.big_trade_usd, absorb_usd=args.absorb_usd,
        absorb_window_s=args.absorb_window, source=args.source,
        depth_enabled=depth, options_refresh_s=args.refresh,
        log_level="DEBUG" if args.verbose else cfg.log_level,
    )


async def _run_cli(cfg: Config, args: argparse.Namespace) -> int:
    feed = MarketFeed(cfg)
    if args.once:
        snap = await feed.one_shot()
        print(json.dumps(snap, indent=2, ensure_ascii=False, default=str))
        return 0

    await feed.start()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, AttributeError):
            loop.add_signal_handler(sig, feed.stop.set)

    deadline = time.time() + args.duration if args.duration else None
    try:
        while not feed.stop.is_set():
            await asyncio.sleep(1.0 if args.json else 2.0)
            snap = await get_state()
            if args.json:
                print(json.dumps(snap, ensure_ascii=False, default=str), flush=True)
            else:
                print("\033[H\033[J" + render_console(snap), flush=True)
            if deadline and time.time() >= deadline:
                break
    finally:
        await feed.close()
    if args.json:
        print(json.dumps(await get_state(), ensure_ascii=False, default=str))
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    cfg = build_config(args)
    logging.basicConfig(
        level=getattr(logging, cfg.log_level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )
    log.info("%s/%s · options %s · CVD %s/%s · carnet %s",
             cfg.currency, cfg.symbol, cfg.expiry_filter, cfg.cvd_reset,
             cfg.cvd_candle, "on" if cfg.depth_enabled else "off")
    try:
        return asyncio.run(_run_cli(cfg, args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
