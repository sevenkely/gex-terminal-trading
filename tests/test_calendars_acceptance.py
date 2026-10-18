import dataclasses
from datetime import date
import math
import numpy as np
import pytest

from test_reliability import epoch,chain
from market_calendar import session_info,settlement_epoch
from basis import synchronized_projection
from acceptance import inspect_profile,run_sample
from pricing import model_inputs,rates_for
import gex


def test_cash_holiday_early_close_and_dst():
    assert not session_info('SPX',epoch('2026-11-26T10:00:00-05:00'))['open']
    assert session_info('SPY',epoch('2026-11-27T12:59:00-05:00'))['open']
    assert not session_info('SPY',epoch('2026-11-27T14:00:00-05:00'))['open']
    assert settlement_epoch(date(2026,11,27))==epoch('2026-11-27T13:00:00-05:00')
    assert settlement_epoch(date(2026,10,16))==epoch('2026-10-16T16:00:00-04:00')
    with pytest.raises(ValueError): settlement_epoch(date(2026,11,26))


def test_cme_maintenance_weekend_and_crypto():
    assert not session_info('ES',epoch('2026-10-16T17:15:00-04:00'))['open']
    assert not session_info('GC',epoch('2026-10-17T12:00:00-04:00'))['open']
    assert session_info('ES',epoch('2026-10-18T18:15:00-04:00'))['open']
    assert session_info('BTC',epoch('2026-10-17T12:00:00-04:00'))['open']


def test_synchronized_basis_rejects_bad_pair():
    now=10000
    a=dict(price=105,ts=9950,instrument='ES=F')
    b=dict(price=100,ts=9960,instrument='^SPX')
    assert synchronized_projection(a,b,'basis',now)['v']==5
    assert synchronized_projection(a,b,'ratio',now)['v']==1.05
    with pytest.raises(ValueError,match='unsynchronized'): synchronized_projection(a,{**b,'ts':9800},'basis',now)
    with pytest.raises(ValueError,match='stale'): synchronized_projection(a,b,'basis',15000)
    with pytest.raises(ValueError): synchronized_projection({**a,'price':float('nan')},b,'basis',now)


def test_acceptance_no_false_live_signoff():
    ch=chain();p=gex.compute_profile(ch,100,valuation_time=ch.ts_epoch)
    data={**p,'symbol':'SPX','meta':{'chain_ts_epoch':ch.ts_epoch,'mode':'SIM'}}
    report=inspect_profile(data,now=ch.ts_epoch)
    assert report['status']=='warning' and 'no_live_price' in report['warnings']
    data['net_gex']=[float('nan')]
    assert inspect_profile(data,now=ch.ts_epoch)['status']=='failed'


def test_model_curve_no_lookahead_and_invalid_file(monkeypatch,tmp_path):
    import json
    path=tmp_path/'rates.json';monkeypatch.setenv('GEX_MODEL_INPUTS',str(path))
    path.write_text(json.dumps({'SPX':{'asof':100,'rate':.03,'dividend_yield':.02,'curve':[[30,.03],[365,.05]]}}))
    result=model_inputs('SPX',200)
    ch=dataclasses.replace(chain(),**result)
    assert rates_for(ch,np.array([30/365.25,365/365.25])).tolist()==[.03,.05]
    assert model_inputs('SPX',99)['model_source']=='assumed_inputs_calibration_not_yet_known'
    path.write_text('{invalid')
    assert model_inputs('SPX',200)['model_source']=='assumed_inputs_invalid_calibration'


def test_gamma_matches_independent_scalar_call_price_second_derivative():
    # Independent scalar European option price, not the vector gamma formula.
    ch=dataclasses.replace(chain(now='2026-10-16T14:00:00-04:00',expiry='2027-10-16T14:00:00-04:00'),
                           rate=.05,dividend_yield=.02)
    def price(s,k,t,v):
        n=lambda x:.5*(1+math.erf(x/math.sqrt(2)))
        d1=(math.log(s/k)+(.05-.02+.5*v*v)*t)/(v*math.sqrt(t));d2=d1-v*math.sqrt(t)
        return s*math.exp(-.02*t)*n(d1)-k*math.exp(-.05*t)*n(d2)
    _,gamma,ts=gex._gamma_at(ch,100,'all',ch.ts_epoch)
    h=.01
    for i,k in enumerate(ch.strike):
        numerical=(price(100+h,k,ts[i],.2)-2*price(100,k,ts[i],.2)+price(100-h,k,ts[i],.2))/h**2
        assert gamma[i]==pytest.approx(numerical,rel=1e-5)


def test_zero_underflow_is_not_a_gamma_flip_and_no_phantom_put_wall():
    ch=dataclasses.replace(chain(),is_call=np.ones(3,dtype=bool),iv=np.full(3,.001))
    profile=gex.compute_profile(ch,100,valuation_time=ch.ts_epoch)
    assert profile['zero_gex'] is None
    assert profile['put_wall'] is None and profile['struct_put'] is None


def test_source_timestamp_not_fabricated():
    raw={'data':{'current_price':100,'last_trade_time':'invalid','options':[]}}
    with pytest.raises(ValueError,match='fabricated freshness'):gex.chain_from_cboe('SPX',raw)


def test_projection_recovers_aligned_bars_but_keeps_real_age(monkeypatch):
    import app as server
    from unittest.mock import AsyncMock,Mock
    import time
    now=time.time();old=now-3600
    monkeypatch.setitem(server.STATE,'chains',{'SPX':chain()})
    monkeypatch.setitem(server.STATE,'fmap',{})
    monkeypatch.setattr(server.history,'fetch_quote',Mock(side_effect=ValueError('No synchronous quotes')))
    bars=AsyncMock(return_value=[dict(t=old,v=1.,future_price=101.,cash_price=100.)])
    monkeypatch.setattr(server.basis_mod,'basis_series',bars)
    monkeypatch.setattr(server.engine,'rebase',Mock())
    server._update_futures_map()
    mapping=server.STATE['fmap']['ES']
    assert mapping['qts']==old and mapping['method']=='aligned_5m_closes'
    assert not server.projection_status('ES')['fresh']
    bars.return_value=[];server._update_futures_map()
    assert server.STATE['fmap']['ES']==mapping  # never substitute asynchronous quotes
