import time
from unittest.mock import Mock
import pytest
from backtest import evaluate
from event_journal import EventRecorder
from research import ResearchStore


def context(t=0,level=100,contract='ESZ6'):
    return dict(id=1,symbol='ES',recorded_at=t,chain_ts=t-10,price_mode='RITHMIC',contract=contract,
                projection={'fresh':True,'qts':t-10},levels=dict(available=True,call_wall=level))


def tick(t,price,contract='ESZ6',kind='price'):
    return dict(id=int(t*10),symbol='ES',kind=kind,received_at=t,occurred_at=t,
                payload=dict(mode='RITHMIC',price_type='direct_trade',price=price,contract=contract))


def run(contexts,events,**kw):
    return evaluate(contexts,events,symbol='ES',horizon=5,commission=2,spread_ticks=1,slippage_ticks=1,**kw)


def test_next_tick_fill_costs_and_mae_mfe():
    result=run([context()],[tick(1,99),tick(2,101),tick(3,102),tick(4,103),tick(8,104)])
    trade=result['trades'][0]
    assert trade['signal_at']==2 and trade['entry_at']==3 and trade['exit_at']==8
    assert trade['entry_price']==102.375 and trade['exit_price']==103.625
    assert trade['net_pnl_usd']==60.5
    assert result['summary']['evidence']=='insufficient_sample'


def test_future_levels_never_create_historical_signals():
    assert not run([context(t=5)],[tick(1,99),tick(2,101),tick(3,102),tick(8,104)])['trades']
    # A changed wall is not a crossing.
    assert not run([context(),context(t=1.5,level=98)],[tick(1,99),tick(2,99),tick(3,99),tick(8,99)])['trades']


def test_gap_rollover_and_split_purging():
    events=[tick(1,99),tick(2,101),tick(3,102),tick(8,104)]
    result=run([context()],events,split_at=5)
    assert not result['trades'] and result['rejected']['split_overlap']==1
    result=run([context()],[tick(1,99),tick(2,101),tick(3,102),tick(40,104)])
    assert not result['trades'] and result['rejected']['gaps']==1
    result=run([context()],[tick(1,99),tick(2,101),tick(3,102),tick(8,104,'ESH7')])
    assert not result['trades'] and result['rejected']['contract_switch']==1


def test_non_executable_proxy_rejected():
    e=tick(1,100);e['payload']['price_type']='index_or_proxy'
    assert run([context()],[e])['rejected']['invalid_price']==1
    with pytest.raises(ValueError): evaluate([],[],symbol='SPX')


def test_event_queue_is_opt_in_bounded_and_retries(tmp_path):
    recorder=EventRecorder(enabled=False,capacity=2)
    recorder.capture('ES','price',100,{'mode':'RITHMIC'})
    assert recorder.status()['queued']==0
    recorder.enabled=True
    recorder.capture('ES','price',100,{'mode':'SIM'})
    for i in range(3): recorder.capture('ES','price',100+i,{'mode':'RITHMIC','price':100+i},received_at=100+i)
    assert recorder.status()['queued']==2 and recorder.status()['dropped']==1
    bad=Mock();bad.save_events.side_effect=OSError('disk full')
    with pytest.raises(OSError): recorder.flush(bad)
    assert recorder.status()['queued']==2
    good=Mock();recorder.flush(good)
    assert recorder.status()['queued']==0 and recorder.status()['written']==2


def test_pagination_and_refusal_of_truncated_backtest(tmp_path):
    store=ResearchStore(tmp_path/'test.db');now=time.time()
    rows=[dict(symbol='ES',kind='price',occurred_at=now+i,received_at=now+i,payload={'price':100+i}) for i in range(3)]
    store.save_events(rows)
    first=store.event_page('ES',now-1,now+5,limit=2)
    assert len(first['rows'])==2 and first['has_more']
    second=store.event_page('ES',now-1,now+5,cursor=first['next_cursor'])
    assert len(second['rows'])==1 and not second['has_more']
    with pytest.raises(ValueError,match='truncated'): store.evaluation_data('ES','all',now-1,now+5,limit=2)


def test_event_ids_survive_full_retention_and_payloads_are_immutable(tmp_path):
    store=ResearchStore(tmp_path/'test.db');now=time.time()
    recorder=EventRecorder(enabled=True)
    payload={'mode':'RITHMIC','price':100,'nested':{'side':'buy'}}
    recorder.capture('ES','price',now,payload,received_at=now)
    payload['nested']['side']='sell';recorder.flush(store)
    first=store.event_page('ES',now-1,now+1)['rows'][0]
    assert first['payload']['nested']['side']=='buy'
    with store.lock,store._connect() as db:db.execute('DELETE FROM events')
    store.save_events([dict(symbol='ES',kind='price',occurred_at=now,received_at=now,payload={})])
    assert store.event_page('ES',now-1,now+1,cursor=first['id'])['rows'][0]['id']>first['id']


def test_paper_evaluation_api_and_validation(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from research_routes import build_research_router
    store=ResearchStore(tmp_path/'test.db');base=time.time()-1000
    row=context(t=base);store.save_snapshots([{**row,'filter':'all'}])
    events=[tick(base+1,99),tick(base+2,101),tick(base+3,102),tick(base+8,104)]
    store.save_events(events)
    app=FastAPI();recorder=EventRecorder()
    app.include_router(build_research_router(None,store,None,{},None,None,None,recorder,None))
    client=TestClient(app)
    body=dict(start=base,end=base+10,horizon=5,commission=2,spread_ticks=1,slippage_ticks=1)
    response=client.post('/api/backtest/ES',json=body)
    assert response.status_code==200
    assert response.json()['summary']['trades']==1 and not response.json()['coverage_verified']
    assert client.post('/api/backtest/ES',json={**body,'end':base-1}).status_code==422
    assert client.post('/api/backtest/SPX',json=body).status_code==422


def test_crossing_through_an_exact_level_and_expiring_projection():
    result=run([context()],[tick(1,99),tick(2,100),tick(3,101),tick(4,102),tick(9,104)])
    assert result['trades'][0]['signal_at']==3  # touch alone is not a crossing
    old=context();old['projection']['qts']=-1797.5
    result=run([old],[tick(1,99),tick(2,101),tick(3,102),tick(8,104)])
    assert not result['trades'] and result['rejected']['stale_or_unavailable_context']>0


def test_invalid_vendor_event_does_not_poison_flush(tmp_path):
    store=ResearchStore(tmp_path/'test.db');now=time.time();recorder=EventRecorder(enabled=True)
    recorder.capture('BTC','option_trade',now,{'iv':float('nan')})
    recorder.capture('BTC','option_trade',now,{'iv':None})
    recorder.flush(store)
    assert recorder.status()['dropped']==1 and recorder.status()['written']==1
