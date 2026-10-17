import asyncio
import json
import time
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from access import new_session,valid_session,RequestLimits
from operations import backup_database,restore_database
from option_ingest import OptionObservation,LicensedOptionTape
from research import ResearchStore


def observation(**values):
    now=time.time()
    return OptionObservation(source='licensed-test',trade_id='1',symbol='SPY',instrument='test-SPY-option',
        ts=now-1,expiry=now+86400,strike=600,option_type='C',amount=2,price_usd=3,multiplier=100,**values)


def test_cookie_expires_and_token_rotation(monkeypatch):
    monkeypatch.setenv('GEX_VIEWER_TOKEN','viewer-test-token')
    cookie=new_session(now=100)
    assert valid_session(cookie,now=101)
    assert not valid_session(cookie,now=3701)
    assert not valid_session(cookie+'x',now=101)
    monkeypatch.setenv('GEX_VIEWER_TOKEN','rotated-token')
    assert not valid_session(cookie,now=101)


def test_quotas_bounded_and_websockets_released():
    limits=RequestLimits(max_clients=2)
    assert all(limits.allow('a','login',now=0) for _ in range(10))
    assert not limits.allow('a','login',now=1)
    assert limits.allow('a','login',now=61)
    assert limits.allow('b',now=61)
    assert not limits.allow('c',now=61)
    assert all(limits.open_ws('a') for _ in range(8))
    assert not limits.open_ws('a')
    for _ in range(8): limits.close_ws('a')
    assert limits.total_ws==0 and not limits.active_ws


def test_backup_restore_integrity_and_no_overwrite(tmp_path):
    source=tmp_path/'live.db';store=ResearchStore(source);store.save_snapshots([])
    target=tmp_path/'backup.db';backup_database(source,target)
    assert target.exists() and (tmp_path/'backup.db.manifest.json').exists()
    with pytest.raises(ValueError): backup_database(source,target)
    with pytest.raises(ValueError): restore_database(target,tmp_path/'restore.db')
    restore_database(target,tmp_path/'restore.db',server_stopped=True)
    with target.open('ab') as file:file.write(b'corrupt-checksum')
    with pytest.raises(ValueError,match='checksum'): restore_database(target,tmp_path/'bad.db',server_stopped=True)


def test_options_no_guessing_and_batch_atomicity(monkeypatch):
    tape=LicensedOptionTape()
    monkeypatch.setenv('GEX_OPTION_FEED_SOURCE','licensed-test');monkeypatch.setenv('GEX_OPTION_FEED_SYMBOLS','SPY')
    obs=observation();assert tape.ingest([obs])==1 and tape.ingest([obs])==0
    data=tape.snapshot('SPY');row=data['rows'][0]
    assert row['premium_usd']==600 and row['side']=='unknown' and row['position_effect']=='unknown'
    assert not data['provider']['entitlement_verified']
    other=obs.model_copy(update={'trade_id':'2','source':'not-approved'})
    with pytest.raises(ValueError): tape.ingest([obs.model_copy(update={'trade_id':'3'}),other])
    assert tape.accepted==1
    with pytest.raises(ValidationError): observation(bid=1,ask=.5,quote_ts=time.time()-1)


def test_read_gate_api_websocket_and_ingestion(monkeypatch):
    import app as server
    monkeypatch.setenv('GEX_VIEWER_TOKEN','viewer-test-token')
    monkeypatch.setenv('GEX_INGEST_TOKEN','ingest-test-token')
    monkeypatch.setenv('GEX_ADMIN_TOKEN','admin-test-token')
    monkeypatch.setattr(server,'request_limits',RequestLimits())
    client=TestClient(server.app)
    assert client.get('/api/diagnostics').status_code==401
    assert client.get('/api/access').json()['required']
    assert client.get('/api/health').status_code==200
    assert client.post('/api/session',json={'token':'bad'}).status_code==401
    response=client.post('/api/session',json={'token':'viewer-test-token'})
    assert response.status_code==200 and 'HttpOnly' in response.headers['set-cookie']
    assert client.get('/api/diagnostics').status_code==200
    assert client.get('/api/rithmic').status_code==401 # viewer != admin
    assert client.post('/api/session',json={'token':'viewer-test-token'},headers={'Origin':'https://evil.example'}).status_code==403
    assert client.delete('/api/session').status_code==200
    assert client.get('/api/diagnostics').status_code==401
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/ws/SPX'): pass
    # Ingest token bypasses viewer gate only on the ingestion endpoint.
    monkeypatch.setenv('GEX_OPTION_FEED_SOURCE','licensed-test');monkeypatch.setenv('GEX_OPTION_FEED_SYMBOLS','SPY')
    body={'trades':[observation().model_dump()]}
    assert client.post('/api/ingest/options',json=body).status_code==401
    assert client.post('/api/ingest/options',json=body,headers={'Authorization':'Bearer ingest-test-token'}).status_code==200
    assert client.get('/api/diagnostics',headers={'Authorization':'Bearer ingest-test-token'}).status_code==401


def test_rollover_detection_without_reconnect():
    from rithmic_bridge import RithmicBridge
    from live_feed import PriceEngine
    from unittest.mock import AsyncMock,patch
    with patch('rithmic_bridge.os.path.exists',return_value=False):
        bridge=RithmicBridge(PriceEngine())
    bridge.status['state']='connected'
    bridge.status['contracts']={'ES':{'contract':'ESZ6'}}
    client=Mock();client.get_front_month_contract=AsyncMock(return_value='ESH7');bridge.client=client
    asyncio.run(bridge.check_rollover())
    assert bridge.status['rollover']['pending'][0]['recommended']=='ESH7'
    assert bridge.status['contracts']['ES']['contract']=='ESZ6'
    client.disconnect.assert_not_called()


def test_streamed_body_limit_without_content_length(monkeypatch):
    import app as server
    monkeypatch.setattr(server,'request_limits',RequestLimits())
    client=TestClient(server.app)
    chunks=(b'x'*1024*1024 for _ in range(3))
    response=client.post('/api/session',content=chunks,headers={'Content-Type':'application/json','Transfer-Encoding':'chunked'})
    assert response.status_code==413


def test_rithmic_connects_market_data_only(monkeypatch):
    from unittest.mock import AsyncMock
    import async_rithmic
    import rithmic_bridge
    client=Mock();client.connect=AsyncMock()
    monkeypatch.setattr(async_rithmic,'RithmicClient',Mock(return_value=client))
    monkeypatch.setattr(rithmic_bridge.RithmicBridge,'_load',lambda self:dict(
        user='fixture-data-user',password='fixture-only',system_name='test',
        url='wss://rprotocol-ie.rithmic.com:443',mappings={}))
    monkeypatch.setattr(rithmic_bridge.os.path,'exists',lambda path:False)
    bridge=rithmic_bridge.RithmicBridge(Mock())
    asyncio.run(bridge._connect_flow())
    client.connect.assert_awaited_once_with(plants=[async_rithmic.SysInfraType.TICKER_PLANT])
