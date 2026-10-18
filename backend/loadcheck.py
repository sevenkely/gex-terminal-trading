"""Bounded read-only load check; no orders or account state changes.
Not a capacity certification. Run against staging first.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import os
import time
from urllib.parse import urlsplit
import httpx
from storage import write_json


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='http://localhost:8000')
    parser.add_argument('--requests',type=int,default=100)
    parser.add_argument('--concurrency',type=int,default=4)
    parser.add_argument('--output',default='data/loadcheck.json')
    parser.add_argument('--label',default='not_independently_verified')
    args=parser.parse_args(argv)
    url=urlsplit(args.base_url)
    if url.scheme not in ('http','https') or not url.netloc or url.username or url.password or url.query or url.fragment or url.path not in ('','/'):
        parser.error('Use an HTTP origin without credentials/query')
    if not 1<=args.requests<=10000 or not 1<=args.concurrency<=32:parser.error('Invalid bounded workload')
    headers={'Authorization':'Bearer '+os.environ['GEX_VIEWER_TOKEN']} if os.getenv('GEX_VIEWER_TOKEN') else {}
    if headers and url.scheme=='http' and url.hostname not in ('localhost','127.0.0.1','::1'):
        parser.error('Authenticated remote API requests require HTTPS')
    with httpx.Client(base_url=args.base_url,timeout=15,headers=headers) as client:
        def read(i):
            started=time.perf_counter()
            try:
                response=client.get('/api/gex/SPX',params={'filter':'0dte' if i%2 else 'all'})
                return response.status_code,(time.perf_counter()-started)*1000
            except httpx.HTTPError:
                return 0,(time.perf_counter()-started)*1000
        started=time.perf_counter()
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
            rows=list(pool.map(read,range(args.requests)))
        elapsed=time.perf_counter()-started
    latencies=sorted(row[1] for row in rows);statuses=Counter(row[0] for row in rows)
    report=dict(label=args.label,requests=args.requests,concurrency=args.concurrency,elapsed_seconds=elapsed,
                latency_p50_ms=latencies[int((len(latencies)-1)*.5)],latency_p95_ms=latencies[int((len(latencies)-1)*.95)],
                statuses=dict(statuses),server_errors=sum(v for k,v in statuses.items() if k>=500),
                network_errors=statuses.get(0,0),throttled=statuses.get(429,0),
                certification=False,limitation='Local read workload only; does not establish full-session/provider/WS capacity.')
    write_json(args.output,report);print(json.dumps(report))
    return int(bool(report['server_errors'] or report['network_errors']))


if __name__=='__main__':raise SystemExit(main())
