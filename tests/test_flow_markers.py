"""Observed tape aggregates, independent of the small recent-event UI buffer."""
from datetime import datetime, timezone

from flow import BAR_HISTORY, SymbolFlow, OrderFlowEngine

BASE = datetime(2026, 10, 16, 12, tzinfo=timezone.utc).timestamp()


def configured(symbol="ES"):
    f = SymbolFlow(symbol)
    # Fixed low thresholds make synthetic expectations deterministic.
    f.min_big, f.k_big = 10, 0
    f.absorb_min, f.absorb_k = 40, 0
    return f


def test_big_totals_counts_sides_and_interval_regrouping():
    f = configured()
    for offset, size, side in [(0, 10, 1), (10, 20, 2), (60, 30, 0)]:
        f.add(BASE + offset, 6000, size, side)
    minute = f.bars_snapshot("1m")
    five = f.bars_snapshot("5m")[0]
    assert [b["big_total"] for b in minute] == [30, 30]
    assert [b["big_n"] for b in minute] == [2, 1]
    assert five["big_total"] == 60 and five["big_n"] == 3
    assert (five["big_buy"], five["big_sell"], five["big_unknown"]) == (10, 20, 30)
    # Polling/read operations never recount an event.
    assert f.bars_snapshot("5m")[0] == five


def test_absorption_total_episodes_separate_from_big_and_cooldown():
    f = configured()
    # Two buy episodes, one sell episode, no overlapping same-side windows.
    for offset, size, side in [(0, 40, 1), (1, 40, 2), (2, 10, 1), (30, 50, 1), (31, 1, 1), (32, 1, 1)]:
        f.add(BASE + offset, 6000, size, side)
    b = f.bars_snapshot("1m")[0]
    assert (b["abs_n"], b["abs_total"], b["abs_buy"], b["abs_sell"]) == (3, 142, 102, 40)
    assert (b["big_n"], b["big_total"]) == (4, 140)
    assert sum(e["volume"] for e in f.absorb) == b["abs_total"]


def test_history_survives_recent_event_eviction_and_session_reset():
    f = configured()
    for i in range(70):
        f.add(BASE + 60 * i, 6000, 40, 1)
        f.add(BASE + 60 * i + 1, 6000, 1, 0)
        f.add(BASE + 60 * i + 2, 6000, 1, 0)
    assert len(f.big) == 40 and len(f.absorb) == 20
    assert len(f.bars_snapshot("1m", 420)) == 70
    assert sum(b["big_n"] for b in f.bars_snapshot("1m", 420)) == 70
    assert sum(b["abs_n"] for b in f.bars_snapshot("1m", 420)) == 70
    f.add(BASE + 86400, 6000, 40, 2)
    rows = f.bars_snapshot("1m", 420)
    assert len(rows) == 71 and rows[0]["big_n"] == 1
    assert len(f.big) == 1


def test_retention_and_out_of_order_or_invalid_events_do_not_recount():
    f = configured()
    for i in range(BAR_HISTORY + 20):
        f.add(BASE + 60 * i, 6000, 40, 1)
    rows = f.bars_snapshot("1m", 420)
    assert len(rows) == BAR_HISTORY
    assert rows[0]["t"] == BASE + 60 * 20
    f.add(BASE, 6000, 200, 1)
    f.add(BASE + 60 * 500, 6000, float("nan"), 1)
    assert f.bars_snapshot("1m", 420) == rows


