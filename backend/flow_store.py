"""Local bounded flow checkpoints, separate from model snapshots. No backfill.
Disk work is performed by the checkpoint loop, never in market callbacks.
"""
from contextlib import contextmanager, closing
import json
import sqlite3
import threading
import time
from pathlib import Path


class FlowStore:
    def __init__(self, path, namespace):
        self.path = Path(path)
        self.namespace = namespace
        self.lock = threading.Lock()

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=10)) as db:
            with db:
                db.execute('CREATE TABLE IF NOT EXISTS flow_state (namespace TEXT, key TEXT, updated REAL, payload TEXT, PRIMARY KEY(namespace,key))')
                yield db

    def load(self):
        with self.lock, self.connect() as db:
            return [(json.loads(k), json.loads(p)) for k, p in db.execute(
                'SELECT key,payload FROM flow_state WHERE namespace=? ORDER BY updated DESC LIMIT 64', (self.namespace,))]

    def save(self, rows):
        with self.lock, self.connect() as db:
            db.executemany('INSERT OR REPLACE INTO flow_state VALUES (?,?,?,?)',
                [(self.namespace, json.dumps(key), payload['last_ts'] or time.time(), json.dumps(payload, allow_nan=False)) for key, payload in rows])
            db.execute('DELETE FROM flow_state WHERE namespace=? AND key NOT IN (SELECT key FROM flow_state WHERE namespace=? ORDER BY updated DESC LIMIT 64)', (self.namespace, self.namespace))
