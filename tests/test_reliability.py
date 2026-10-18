"""Offline regression tests: actual dashboard engine, fixed valuation clocks."""
import asyncio
import dataclasses
from datetime import datetime, timezone
from unittest.mock import patch

import numpy as np
import pytest
from fastapi.testclient import TestClient

import gex
import derivs
from live_feed import PriceEngine
from security import admin_authorized, allowed_origin, validate_gateway


def epoch(value):
    return datetime.fromisoformat(value).timestamp()


def chain(symbol='SPX', now='2026-10-16T14:00:00-04:00', expiry='2026-10-16T16:00:00-04:00'):
    t, e = epoch(now), epoch(expiry)
    return gex.Chain(symbol, 100., 99., 99., 101., 98., 20., now, t,
        np.array([95., 100., 105.]), np.array([False, True, True]),
        np.array([80., 100., 60.]), np.array([.20, .20, .20]),
        np.zeros(3), np.full(3, e), np.full(3, (e-t)/86400))


def test_0dte_live_and_after_expiry():
    ch = chain()
    p = gex.compute_profile(ch, 100, '0dte', valuation_time=ch.ts_epoch)
    assert p['available'] and p['filtered_contracts'] == 3
    assert p['strikes'] and any(p['net_gex'])
    after = gex.compute_profile(ch, 100, '0dte', valuation_time=epoch('2026-10-16T16:01:00-04:00'))
    assert not after['available'] and after['strikes'] == []
    assert after['regime'] == 'unavailable'
    assert after['call_wall'] is None and after['gamma_flip'] is None
    assert after['reason']


def test_weekend_does_not_use_friday_or_monday_as_0dte():
    ch = chain(expiry='2026-10-19T16:00:00-04:00')
    p = gex.compute_profile(ch, 100, '0dte', valuation_time=epoch('2026-10-17T10:00:00-04:00'))
    assert not p['available']
    assert gex.compute_profile(ch, 100, 'weekly', valuation_time=ch.ts_epoch)['available']


def test_dst_winter_0dte():
    ch = chain(now='2026-12-18T10:00:00-05:00', expiry='2026-12-18T16:00:00-05:00')
    assert gex._mask_for(ch, '0dte', ch.ts_epoch).all()
    assert not gex._mask_for(ch, '0dte', ch.exp_epoch[0]).any()


def test_btc_0dte_uses_utc_and_excludes_settled_contracts():
    ch = chain(symbol='BTC', now='2026-10-17T07:00:00+00:00', expiry='2026-10-17T08:00:00+00:00')
    assert gex._mask_for(ch, '0dte', ch.ts_epoch).all()
    assert not gex._mask_for(ch, '0dte', epoch('2026-10-17T09:00:00+00:00')).any()
    # Midnight UTC is still prior calendar day in New York.
    ch = chain(symbol='BTC', now='2026-10-17T00:01:00+00:00', expiry='2026-10-17T08:00:00+00:00')
    assert gex._mask_for(ch, '0dte', ch.ts_epoch).all()


def test_time_decay_and_expired_options():
    ch = chain()
    g0 = gex.gex_at(ch, 100, '0dte', ch.ts_epoch)
    g1 = gex.gex_at(ch, 100, '0dte', ch.ts_epoch + 3600)
    assert g1[1] > g0[1]
    assert not gex.gex_at(ch, 100, 'all', ch.exp_epoch[0]).any()


def test_max_pain_shared_and_matches_bruteforce():
    k = np.array([90., 100., 110.])
    c, p = np.array([0., 100., 0.]), np.array([1., 0., 0.])
    assert gex.max_pain(k, c, p) == derivs._max_pain(k, c, p) == 90.
    # Unique minimum: old reversed payout returned 110, correct result is 100.
    c, p = np.array([15.,83.,65.]), np.array([36.,8.,70.])
    assert gex.max_pain(k, c, p) == derivs._max_pain(k, c, p) == 100.
    rng = np.random.default_rng(42)
    for _ in range(30):
        c, p = rng.integers(0, 100, (2, 3))
        pay = [np.maximum(x-k, 0) @ c + np.maximum(k-x, 0) @ p for x in k]
        assert gex.max_pain(k, c, p) == k[np.argmin(pay)]
    assert gex.max_pain([], [], []) is None


def test_zero_gamma_and_flip_are_identical():
    ch = chain()
    p = gex.compute_profile(ch, 100, valuation_time=ch.ts_epoch)
    assert p['gamma_flip'] == p['zero_gex'] == p['walls']['flip']


def test_zero_oi_is_not_long_gamma():
    ch = dataclasses.replace(chain(), oi=np.zeros(3))
    p = gex.compute_profile(ch, 100, valuation_time=ch.ts_epoch)
    assert not p['available'] and p['regime'] == 'unavailable'


