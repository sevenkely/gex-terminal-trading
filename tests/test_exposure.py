import dataclasses
import numpy as np
import pytest
import gex
import risk
from exposure import grid
from test_calendars_acceptance import chain


def test_gamma_grid_conserves_exposure_and_counts():
    ch=chain();result=grid(ch,100,band=.15,now=ch.ts_epoch)
    assert result['available']
    assert np.array(result['values']).sum()==pytest.approx(gex.gex_at(ch,100,valuation_time=ch.ts_epoch).sum())
    assert np.array(result['counts']).sum()==3
    assert result['unit']=='USD / +1% spot' and not result['truncated']


def test_vanna_grid_conserves_local_sensitivity():
    ch=chain();result=grid(ch,100,metric='vanna',band=.15,now=ch.ts_epoch)
    assert np.array(result['values']).sum()==pytest.approx(risk.sensitivities(ch,100,valuation_time=ch.ts_epoch)['vanna_usd_per_vol_point'])


def test_grid_empty_no_fallback_and_bounded():
    ch=chain()
    result=grid(dataclasses.replace(ch,exp_epoch=ch.exp_epoch+3*86400),100,'0dte',now=ch.ts_epoch)
    assert not result['available'] and not result['strikes']
    result=grid(ch,100,band=.15,now=ch.ts_epoch,max_strikes=1)
    assert len(result['strikes'])==1 and result['truncated']
    expired=dataclasses.replace(ch,exp_epoch=np.full(3,ch.ts_epoch-1))
    assert not grid(expired,100,now=ch.ts_epoch)['available']
    with pytest.raises(ValueError):grid(ch,0)


def test_exposure_api_and_projection(monkeypatch):
    import app as server
    from fastapi.testclient import TestClient
    import time
    ch=chain();now=time.time()
    ch=dataclasses.replace(ch,ts_epoch=now,exp_epoch=np.full(3,now+86400))
    monkeypatch.setattr(server,'_chain_for',lambda sym: ch if sym in ('SPX','ES') else None)
    monkeypatch.setattr(server.engine,'price',lambda sym:101 if sym=='ES' else 100)
    monkeypatch.setattr(server,'_to_src',lambda sym,px:100)
    monkeypatch.setattr(server,'chain_status',lambda *args:{})
    monkeypatch.setitem(server.STATE,'fmap',{'ES':{'kind':'basis','v':1}})
    # Exercise a current fixture and the projected coordinate path.
    client=TestClient(server.app)
    assert client.get('/api/exposure/SPX?metric=delta').status_code==422
    assert client.get('/api/exposure/SPX?band=nan').status_code==422
    assert not client.get('/api/exposure/UNKNOWN').json()['available']
    response=client.get('/api/exposure/ES?band=.15').json()
    assert response['spot']==101 and response['source_symbol']=='SPX'
    assert response['strikes']==[96.,101.,106.] and response['available']
    assert 'projection non native' in response['unit']


def test_missing_cells_are_distinct_from_observed_zero():
    ch=chain();ch=dataclasses.replace(ch,strike=np.array([100.,100.,105.]),is_call=np.array([True,False,True]),oi=np.full(3,100.),exp_epoch=np.array([ch.exp_epoch[0],ch.exp_epoch[0],ch.exp_epoch[0]+86400]))
    result=grid(ch,100,band=.15,now=ch.ts_epoch)
    assert result['values'][0][0]==0 and result['counts'][0][0]==2
    assert result['counts'][0][1]==0 and result['counts'][1][0]==0
