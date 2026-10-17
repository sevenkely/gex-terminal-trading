"""Point-in-time level journal and observed option prints. No synthetic backfill.

Snapshots are samples, not tick replay. Source chain times are preserved.
Disk storage is local SQLite in ignored data/, never in Git.
"""
from __future__ import annotations

from collections import deque
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import sqlite3
import threading
import math
from contextlib import contextmanager
import time
import re
from zoneinfo import ZoneInfo

def parse_instrument(name):
    match = re.fullmatch(r"BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])", name)
    if not match:
        return None
    day, month, year, strike, kind = match.groups()
    try:
        month_number = ("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split().index(month) + 1)
        return datetime(2000 + int(year), month_number, int(day), 8, tzinfo=timezone.utc), float(strike), kind
    except ValueError:
        return None


class OptionTape:
    def __init__(self, limit=2000):
        self.rows = deque(maxlen=limit)
        self.seen = deque(maxlen=limit)
        self.lock = threading.Lock()
        self.seq = 0

    def add(self, ts, price, amount, side, instrument, index_price, trade_id=None, iv=None):
        parsed = parse_instrument(instrument)
        if not all(math.isfinite(v) for v in (ts, price, amount, index_price)):
            return
        if ts>time.time()+5:
            return
        try:
            iv=float(iv) if iv is not None and math.isfinite(float(iv)) else None
        except (TypeError,ValueError):
            iv=None
        if not parsed or price <= 0 or amount <= 0 or index_price <= 0:
            return
        expiry, strike, kind = parsed
        # Native trade ID preferred. Backfill/live dedup must not collapse
        # different prints that happen to share a price and timestamp.
        with self.lock:
            if trade_id is not None:
                if str(trade_id) in self.seen:
                    return
                self.seen.append(str(trade_id))
            self.seq += 1
            self.rows.append({
                'seq': self.seq, 'ts': ts, 'received_at': time.time(),
                'instrument': instrument, 'strike': strike, 'option_type': kind,
                'expiry': expiry.timestamp(), 'amount': amount,
                'price_btc': price, 'premium_usd': amount * price * index_price,
                'index_price': index_price, 'side': side if side in ('buy', 'sell') else 'unknown',
                'side_source': 'exchange_direction', 'iv_pct': iv,
                'bid': None, 'ask': None, 'delta': None, 'multi_leg': 'unknown',
                'position_effect': 'unknown', 'source': 'DERIBIT',
            })
            return True

    def snapshot(self, minimum=0., kind='all', expiry='all', limit=100, contract=None):
        now = time.time()
        today = datetime.fromtimestamp(now, timezone.utc).date()
        with self.lock:
            rows = [dict(r) for r in self.rows
                    if (contract is None or r['instrument']==contract) and r['premium_usd'] >= minimum and (kind == 'all' or r['option_type'] == kind)
                    and (expiry == 'all' or datetime.fromtimestamp(r['expiry'], timezone.utc).date() == today)]
        buckets = {}
        for r in rows:
            key = (r['expiry'], r['strike'], r['option_type'])
            b = buckets.setdefault(key, {'expiry':r['expiry'], 'strike':r['strike'], 'option_type':r['option_type'],
                                         'premium_usd':0., 'contracts':0., 'prints':0})
            b['premium_usd'] += r['premium_usd']; b['contracts'] += r['amount']; b['prints'] += 1
        return {
            'available': bool(rows), 'rows': sorted(rows, key=lambda r:r['ts'], reverse=True)[:limit],
            'concentrations': sorted(buckets.values(), key=lambda b:b['premium_usd'], reverse=True)[:10],
            'sample_count':len(rows), 'retention_prints':self.rows.maxlen,
            'reason': None if rows else 'Aucune transaction options reçue pour ces filtres.',
            'limitation': "Échantillon borné depuis le démarrage et le backfill public. Direction fournie par Deribit ; bid/ask au trade et ouverture/fermeture inconnus. Un achat de call n'est pas une preuve de biais haussier.",
        }


class ResearchStore:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self._event_cleanup_at = 0.

    @contextmanager
    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=10)
        try:
            os.chmod(self.path,0o600)
            with db:
                db.execute('PRAGMA auto_vacuum=INCREMENTAL')
                db.execute('CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER)')
                db.execute('CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY, symbol TEXT, filter TEXT, recorded_at REAL, payload TEXT)')
                db.execute('CREATE INDEX IF NOT EXISTS snapshot_lookup ON snapshots(symbol, filter, recorded_at)')
                db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, symbol TEXT, kind TEXT, occurred_at REAL, received_at REAL, payload TEXT)')
                db.execute('CREATE INDEX IF NOT EXISTS event_lookup ON events(symbol, received_at, id)')
                db.execute('CREATE TABLE IF NOT EXISTS oi (symbol TEXT, day TEXT, chain_ts REAL, call_oi REAL, put_oi REAL, PRIMARY KEY(symbol,day))')
                yield db
        finally:
            db.close()

    @staticmethod
    def _allocate_ids(db,table,count):
        # Table names are internal constants, never request input. Persist the
        # high-water mark so retention cannot reuse a replay cursor ID.
        if table not in ('snapshots','events'): raise ValueError('invalid sequence')
        db.execute(f'INSERT OR IGNORE INTO counters(name,value) SELECT ?,COALESCE(MAX(id),0) FROM {table}',(table,))
        current=db.execute('SELECT value FROM counters WHERE name=?',(table,)).fetchone()[0]
        db.execute('UPDATE counters SET value=? WHERE name=?',(current+count,table))
        return range(current+1,current+count+1)

    def save_snapshots(self, rows):
        with self.lock, self._connect() as db:
            ids=self._allocate_ids(db,'snapshots',len(rows))
            db.executemany('INSERT INTO snapshots(id,symbol,filter,recorded_at,payload) VALUES(?,?,?,?,?)',
                           [(i,r['symbol'], r['filter'], r['recorded_at'], json.dumps(r, allow_nan=False)) for i,r in zip(ids,rows)])
            db.execute('DELETE FROM snapshots WHERE recorded_at < ?', (time.time() - 7*86400,))
            db.execute('DELETE FROM snapshots WHERE id <= (SELECT id FROM snapshots ORDER BY id DESC LIMIT 1 OFFSET 99999)')
            db.execute('PRAGMA incremental_vacuum(100)')

    def replay(self, symbol, filt='all', limit=240, before=None):
        with self.lock, self._connect() as db:
            rows = db.execute('SELECT id,payload FROM snapshots WHERE symbol=? AND filter=? AND recorded_at<=? ORDER BY id DESC LIMIT ?',
                              (symbol, filt, before or time.time(), limit)).fetchall()
        return [{'id':i, **json.loads(payload)} for i, payload in reversed(rows)]

    def record_oi(self, symbol, chain):
        # This is a local daily observation, not necessarily the exchange OI date.
        tz = timezone.utc if symbol == 'BTC' else ZoneInfo('America/New_York')
        day = datetime.fromtimestamp(chain.ts_epoch, tz).date().isoformat()
        with self.lock, self._connect() as db:
            db.execute('INSERT OR REPLACE INTO oi VALUES(?,?,?,?,?)', (symbol, day, chain.ts_epoch,
                float(chain.oi[chain.is_call].sum()), float(chain.oi[~chain.is_call].sum())))
            db.execute('DELETE FROM oi WHERE chain_ts < ?', (time.time()-90*86400,))

    def oi_history(self, symbol):
        with self.lock, self._connect() as db:
            rows = db.execute('SELECT day,chain_ts,call_oi,put_oi FROM oi WHERE symbol=? ORDER BY day DESC LIMIT 30', (symbol,)).fetchall()
        return [dict(day=d, chain_ts=t, call_oi=c, put_oi=p) for d,t,c,p in reversed(rows)]


    def save_events(self, rows):
        with self.lock, self._connect() as db:
            ids=self._allocate_ids(db,'events',len(rows))
            db.executemany('INSERT INTO events(id,symbol,kind,occurred_at,received_at,payload) VALUES(?,?,?,?,?,?)',
                [(i,r['symbol'],r['kind'],r['occurred_at'],r['received_at'],json.dumps(r['payload'],allow_nan=False)) for i,r in zip(ids,rows)])
            if time.time()-self._event_cleanup_at > 60:
                db.execute('DELETE FROM events WHERE received_at < ?', (time.time()-7*86400,))
                db.execute('DELETE FROM events WHERE id < (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET 1999999)')
                self._event_cleanup_at=time.time()

    def event_page(self, symbol, start, end, cursor=0, limit=1000):
        with self.lock, self._connect() as db:
            rows=db.execute('SELECT id,kind,occurred_at,received_at,payload FROM events WHERE symbol=? AND received_at>=? AND received_at<=? AND id>? ORDER BY id LIMIT ?',
                (symbol,start,end,cursor,limit+1)).fetchall()
        data=[dict(id=i,symbol=symbol,kind=k,occurred_at=t,received_at=r,payload=json.loads(p)) for i,k,t,r,p in rows[:limit]]
        return dict(rows=data,has_more=len(rows)>limit,next_cursor=data[-1]['id'] if data else cursor)

    def evaluation_data(self, symbol, filt, start, end, limit=50000):
        # Include prior context, but only the simulator decides when it was known.
        with self.lock, self._connect() as db:
            raw=db.execute('SELECT id,payload FROM snapshots WHERE symbol=? AND filter=? AND recorded_at>=? AND recorded_at<=? ORDER BY recorded_at,id LIMIT 10001',
                (symbol,filt,start-90,end)).fetchall()
            events=db.execute("SELECT id,kind,occurred_at,received_at,payload FROM events WHERE symbol=? AND kind='price' AND received_at>=? AND received_at<=? ORDER BY received_at,id LIMIT ?",
                (symbol,start,end,limit+1)).fetchall()
        if len(events)>limit or len(raw)>10000:
            raise ValueError('Dataset truncated: reduce evaluation window; refusing biased partial results.')
        return ([{'id':i,**json.loads(p)} for i,p in raw],
                [dict(id=i,symbol=symbol,kind=k,occurred_at=t,received_at=r,payload=json.loads(p)) for i,k,t,r,p in events])