def test_cboe_timezone_and_am_pm():
    raw = {'data': {'last_trade_time': '2026-10-16T14:00:00Z', 'current_price':100,
        'options': [dict(option='SPX261016C00100000', open_interest=5, iv=.2),
                    dict(option='SPXW261016C00100000', open_interest=5, iv=.2)]}}
    ch = gex.chain_from_cboe('SPX', raw)
    assert ch.ts_epoch == epoch('2026-10-16T14:00:00+00:00')
    assert ch.exp_epoch[0] == epoch('2026-10-16T16:00:00-04:00') # AM already settled, only SPXW left


def test_feed_stale_does_not_mutate_into_sim(monkeypatch):
    monkeypatch.delenv('GEX_DEMO_MODE', raising=False)
    e = PriceEngine()
    e.seed('ES', 100, 20)
    assert e.mode_for('ES') == 'DELAYED'
    e.set_external('ES', 102, 1000)
    with patch('live_feed.time.time', return_value=1100):
        assert e.mode_for('ES') == 'STALE'
        assert e.modes['ES'] == 'RITHMIC'
        assert e.price('ES') == 102
    e.drop_external('ES')
    assert e.mode_for('ES') == 'STALE'
    e.rebase('ES', 99, 20)
    assert e.price('ES') == 102


def test_explicit_demo_only(monkeypatch):
    monkeypatch.setenv('GEX_DEMO_MODE', 'true')
    e = PriceEngine(); e.seed('ES', 100, 20)
    assert e.mode_for('ES') == 'SIM'
    e.set_external('ES', 101, 1000)
    e.drop_external('ES')
    assert e.mode_for('ES') == 'STALE' # even demo cannot silently take over a real feed


def test_admin_and_gateways(monkeypatch):
    monkeypatch.setenv('GEX_ADMIN_TOKEN', 'test-only-token')
    assert admin_authorized('Bearer test-only-token')
    assert not admin_authorized('Bearer wrong')
    assert not admin_authorized('')
    assert allowed_origin('https://preview.e2b.app', 'preview.e2b.app')
    assert not allowed_origin('https://evil.example', 'preview.e2b.app')
    assert validate_gateway('rprotocol-ie.rithmic.com:443').startswith('wss://')
    for bad in ['wss://127.0.0.1:443', 'wss://rprotocol-ie.rithmic.com.evil.test',
                'ws://rprotocol-ie.rithmic.com', 'wss://u:p@rprotocol-ie.rithmic.com',
                'wss://rprotocol-ie.rithmic.com:80', 'wss://rprotocol-ie.rithmic.com/path']:
        with pytest.raises(ValueError): validate_gateway(bad)


def test_dashboard_api_empty_state_and_security(monkeypatch):
    import app as server
    monkeypatch.setenv('GEX_ADMIN_TOKEN', 'test-only-token')
    ch = chain(now=datetime.now(timezone.utc).isoformat(), expiry='2099-10-19T16:00:00-04:00')
    monkeypatch.setitem(server.STATE['chains'], 'SPX', ch)
    server.engine.seed('SPX', 100, 20)
    server.PROFILE_CACHE.clear()
    # No context manager: avoid lifespan and all live network feeds.
    client = TestClient(server.app)
    response = client.get('/api/gex/SPX?filter=0dte')
    assert response.status_code == 200
    data = response.json()
    assert not data['available'] and data['strikes'] == []
    assert data['meta']['filtered_contracts'] == 0
    assert data['meta']['next_expiry']
    assert client.post('/api/rithmic/disconnect').status_code == 401
    headers = {'Authorization':'Bearer test-only-token'}
    assert client.get('/api/rithmic', headers=headers).status_code == 200
    assert client.get('/api/rithmic', headers={**headers, 'Origin':'https://evil.example'}).status_code == 403
    assert client.get('/api/rithmic/discover?url=wss://127.0.0.1', headers=headers).status_code == 422
    assert client.post('/api/rithmic/config', headers=headers, json={'url':'wss://127.0.0.1'}).status_code == 422
    assert client.get('/api/heatmap/SPX?mode=hist&filter=0dte').json()['available'] is False


