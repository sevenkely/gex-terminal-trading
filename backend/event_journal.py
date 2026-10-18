"""Opt-in bounded event recorder. Arrival time, source time and contract identity
are separate. Never blocks market callbacks on SQLite or records SIM prices.
"""
from collections import deque
import threading
import json
import math
import time


class EventRecorder:
    def __init__(self, enabled=False, capacity=20000):
        self.enabled=enabled
        self.queue=deque()
        self.capacity=capacity
        self.dropped=0
        self.written=0
        self.failures=0
        self.last_flush=None
        self.lock=threading.Lock()
        self.flush_lock=threading.Lock()

    def capture(self, symbol, kind, occurred_at, payload, received_at=None):
        if not self.enabled:
            return
        if kind=='price' and payload.get('mode') not in ('RITHMIC','DERIBIT'):
            return
        try:
            received_at=time.time() if received_at is None else received_at
            if not all(math.isfinite(v) for v in (occurred_at,received_at)):
                raise ValueError('non-finite event clock')
            # Freeze values now. Invalid observations must not poison a retry
            # batch indefinitely (e.g. a vendor sends NaN as an unknown IV).
            frozen=json.loads(json.dumps(payload,allow_nan=False))
        except (TypeError,ValueError,OverflowError):
            with self.lock:self.dropped+=1
            return
        with self.lock:
            if len(self.queue) >= self.capacity:
                self.dropped+=1
                return  # preserve queued order; report the coverage gap
            self.queue.append(dict(symbol=symbol,kind=kind,occurred_at=occurred_at,
                received_at=received_at,payload=frozen))

    def flush(self, store):
        with self.flush_lock:
            self._flush_batch(store)

    def _flush_batch(self,store):
        with self.lock:
            batch=list(self.queue)[:2000]
        if not batch:
            return
        try:
            store.save_events(batch)
        except Exception:
            with self.lock:
                self.failures+=1
            raise
        with self.lock:
            for _ in batch:
                self.queue.popleft()
            self.written+=len(batch)
            self.last_flush=time.time()

    def status(self):
        with self.lock:
            return dict(enabled=self.enabled,queued=len(self.queue),dropped=self.dropped,
                        failures=self.failures,written=self.written,last_flush=self.last_flush,
                        limitation='Recording starts on activation. No tick backfill; dropped events mean incomplete coverage.')
