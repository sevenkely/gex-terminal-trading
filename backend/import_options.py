"""Validate a normalized licensed JSON batch, optionally send to local API.
Never accepts a token on the command line; reads GEX_INGEST_TOKEN from env.
Vendor-specific mapping and licensing remain operator responsibilities.
"""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit
import httpx
from option_ingest import ObservationBatch


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file');parser.add_argument('--send',action='store_true')
    parser.add_argument('--base-url',default='http://localhost:8000')
    args=parser.parse_args(argv)
    path=Path(args.file)
    if path.stat().st_size>2*1024*1024:parser.error('Batch exceeds 2MiB')
    batch=ObservationBatch.model_validate_json(path.read_text())
    if not args.send:
        print(json.dumps(dict(validated=len(batch.trades),sent=False,entitlements_verified=False)));return
    token=os.getenv('GEX_INGEST_TOKEN')
    url=urlsplit(args.base_url)
    if not token:parser.error('GEX_INGEST_TOKEN required in environment')
    if url.scheme not in ('http','https') or not url.netloc or url.username or url.password or url.query or url.fragment or url.path not in ('','/'):
        parser.error('Invalid API origin')
    if url.scheme=='http' and url.hostname not in ('localhost','127.0.0.1','::1'):
        parser.error('Remote ingestion requires HTTPS')
    response=httpx.post(args.base_url.rstrip('/')+'/api/ingest/options',json=batch.model_dump(),
                       headers={'Authorization':'Bearer '+token},timeout=15)
    if response.status_code!=200:
        parser.exit(1,f'Ingestion refused: HTTP {response.status_code}\n')
    print(json.dumps(response.json()))


if __name__=='__main__':main()