def test_bridge_does_not_persist_secret(monkeypatch, tmp_path):
    import json
    import rithmic_bridge as rb
    monkeypatch.setattr(rb, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(rb, 'CONFIG_PATH', str(tmp_path / 'config.json'))
    b = rb.RithmicBridge(PriceEngine())
    b.update_config({'password':'fake-test-secret', 'user':'test-user'})
    saved = json.loads((tmp_path / 'config.json').read_text())
    assert 'password' not in saved
    assert b.config['password'] == 'fake-test-secret'
    assert b.public()['password'] != 'fake-test-secret'
    assert (tmp_path / 'config.json').stat().st_mode & 0o777 == 0o600


def test_profile_cache_is_shared_and_window_is_part_of_key(monkeypatch):
    import app as server
    ch = chain(now=datetime.now(timezone.utc).isoformat(), expiry='2099-10-19T16:00:00-04:00')
    monkeypatch.setitem(server.STATE['chains'], 'SPX', ch)
    server.engine.seed('SPX', 100, 20)
    server.PROFILE_CACHE.clear()
    with patch('app.gex.compute_profile', wraps=gex.compute_profile) as fn:
        a = server.level_snapshot('SPX', 'all', True, .03)
        b = server.level_snapshot('SPX', 'all', False, .03)
        assert a is b and fn.call_count == 1
        server.level_snapshot('SPX', 'all', True, .05)
        assert fn.call_count == 2


def test_numeric_validation_and_admin_schema(monkeypatch):
    import app as server
    monkeypatch.setenv('GEX_ADMIN_TOKEN','test-only-token')
    client=TestClient(server.app)
    for path in ('/api/gex/SPX?win=nan', '/api/scenario/SPX?div=inf',
                 '/api/heatmap/SPX?range=nan', '/api/option-flow/BTC?minimum=nan'):
        assert client.get(path).status_code==422
    headers={'Authorization':'Bearer test-only-token'}
    assert client.post('/api/rithmic/config', headers=headers,json={'enabled':'nonsense'}).status_code==422
    assert client.post('/api/rithmic/config', headers=headers,json={'mappings':{'ES':{'mode':'invalid'}}}).status_code==422


def test_no_future_or_out_of_order_prices(monkeypatch):
    e=PriceEngine();e.seed('ES',100,20)
    e.set_external('ES',101,1000)
    e.set_external('ES',99,900)
    e.set_external('ES',float('nan'),1001)
    assert e.price('ES')==101


def test_scenario_time_and_risk_sensitivities(monkeypatch):
    import math
    import risk
    import app as server
    now=epoch('2026-10-16T14:00:00-04:00')
    ch=chain()
    result=risk.sensitivities(ch,100,'0dte',now)
    assert result['available']
    # Compare analytic BS delta derivatives with central finite differences.
    def dollar_delta(vol_shift=0., time_shift=0.):
        total=0.
        for k,vol,oi,call,e in zip(ch.strike,ch.iv,ch.oi,ch.is_call,ch.exp_epoch):
            t=(e-now-time_shift)/gex.YEAR_SECONDS
            v=vol+vol_shift
            d1=(math.log(100/k)+(gex.RISK_FREE+.5*v*v)*t)/(v*math.sqrt(t))
            delta=.5*(1+math.erf(d1/math.sqrt(2))) - (0 if call else 1)
            total += (1 if call else -1)*oi*ch.multiplier*100*delta
        return total
    eps=1e-6
    vanna=(dollar_delta(eps)-dollar_delta(-eps))/(2*eps)*.01
    charm=(dollar_delta(time_shift=.1)-dollar_delta(time_shift=-.1))/.2*86400
    assert result['vanna_usd_per_vol_point']==pytest.approx(vanna,rel=1e-5)
    assert result['charm_usd_per_calendar_day']==pytest.approx(charm,rel=1e-5)
    monkeypatch.setitem(server.STATE['chains'],'SPX',ch)
    server.engine.seed('SPX',100,20)
    with patch('app.time.time',return_value=now):
        client=TestClient(server.app)
        today=client.get('/api/scenario/SPX?filter=0dte&minutes=0').json()
        expired=client.get('/api/scenario/SPX?filter=0dte&minutes=125').json()
    assert today['available'] and not expired['available']


def test_flow_cme_session_reset_and_crypto_utc():
    from flow import SymbolFlow
    es=SymbolFlow('ES')
    es.add(epoch('2026-10-15T18:01:00-04:00'),100,10,1)
    es.add(epoch('2026-10-16T10:00:00-04:00'),100,10,1)
    assert es.delta==20
    es.add(epoch('2026-10-16T18:00:00-04:00'),100,5,2)
    assert es.delta==-5 and es.day=='2026-10-17'
    assert len(es.recent)==1
    assert SymbolFlow('GC').tick==.1
    btc=SymbolFlow('BTC-PERPETUAL')
    btc.add(epoch('2026-10-16T23:59:00+00:00'),100,10,1)
    btc.add(epoch('2026-10-17T00:01:00+00:00'),100,5,2)
    assert btc.delta==-5
