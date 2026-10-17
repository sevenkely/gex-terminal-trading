"""Offline browser fixture. Synthetic data only. Never used by production app.
Run: PYTHONPATH=backend:tests .venv/bin/uvicorn ui_fixture:app --host 0.0.0.0 --port 8010
"""
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import numpy as np
import app as server
import gex

@asynccontextmanager
async def fixture_lifespan(app):
    yield

server.app.router.lifespan_context = fixture_lifespan
now=time.time()
day=datetime.fromtimestamp(now, gex.ET).replace(hour=23,minute=59,second=0).timestamp()
for sym in ('SPX','SPY','BTC'):
    spot=6000. if sym=='SPX' else 600. if sym=='SPY' else 100000.
    k=np.repeat(np.linspace(spot*.97,spot*1.03,31),2)
    isc=np.tile([True,False],31)
    ch=gex.Chain(sym,spot,spot*.99,spot,spot*1.01,spot*.99,20.,datetime.now(gex.ET).isoformat(),now,k,isc,
       np.where(isc,100.,80.),np.full(len(k),.2),np.zeros(len(k)),np.full(len(k),day),np.full(len(k),(day-now)/86400), 1. if sym=='BTC' else 100.)
    server.STATE['chains'][sym]=ch
    server.engine.seed(sym,spot,20.)
    server.engine.modes[sym]='SIM'
server.STATE['next_refresh']=now+900

async def fixture_history(sym, interval='1d'):
    spot=server.engine.price(sym)
    if not spot: return []
    period=86400 if interval=='1d' else 300
    start=int(now//period)*period-60*period
    return [dict(time=datetime.fromtimestamp(start+i*period, gex.ET).date().isoformat() if interval=='1d' else start+i*period,open=spot+i*.03,high=spot+i*.03+1,low=spot+i*.03-1,close=spot+i*.03+.5,volume=100+i) for i in range(60)]
server.history.fetch_history=fixture_history
app=server.app
