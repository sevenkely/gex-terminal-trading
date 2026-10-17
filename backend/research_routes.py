"""Read-only research APIs, separated from feed orchestration."""
from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel, Field, model_validator, ConfigDict
from typing import Literal
import threading
import time
import backtest
import risk


class BacktestRequest(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False)
    start: float = Field(gt=0)
    end: float = Field(gt=0)
    filter: Literal['all','0dte','weekly','monthly']='all'
    level: Literal['call_wall','put_wall','zero_gex']='call_wall'
    strategy: Literal['breakout','reversion']='breakout'
    horizon: float = Field(60,ge=1,le=3600)
    split_at: float | None = None
    commission: float = Field(ge=0,le=1000)
    spread_ticks: float = Field(ge=0,le=100)
    slippage_ticks: float = Field(ge=0,le=100)

    @model_validator(mode='after')
    def valid_window(self):
        if not 0 < self.end-self.start <= 7*86400 or self.end>time.time()+5:
            raise ValueError('Window must be ordered, at most 7 days, not future.')
        if self.split_at is not None and not self.start<self.split_at<self.end:
            raise ValueError('Split must be strictly inside the window.')
        return self


def build_research_router(option_tape, research_store, crypto_feed, FUTURES, _chain_for, _to_src, engine, event_recorder, licensed_option_tape):
    router = APIRouter()
    @router.get("/api/option-flow/{symbol}")
    def api_option_flow(symbol: str, minimum: float = Query(0, ge=0, le=1e9, allow_inf_nan=False),
                        kind: str = Query("all", pattern="^(all|C|P)$"),
                        expiry: str = Query("all", pattern="^(all|0dte)$"),
                        limit: int = Query(100, ge=1, le=500)):
        if symbol.upper() != "BTC":
            return licensed_option_tape.snapshot(symbol.upper(),minimum,kind,expiry,limit)
        return {**option_tape.snapshot(minimum, kind, expiry, limit),
                "live":crypto_feed.status["state"] == "connected", "source":"DERIBIT"}


    @router.get("/api/replay/{symbol}")
    def api_replay(symbol: str, filter: str = Query("all", pattern="^(all|0dte|weekly|monthly)$"),
                   limit: int = Query(240, ge=1, le=1000),
                   before: float | None = Query(None, gt=0, allow_inf_nan=False)):
        rows = research_store.replay(symbol.upper(), filter, limit, before)
        return {"available":bool(rows), "rows":rows,
                "limitation":"Échantillons enregistrés toutes les 30 s depuis le démarrage, pas un replay tick par tick. Prix différés/périmés identifiés ; aucune donnée future utilisée."}


    @router.get("/api/oi-history/{symbol}")
    def api_oi_history(symbol: str):
        sym = symbol.upper()
        source = FUTURES.get(sym, {}).get("src", sym)
        rows = research_store.oi_history(source)
        return {"available":bool(rows), "source":source, "rows":rows,
                "limitation":"Dernier snapshot observé de chaque jour, pas la date officielle de publication de l'OI. Variations d'OI agrégé incluant expirations et changements de couverture ; aucune inférence fiable d'ouverture/fermeture intraday."}


    @router.get("/api/risk/{symbol}")
    def api_risk(symbol: str, filter: str = Query("all", pattern="^(all|0dte|weekly|monthly)$")):
        sym = symbol.upper()
        chain = _chain_for(sym)
        if chain is None:
            return {"available":False, "reason":"Chaîne indisponible"}
        return {**risk.sensitivities(chain, _to_src(sym, engine.price(sym)), filter),
                "source":FUTURES.get(sym, {}).get("src", sym)}


    @router.get("/api/recording")
    def recording_status():
        return event_recorder.status()

    @router.get("/api/replay-events/{symbol}")
    def replay_events(symbol: str, start: float = Query(gt=0,allow_inf_nan=False),
                      end: float = Query(gt=0,allow_inf_nan=False), cursor: int = Query(0,ge=0),
                      limit: int = Query(1000,ge=1,le=10000)):
        if not 0<end-start<=86400:
            raise HTTPException(422,'Event replay window must be <=24h and ordered')
        return {**research_store.event_page(symbol.upper(),start,end,cursor,limit),
                'ordering':'arrival id, separate source and receipt times',
                'coverage':'Only recorded events. No guarantee of complete exchange tick coverage.'}

    evaluation_slot=threading.BoundedSemaphore(1)

    @router.post("/api/backtest/{symbol}")
    def evaluate_recorded(symbol: str, request: BacktestRequest):
        if not evaluation_slot.acquire(blocking=False):
            raise HTTPException(429,'One evaluation at a time; retry later')
        try:
            snapshots,events=research_store.evaluation_data(symbol.upper(),request.filter,request.start,request.end)
            params=request.model_dump(exclude={'start','end','filter'})
            result=backtest.evaluate(snapshots,events,symbol=symbol.upper(),**params)
            return {**result,'recording':event_recorder.status(),
                    'window':{'start':request.start,'end':request.end},'coverage_verified':False}
        except ValueError as exc:
            raise HTTPException(422,str(exc))
        finally:
            evaluation_slot.release()

    return router
