"""Licensed-feed boundary. Normalized incoming observations, no fake provider.

Requires an explicit source, allowlisted underlyings and a separate ingest token.
A vendor-specific bridge must map its licensed fields to this schema; absence of
quotes/position effect remains unknown, never inferred from the call/put type.
"""
from collections import deque
from datetime import datetime, timezone
import hmac
import os
import threading
import time
from typing import Literal
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field, ConfigDict, model_validator


class OptionObservation(BaseModel):
    model_config=ConfigDict(extra='forbid',allow_inf_nan=False,str_max_length=128)
    source: str = Field(min_length=1)
    trade_id: str = Field(min_length=1)
    symbol: Literal['SPX','SPY','QQQ','GLD','ES','NQ','GC']
    instrument: str = Field(min_length=1)
    ts: float = Field(gt=0)
    expiry: float = Field(gt=0)
    strike: float = Field(gt=0)
    option_type: Literal['C','P']
    amount: float = Field(gt=0,le=1e9)
    price_usd: float = Field(gt=0,le=1e9)
    multiplier: float = Field(gt=0,le=1e6)
    side: Literal['buy','sell','unknown']='unknown'
    bid: float | None = Field(None,ge=0)
    ask: float | None = Field(None,ge=0)
    quote_ts: float | None = Field(None,gt=0)
    iv_pct: float | None = Field(None,gt=0,le=1000)
    delta: float | None = Field(None,ge=-1,le=1)
    exchange: str | None = None
    multi_leg_id: str | None = None
    position_effect: Literal['unknown','open','close']='unknown'
    conditions: list[str] = Field(default_factory=list,max_length=20)

    @model_validator(mode='after')
    def causal_fields(self):
        if self.ts>time.time()+5 or self.expiry<=self.ts:
            raise ValueError('Trade must not be future-dated or after expiration')
        if (self.bid is None)!=(self.ask is None):
            raise ValueError('Supply both bid/ask or neither')
        if self.bid is not None and (self.ask<self.bid or self.quote_ts is None or not 0<=self.ts-self.quote_ts<=1):
            raise ValueError('Quotes must precede trade, be <=1s old and not crossed')
        return self


class ObservationBatch(BaseModel):
    model_config=ConfigDict(extra='forbid')
    trades: list[OptionObservation] = Field(min_length=1,max_length=1000)


class LicensedOptionTape:
    def __init__(self, capacity=20000):
        self.rows=deque(maxlen=capacity)
        self.keys=deque()
        self.seen=set()
        self.lock=threading.Lock()
        self.capacity=capacity
        self.last_received=None
        self.accepted=0
        self.duplicates=0

    def ingest(self, observations, recorder=None):
        now=time.time(); accepted=0
        source=os.getenv('GEX_OPTION_FEED_SOURCE','').strip()
        symbols={s.strip() for s in os.getenv('GEX_OPTION_FEED_SYMBOLS','').split(',') if s.strip()}
        if not source or not symbols:
            raise ValueError('No licensed source/underlying allowlist configured')
        # Validate the complete batch before mutating anything.
        if any(o.source!=source or o.symbol not in symbols for o in observations):
            raise ValueError('Source or symbol not approved by operator')
        with self.lock:
            for o in observations:
                key=(o.source,o.symbol,o.trade_id)
                if key in self.seen:
                    self.duplicates+=1; continue
                self.seen.add(key);self.keys.append(key)
                if len(self.keys)>self.capacity:
                    self.seen.remove(self.keys.popleft())
                data=o.model_dump()
                data.update(received_at=now,premium_usd=o.price_usd*o.amount*o.multiplier,
                            side_source='source_reported' if o.side!='unknown' else 'unknown',
                            multi_leg='linked_by_source' if o.multi_leg_id else 'unknown')
                self.rows.append(data)
                self.accepted+=1;accepted+=1;self.last_received=now
                if recorder:
                    recorder.capture(o.symbol,'option_trade',o.ts,data,received_at=now)
        return accepted

    def status(self):
        return dict(configured=bool(os.getenv('GEX_OPTION_FEED_SOURCE') and os.getenv('GEX_OPTION_FEED_SYMBOLS')),
                    source=os.getenv('GEX_OPTION_FEED_SOURCE') or None,last_received=self.last_received,
                    accepted=self.accepted,duplicates=self.duplicates,
                    entitlement_verified=False,
                    limitation='Operator must confirm license and vendor mapping. Configuration is not proof of a connected or entitled feed.')

    def snapshot(self,symbol,minimum=0.,kind='all',expiry='all',limit=100):
        now=time.time()
        tz=timezone.utc if symbol=='BTC' else __import__('zoneinfo').ZoneInfo('America/New_York')
        today=datetime.fromtimestamp(now,tz).date()
        with self.lock:
            rows=[dict(r) for r in self.rows if r['symbol']==symbol and r['premium_usd']>=minimum
                  and (kind=='all' or r['option_type']==kind)
                  and (expiry=='all' or (datetime.fromtimestamp(r['expiry'],tz).date()==today))]
        groups={}
        for r in rows:
            key=(r['expiry'],r['strike'],r['option_type'])
            b=groups.setdefault(key,dict(expiry=r['expiry'],strike=r['strike'],option_type=r['option_type'],premium_usd=0.,prints=0))
            b['premium_usd']+=r['premium_usd'];b['prints']+=1
        st=self.status()
        return dict(available=bool(rows),rows=sorted(rows,key=lambda r:r['ts'],reverse=True)[:limit],
                    concentrations=sorted(groups.values(),key=lambda r:r['premium_usd'],reverse=True)[:10],
                    sample_count=len(rows),live=bool(rows and now-max(r['ts'] for r in rows)<60 and st['last_received'] and now-st['last_received']<60),
                    reason=None if rows else 'Aucun fournisseur options autorisé/reçu pour cet instrument et ces filtres.',
                    provider=st,limitation='Transactions importées par une source explicitement configurée. Ouverture/fermeture, bid/ask et multi-leg restent inconnus si non fournis. Aucun biais directionnel déduit du type call/put.')


def build_ingest_router(tape,recorder):
    router=APIRouter()

    @router.post('/api/ingest/options')
    def ingest(batch:ObservationBatch, authorization: str = Header('')):
        token=os.getenv('GEX_INGEST_TOKEN','')
        if not token or not hmac.compare_digest(authorization.encode(),('Bearer '+token).encode()):
            raise HTTPException(401,'Ingestion locked; requires separate GEX_INGEST_TOKEN')
        try:
            accepted=tape.ingest(batch.trades,recorder)
        except ValueError as exc:
            raise HTTPException(422,str(exc))
        return dict(accepted=accepted,duplicates=len(batch.trades)-accepted)
    return router
