"""Tests hors ligne du feed crypto — aucun réseau, aucun compte.

    python -m crypto_feed.tests_offline      (depuis gex-dashboard/)

Couvre la partie « logique » : parsing des instruments, math Black-Scholes,
murs / gamma flip, seuils de gros trade, détection d'absorption et remise à
zéro du CVD. Le raccordement réseau réel se vérifie avec
`python -m crypto_feed --once --json`.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

from .config import Config
from .options import DeribitOptions, bs_gamma, parse_instrument
from .tape import FlowState, OrderBook

FAILED: list[str] = []


def check(cond: bool, label: str) -> None:
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        FAILED.append(label)


def test_parse_instrument() -> None:
    print("parse_instrument")
    parsed = parse_instrument("BTC-27MAR26-90000-C")
    check(parsed is not None, "instrument valide reconnu")
    if parsed:
        expiry, strike, kind = parsed
        check(expiry == datetime(2026, 3, 27, 8, 0, tzinfo=timezone.utc),
              f"échéance UTC 08:00 → {expiry.isoformat()}")
        check(strike == 90000.0 and kind == "C", "strike et type extraits")
    check(parse_instrument("BTC-PERPETUAL") is None, "le perp n'est pas une option")
    check(parse_instrument("BTC-27MAR26-90000-X") is None, "type inconnu rejeté")


def test_bs_gamma() -> None:
    print("bs_gamma")
    atm = bs_gamma(100.0, 100.0, 0.5, 30 / 365)
    check(0.0 < atm < 0.1, f"gamma ATM plausibles ({atm:.5f})")
    check(bs_gamma(100.0, 100.0, 0.0, 30 / 365) == 0.0, "vol nulle → 0")
    check(bs_gamma(100.0, 100.0, 0.5, 0.0) == 0.0, "T nul → 0")
    deep = bs_gamma(100.0, 300.0, 0.5, 30 / 365)
    check(abs(deep) < 1e-9, "strike très loin → gamma ~0")


def _row(instrument: str, oi: float, iv: float = 60.0) -> dict:
    return {"instrument_name": instrument, "open_interest": oi, "mark_iv": iv,
            "mark_price": 1000.0, "underlying_price": 0.0}


def _exp(days: int) -> str:
    """Échéance Deribit (`27MAR26`) à J+days, en UTC."""
    ts = time.time() + days * 86400
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%d%b%y").upper()


def test_chain_aggregation() -> None:
    print("agrégation de la chaîne (OI, murs, GEX)")
    now = time.time()
    exp = _exp(30)
    rows = [
        _row(f"BTC-{exp}-90000-C", 100.0),   # call wall
        _row(f"BTC-{exp}-95000-C", 40.0),
        _row(f"BTC-{exp}-80000-P", 80.0),    # put wall
        _row(f"BTC-{exp}-85000-C", 10.0),
        _row(f"BTC-{exp}-85000-P", 10.0),
        _row("BTC-PERPETUAL", 999.0),         # ignoré (pas une option)
        _row(f"BTC-{exp}-90000-C", 0.0),      # OI nul → ignoré
    ]
    chain = DeribitOptions(Config(expiry_filter="all")).build(rows, now=now, spot=88000.0)
    check(chain.contracts == 5, f"5 options retenues (obtenu {chain.contracts})")
    check(chain.call_wall is not None and chain.call_wall["strike"] == 90000.0,
          "call wall = plus gros OI call")
    check(chain.put_wall is not None and chain.put_wall["strike"] == 80000.0,
          "put wall = plus gros OI put")
    by_strike = {s["strike"]: s for s in chain.strikes}
    check(by_strike[90000.0]["call_gex"] > 0 and by_strike[90000.0]["put_gex"] == 0,
          "GEX call positif")
    check(by_strike[80000.0]["put_gex"] > 0 and by_strike[80000.0]["net_gex"] < 0,
          "GEX put négatif (convention dealer short puts)")
    check(chain.total_oi == 240.0, f"OI total = 240 (obtenu {chain.total_oi})")
    check(chain.zero_gamma is None or 70000 < chain.zero_gamma < 110000,
          "gamma flip dans la plage des strikes")


def test_expiry_filter() -> None:
    print("filtre d'échéances")
    today = _exp(0)
    far = _exp(60)
    rows = [_row(f"BTC-{today}-90000-C", 10.0), _row(f"BTC-{far}-120000-C", 10.0)]
    d0 = DeribitOptions(Config(expiry_filter="0dte")).build(rows, spot=88000.0)
    check(d0.contracts == 1, f"0DTE ne garde qu'aujourd'hui ({d0.contracts})")
    allx = DeribitOptions(Config(expiry_filter="all")).build(rows, spot=88000.0)
    check(allx.contracts == 2, "ALL garde tout")


def test_flow_big_and_cvd() -> None:
    print("gros trades, absorption, CVD")
    cfg = Config(big_trade_usd=50_000, absorb_usd=150_000, absorb_window_s=6.0,
                 absorb_range_bps=2.0, absorb_cooldown_s=0.0, cvd_reset="candle",
                 cvd_candle="1m")
    flow = FlowState(cfg)
    t0 = 1_700_000_000.0
    flow.add(t0, 80000.0, 0.1, True)                 # 8 k$ : ni gros ni absorption
    check(not flow.big and flow.trades == 1, "petit trade ignoré")

    flow.add(t0 + 0.5, 80000.0, 1.0, True)           # 80 k$ : gros trade
    check(len(flow.big) == 1 and flow.big[0]["notional"] == 80_000.0,
          "gros trade USD détecté")

    # 3 prints agressifs de 60 k$ à prix quasi stable → absorption acheteuse
    event = None
    for i in range(3):
        event = flow.add(t0 + 1.0 + i * 0.2, 80000.0 + i * 0.5, 0.75, True)
    check(event is not None and event["side"] == "buy",
          f"absorption acheteuse détectée ({event and event['usd']:.0f} $)")
    check(flow.snapshot()["absorb"][-1]["range_bps"] <= 2.0,
          "amplitude de prix sous le seuil pendant l'absorption")

    # prix qui bouge : pas d'absorption
    flow2 = FlowState(cfg)
    for i in range(5):
        flow2.add(t0 + i * 0.2, 80000.0 + i * 50.0, 1.0, True)
    check(not flow2.absorb, "prix en mouvement → aucune absorption")

    # absorption sous le seuil de notionnel
    flow3 = FlowState(cfg)
    for i in range(5):
        flow3.add(t0 + i * 0.2, 80000.0, 0.2, True)   # 16 k$ chacun : total 80 k$
    check(not flow3.absorb, "notionnel cumulé sous le seuil → aucune absorption")

    # CVD : reset à chaque bougie
    snap = flow.snapshot()
    check(snap["delta_mode"] == "candle" and snap["delta"] != 0, "CVD courant alimenté")
    flow.add(t0 + 61.0, 80000.0, 0.01, True)          # bougie suivante
    check(abs(flow.snapshot()["delta"] - 800.0) < 1e-6,
          "CVD remis à zéro au changement de bougie")
    check(len(flow.snapshot()["cvd_series"]) == 1, "bougie close archivée dans la série")
    check(flow.snapshot()["delta_session"] > 100_000, "delta de séance non remis à zéro")

    # CVD : mode session (jamais remis à zéro)
    flow4 = FlowState(Config(cvd_reset="session", big_trade_usd=1e9))
    flow4.add(t0, 80000.0, 0.1, True)
    before = flow4.snapshot()["delta"]
    flow4.add(t0 + 61.0, 80000.0, 0.1, True)
    check(abs(flow4.snapshot()["delta"] - 2 * before) < 1e-6,
          "mode session : le CVD ne se remet pas à zéro")


def test_order_book() -> None:
    print("carnet d'ordres")
    book = OrderBook(depth=3)
    book.apply_snapshot([[100.0, 2.0], [99.0, 1.0]], [[101.0, 1.0], [102.0, 3.0]], 5)
    book.apply_delta([[100.0, 0.0], [99.5, 4.0]], [[101.0, 2.0]])
    snap = book.snapshot()
    check(snap is not None and snap["synced"], "carnet synchronisé")
    check(snap is not None and snap["bids"][0] == [99.5, 4.0],
          "delta appliqué (niveau inséré)")
    check(snap is not None and 100.0 not in [p for p, _ in snap["bids"]],
          "quantité 0 → niveau retiré")
    check(snap is not None and snap["ask_vol"] > 0 and snap["spread_bps"] > 0,
          "volumes et spread calculés")


def main() -> int:
    print("Tests hors ligne — crypto_feed\n")
    for fn in (test_parse_instrument, test_bs_gamma, test_chain_aggregation,
               test_expiry_filter, test_flow_big_and_cvd, test_order_book):
        fn()
        print()
    if FAILED:
        print(f"{len(FAILED)} test(s) en échec : {FAILED}")
        return 1
    print("Tous les tests passent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
