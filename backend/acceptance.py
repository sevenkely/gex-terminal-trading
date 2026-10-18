"""Read-only live acceptance CLI. Never trades, connects/disconnects accounts,
prints secrets or substitutes fixtures for a failed provider.

PYTHONPATH=backend python backend/acceptance.py --base-url http://localhost:8000 \
    --symbols SPX,ES,BTC --samples 1 --output data/acceptance.json
A full-session soak is explicit: --samples 2880 --interval 30 (24 hours).
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import time
from urllib.parse import urlsplit
import httpx
from storage import write_json


def inspect_profile(data, now=None):
    now = time.time() if now is None else now
    failures, warnings = [], []
    if not isinstance(data,dict):
        return {'status':'failed','failures':['invalid_schema'],'warnings':[]}
    meta = data.get('meta', {})
    if data.get('error') or not isinstance(meta,dict) or not meta:
        return {'status':'failed', 'failures':['missing_chain'], 'warnings':[]}
    strikes = data.get('strikes', [])
    for key in ('call_gex','put_gex','net_gex','call_oi','put_oi'):
        values = data.get(key, [])
        if len(values) != len(strikes) or not all(isinstance(v,(float,int)) and math.isfinite(v) for v in values):
            failures.append(f'invalid_{key}')
    if not all(isinstance(k,(float,int)) and math.isfinite(k) and k > 0 for k in strikes):
        failures.append('invalid_strikes')
    if strikes != sorted(set(strikes)):
        failures.append('unordered_duplicate_strikes')
    if data.get('gamma_flip') != data.get('zero_gex'):
        failures.append('flip_definition_mismatch')
    if data.get('available') is False and strikes:
        failures.append('empty_filter_contains_strikes')
    if data.get('available') is False:
        warnings.append('filter_empty_requires_calendar_and_source_review')
    if not failures:
        if any(v<0 for k in ('call_gex','call_oi','put_oi') for v in data.get(k,[])) or any(v>0 for v in data.get('put_gex',[])):
            failures.append('invalid_signed_exposure_or_oi')
        if any(abs(c+p-n)>1e-5 for c,p,n in zip(data.get('call_gex',[]),data.get('put_gex',[]),data.get('net_gex',[]))):
            failures.append('net_series_mismatch')
        total=data.get('net_gex_total')
        if not isinstance(total,(float,int)) or not math.isfinite(total) or abs(sum(data.get('net_gex',[]))-total)>max(1e-5,len(strikes)*1e-6):
            failures.append('net_total_mismatch')
    source_ts = meta.get('chain_ts_epoch')
    budget = 180 if data.get('symbol') == 'BTC' else 1800
    if not isinstance(source_ts,(float,int)) or not math.isfinite(source_ts) or source_ts<=0 or source_ts > now+5:
        failures.append('invalid_source_time')
    elif now-source_ts > budget:
        warnings.append('chain_stale')
    if meta.get('mode') not in ('RITHMIC','DERIBIT'):
        warnings.append('no_live_price')
    # Public-chain OI cannot attest dealer ownership or open/close direction.
    return {'status':'failed' if failures else 'warning' if warnings else 'passed',
            'failures':failures, 'warnings':warnings}


def run_sample(client, symbols):
    checks = []
    for symbol in symbols:
        for filt in ('all','0dte'):
            started = time.monotonic()
            try:
                response = client.get(f'/api/gex/{symbol}', params={'filter':filt})
                response.raise_for_status()
                data = response.json()
                result = inspect_profile(data)
                result.update(symbol=symbol, filter=filt,
                              source_time=data.get('meta',{}).get('chain_ts_epoch'),
                              mode=data.get('meta',{}).get('mode'))
            except (httpx.HTTPError, ValueError, TypeError):
                result = dict(symbol=symbol, filter=filt, status='failed', failures=['request_failed'], warnings=[])
            result['latency_ms'] = round((time.monotonic()-started)*1000, 2)
            checks.append(result)
    return {'observed_at':time.time(), 'checks':checks}


def probe_sources(client,symbols):
    """Optional independent reads of fixed public provider URLs. No credentials."""
    from zoneinfo import ZoneInfo
    from cboe import URLS
    checks=[]
    for symbol in symbols:
        if symbol not in URLS and symbol!='BTC':
            checks.append(dict(symbol=symbol,status='not_comparable',reason='futures_projection_requires_contract_and_basis_review'))
            continue
        try:
            api=client.get(f'/api/gex/{symbol}',params={'filter':'all'}).json()
            if symbol=='BTC':
                raw=httpx.get('https://www.deribit.com/api/v2/public/get_index_price',params={'index_name':'btc_usd'},timeout=10).json()
                price=float(raw['result']['index_price']);reference=api['meta']['spot']
                mode=api['meta']['mode']
                comparable=mode=='DERIBIT'
            else:
                raw=httpx.get(URLS[symbol],timeout=10).json()
                price=float(raw['data']['current_price']);reference=api['meta']['delayed_spot']
                source_ts=raw['data'].get('last_trade_time') or raw.get('timestamp','')
                dt=datetime.fromisoformat(source_ts.replace('Z','+00:00'))
                source_epoch=(dt if dt.tzinfo else dt.replace(tzinfo=ZoneInfo('America/New_York'))).timestamp()
                comparable=abs(source_epoch-api['meta']['chain_ts_epoch'])<1
            deviation=abs(price/reference-1)*10000
            checks.append(dict(symbol=symbol,status='not_comparable' if not comparable else 'passed' if deviation<=5 else 'warning',
                deviation_bps=deviation,limitation='Readout comparison only, not independent Greek/model certification. Changed snapshots are not directly comparable.'))
        except (httpx.HTTPError,ValueError,KeyError,TypeError,ZeroDivisionError):
            checks.append(dict(symbol=symbol,status='unverified',reason='provider_unreachable_or_schema_invalid'))
    return checks


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='http://localhost:8000')
    parser.add_argument('--symbols',default='SPX,ES,BTC')
    parser.add_argument('--samples',type=int,default=1)
    parser.add_argument('--interval',type=float,default=30)
    parser.add_argument('--output',default='data/acceptance.json')
    parser.add_argument('--compare-sources',action='store_true',help='Read fixed public provider URLs; requires real network access')
    args=parser.parse_args(argv)
    url=urlsplit(args.base_url)
    if url.scheme not in ('http','https') or not url.netloc or url.username or url.password or url.query or url.fragment or url.path not in ('','/'):
        parser.error('Use an HTTP(S) origin without credentials/query')
    if not 1 <= args.samples <= 10000 or not 0 <= args.interval <= 3600:
        parser.error('Invalid bounded samples/interval')
    symbols=[s.strip().upper() for s in args.symbols.split(',')]
    if not symbols or any(s not in {'SPX','SPY','QQQ','GLD','ES','NQ','GC','BTC'} for s in symbols):
        parser.error('Unknown symbol')
    report={'schema':1,'started_at':datetime.now(timezone.utc).isoformat(),
            'kind':'api_acceptance', 'samples':[],
            'external_source_comparison':'not_performed',
            'manual_disconnect_reconnect':'not_performed',
            'entitlements_verified':False,
            'live_signoff':False}
    headers={'Authorization':'Bearer '+os.environ['GEX_VIEWER_TOKEN']} if os.getenv('GEX_VIEWER_TOKEN') else {}
    if headers and url.scheme=='http' and url.hostname not in ('localhost','127.0.0.1','::1'):
        parser.error('Authenticated remote API requests require HTTPS')
    with httpx.Client(base_url=args.base_url,timeout=15,headers=headers) as client:
        for i in range(args.samples):
            report['samples'].append(run_sample(client,symbols))
            write_json(args.output,report)
            if i+1 < args.samples:
                time.sleep(args.interval)
        if args.compare_sources:
            report['external_source_comparison']=probe_sources(client,symbols)
            write_json(args.output,report)
    bad=any(c['status']!='passed' for sample in report['samples'] for c in sample['checks'])
    print(json.dumps({'report':str(Path(args.output)), 'api_checks':'attention_required' if bad else 'passed',
                      'live_signoff':False}))
    return 2 if bad else 0


if __name__ == '__main__':
    raise SystemExit(main())
