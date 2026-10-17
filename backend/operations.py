"""Local operational tools: monitoring and verified SQLite backup/restore.
Never archives .env, Rithmic config, tokens or credentials.
"""
import argparse
from collections import deque
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import sqlite3
import tempfile
import threading
import time
from storage import write_json


class Metrics:
    def __init__(self):
        self.started=time.monotonic();self.requests=0;self.errors=0;self.rejected=0
        self.latencies=deque(maxlen=512);self.loop_lag=0.;self.last_heartbeat=None
        self.lock=threading.Lock()

    def observe(self,status,seconds):
        with self.lock:
            self.requests+=1;self.errors+=int(status>=500);self.rejected+=int(status in (401,403,429))
            self.latencies.append(seconds*1000)

    def snapshot(self,data_path):
        disk_path=Path(data_path).parent
        while not disk_path.exists(): disk_path=disk_path.parent
        with self.lock:
            latency=sorted(self.latencies)
            return dict(uptime_seconds=round(time.monotonic()-self.started,2),requests=self.requests,
                        server_errors=self.errors,rejected=self.rejected,
                        latency_p95_ms=latency[int((len(latency)-1)*.95)] if latency else None,
                        loop_lag_seconds=self.loop_lag,last_heartbeat=self.last_heartbeat,
                        max_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                        disk_free_bytes=shutil.disk_usage(disk_path).free)


def checksum(path):
    digest=hashlib.sha256()
    with open(path,'rb') as file:
        for chunk in iter(lambda:file.read(1024*1024),b''):
            digest.update(chunk)
    return digest.hexdigest()


def check_database(path):
    path=Path(path)
    with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
            raise ValueError('SQLite integrity check failed')
        tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'snapshots','oi'}.issubset(tables):
            raise ValueError('Not a research database')


def backup_database(source,destination):
    source,destination=Path(source),Path(destination)
    if destination.exists() or source.resolve()==destination.resolve():
        raise ValueError('Backup destination must not exist or equal source')
    check_database(source)
    destination.parent.mkdir(parents=True,exist_ok=True)
    # Exclusive creation prevents accidental overwrite. SQLite backup is a
    # coherent transaction even while the live database is being written.
    fd=os.open(destination,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
    try:
        with closing(sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True)) as src:
            with closing(sqlite3.connect(destination)) as dst:
                src.backup(dst)
        check_database(destination)
        digest=checksum(destination)
        write_json(str(destination)+'.manifest.json',dict(schema=1,created_at=time.time(),sha256=digest,
                   includes=['research SQLite only'],excludes=['.env','Rithmic config','credentials']))
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return dict(path=str(destination),sha256=digest)


def restore_database(backup,destination,server_stopped=False):
    if not server_stopped:
        raise ValueError('Stop server and explicitly confirm before restoring')
    backup,destination=Path(backup),Path(destination)
    if destination.exists():
        raise ValueError('Restore into a NEW path, never overwrite an active database')
    manifest=json.loads(Path(str(backup)+'.manifest.json').read_text())
    if checksum(backup)!=manifest['sha256']:
        raise ValueError('Backup checksum mismatch')
    check_database(backup)
    return backup_database(backup,destination)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['backup','restore'])
    parser.add_argument('source');parser.add_argument('destination')
    parser.add_argument('--server-stopped',action='store_true')
    args=parser.parse_args(argv)
    result=backup_database(args.source,args.destination) if args.action=='backup' else restore_database(args.source,args.destination,args.server_stopped)
    print(json.dumps(result))


if __name__=='__main__': main()