def test_contracts_units_and_daily_session_are_isolated():
    engine = OrderFlowEngine()
    engine.add_trade(("DERIBIT", "BTC-PERPETUAL"), "BTC-PERPETUAL", BASE, 100000, 1000, 1)
    assert engine.bars(("DERIBIT", "BTC-OPTIONS")) == []
    assert engine.get(("DERIBIT", "BTC-PERPETUAL"))["unit"] == "USD"
    f = configured()
    # CME session starts 18:00 ET on October 15, i.e. 22:00 UTC.
    ts = datetime(2026, 10, 15, 23, tzinfo=timezone.utc).timestamp()
    f.add(ts, 6000, 10, 1)
    assert f.bars_snapshot("1d")[0]["t"] == int(BASE // 86400) * 86400


def test_flow_bars_api_source_isolation_coverage_and_limits(monkeypatch):
    import app as server
    from fastapi.testclient import TestClient

    monkeypatch.delenv("GEX_VIEWER_TOKEN", raising=False)
    engine = OrderFlowEngine()
    for contract, amount in [("BTC-PERPETUAL", 20), ("BTC-OPTIONS", 10)]:
        f = configured(contract)
        f.add(BASE, 100000, amount, 1)
        engine.by_contract[("DERIBIT", contract)] = f
    monkeypatch.setattr(server, "crypto_flow", engine)
    client = TestClient(server.app)
    perp = client.get("/api/flow/BTC/bars?interval=1m&src=perp&limit=10000").json()
    opts = client.get("/api/flow/BTC/bars?interval=1m&src=options").json()
    assert perp["bars"][0]["big_total"] == 20
    assert opts["bars"][0]["big_total"] == 10
    assert perp["unit"] == opts["unit"] == "USD"
    assert perp["first_observed_ts"] == perp["retained_from"] == perp["last_observed_ts"] == BASE
    assert perp["retention_bars"] == 420 and "no synthetic backfill" in perp["coverage"]
    assert client.get("/api/flow/BTC/bars?interval=bad").status_code == 422
    assert client.get("/api/flow/BTC/bars?interval=1m&offset=1800").status_code == 422
    hourly = client.get("/api/flow/BTC/bars?interval=1h&offset=1800").json()
    assert hourly["offset_s"] == 1800 and hourly["bars"][0]["t"] == BASE - 1800


def test_hourly_cash_half_hour_alignment_does_not_lose_or_mix_events():
    f = configured()
    for offset in [0, 1200, 2400]:
        f.add(BASE + offset, 6000, 10, 1)
    utc = f.bars_snapshot("1h")
    cash = f.bars_snapshot("1h@1800")
    assert len(utc) == 1 and utc[0]["big_total"] == 30
    assert [(b["t"], b["big_total"]) for b in cash] == [(BASE - 1800, 20), (BASE + 1800, 10)]
    assert all(b["interval_s"] == 3600 for b in cash)


def test_checkpoint_restores_all_intervals_and_deduplicates_seed(tmp_path):
    from flow_store import FlowStore
    store = FlowStore(tmp_path / 'flow.db', 'test')
    engine = OrderFlowEngine(store)
    key = ('DERIBIT', 'BTC-PERPETUAL')
    for i in range(80):
        for j in range(20):
            engine.add_trade(key,'BTC-PERPETUAL',BASE+i*60+j,100000,1,1,trade_id=f'{i}-small-{j}')
        for j in range(3):
            engine.add_trade(key,'BTC-PERPETUAL',BASE+i*60+20+j,100000,20000,1,trade_id=f'{i}-big-{j}')
    before = engine.bars(key,'1m',420)
    assert sum(b['big_n'] for b in before)==240
    assert sum(b['abs_n'] for b in before)==80
    engine.checkpoint()
    restored = OrderFlowEngine(store)
    assert restored.bars(key,'1m',420) == before
    restored.add_trade(key,'BTC-PERPETUAL',BASE+79*60+22,100000,20000,1,trade_id='79-big-2')
    assert restored.bars(key,'1m',420) == before
    assert restored.diagnostics(key,'1m')['observed_bars']==80
    assert OrderFlowEngine(FlowStore(tmp_path/'flow.db','other')).bars(key)==[]


def test_checkpoint_failure_is_reported_and_retry_preserves_data(tmp_path):
    from flow_store import FlowStore
    class FailingStore(FlowStore):
        fail = True
        def save(self, rows):
            if self.fail: raise OSError('synthetic disk failure')
            super().save(rows)
    store = FailingStore(tmp_path/'flow.db','test')
    engine = OrderFlowEngine(store)
    engine.add_trade(('X','ES'), 'ES', BASE, 6000, 10, 1)
    engine.checkpoint()
    assert engine.diagnostics(('X','ES'))['persistence_error']=='OSError'
    store.fail = False
    engine.checkpoint()
    assert engine.diagnostics(('X','ES'))['persistence_error'] is None
    assert len(OrderFlowEngine(store).bars(('X','ES')))==1


def test_trade_arriving_during_checkpoint_is_saved_on_next_flush(tmp_path):
    from flow_store import FlowStore
    key = ('X','ES')
    class ConcurrentStore(FlowStore):
        callback = None
        def save(self, rows):
            if self.callback:
                callback,self.callback = self.callback,None
                callback()
            super().save(rows)
    store = ConcurrentStore(tmp_path/'flow.db','test')
    engine = OrderFlowEngine(store)
    engine.add_trade(key,'ES',BASE,6000,10,1)
    store.callback = lambda: engine.add_trade(key,'ES',BASE+60,6000,10,1)
    engine.checkpoint()
    engine.checkpoint()
    assert len(OrderFlowEngine(store).bars(key,'1m'))==2


def test_native_contract_uses_root_tick_and_cme_session():
    f = SymbolFlow('GCZ6')
    assert f.tick == .1 and f.root == 'GC'
    f.add(datetime(2026,10,15,23,tzinfo=timezone.utc).timestamp(),4000,10,1)
    assert f.day == '2026-10-16'
    assert f.bars_snapshot('1d')[0]['t'] == BASE//86400*86400
