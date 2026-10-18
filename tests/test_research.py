from datetime import datetime, timezone
import dataclasses
import time

from research import OptionTape, ResearchStore
from test_reliability import chain


def test_options_are_observed_filtered_and_native_ids_deduplicated():
    tape = OptionTape(limit=3)
    tape.add(time.time(), .01, 2, 'buy', 'BTC-20OCT26-100000-C', 100000, 'one', 55.)
    tape.add(time.time(), .01, 2, 'buy', 'BTC-20OCT26-100000-C', 100000, 'one', 55.)
    tape.add(time.time(), .02, 3, 'sell', 'BTC-20OCT26-90000-P', 100000, 'two')
    tape.add(time.time(), .02, 3, 'sell', 'BTC-PERPETUAL', 100000, 'bad')
    tape.add(float('nan'), .02, 3, 'sell', 'BTC-20OCT26-90000-P', 100000, 'nan')
    data=tape.snapshot()
    assert data['sample_count']==2
    assert data['rows'][1]['premium_usd']==2000
    assert data['rows'][1]['position_effect']=='unknown'
    assert data['rows'][1]['bid'] is None
    assert tape.snapshot(kind='P')['sample_count']==1
    assert tape.snapshot(minimum=3000)['sample_count']==1
    assert sum(c['prints'] for c in data['concentrations'])==2


def test_recorded_replay_preserves_known_levels_and_retention(tmp_path):
    store=ResearchStore(tmp_path/'test.db')
    now=time.time()
    rows=[dict(symbol='SPX',filter='all',recorded_at=now-2,levels={'call_wall':100}),
          dict(symbol='SPX',filter='all',recorded_at=now,levels={'call_wall':105}),
          dict(symbol='SPX',filter='0dte',recorded_at=now,levels={'call_wall':110}),
          dict(symbol='SPX',filter='all',recorded_at=now-8*86400,levels={'call_wall':1})]
    store.save_snapshots(rows)
    assert [r['levels']['call_wall'] for r in store.replay('SPX')]==[100,105]
    assert store.replay('SPX',before=now-1)[0]['levels']['call_wall']==100
    assert store.replay('SPX','0dte')[0]['levels']['call_wall']==110
    assert store.replay('ES')==[]


def test_daily_oi_observations(tmp_path):
    store=ResearchStore(tmp_path/'test.db')
    ch=chain(now=datetime.now(timezone.utc).isoformat(),expiry='2099-10-19T16:00:00-04:00')
    store.record_oi('SPX', ch)
    store.record_oi('SPX', dataclasses.replace(ch,oi=ch.oi*2))
    rows=store.oi_history('SPX')
    assert len(rows)==1
    assert rows[0]['call_oi']==320
    assert rows[0]['put_oi']==160
