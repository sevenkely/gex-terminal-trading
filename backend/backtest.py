"""Auditable, next-tick paper simulation on recorded arrivals, not OHLC candles.

Frozen known levels, one position, fixed holding horizon, no parameter search.
Samples with future/stale data, contract switches, time gaps or split overlap
are rejected. Paper fills use explicit spread/slippage assumptions.
"""
from bisect import bisect_left
import math

INSTRUMENTS={'ES':(.25,50.),'NQ':(.25,20.),'GC':(.1,100.)}
LEVELS={'call_wall','put_wall','zero_gex'}


def evaluate(snapshots, events, *, symbol, level='call_wall', strategy='breakout',
             horizon=60., split_at=None, commission=0., spread_ticks=1., slippage_ticks=1.,
             max_gap=20., chain_max_age=1800.):
    if symbol not in INSTRUMENTS or level not in LEVELS or strategy not in ('breakout','reversion'):
        raise ValueError('Only direct ES/NQ/GC recorded trades and explicit supported levels/strategies can simulate fills.')
    if not 1 <= horizon <= 3600 or not 0 < max_gap <= 120 or any(not math.isfinite(x) or x < 0 for x in (commission,spread_ticks,slippage_ticks)):
        raise ValueError('Invalid execution assumptions')
    snapshots=sorted(snapshots,key=lambda s:s['recorded_at'])
    times=[s['recorded_at'] for s in snapshots]
    events=sorted(events,key=lambda e:(e['received_at'],e.get('id',0)))
    tick, point_value=INSTRUMENTS[symbol]
    impact=tick*(spread_ticks/2+slippage_ticks)
    previous=None; pending=None; position=None
    trades=[]; rejected={'invalid_price':0,'stale_or_unavailable_context':0,'gaps':0,
                         'contract_switch':0,'split_overlap':0,'unclosed':0}
    for event in events:
        if event.get('kind') != 'price' or event.get('symbol') != symbol:
            continue
        t=event['received_at']; payload=event['payload']; price=payload.get('price')
        contract=payload.get('contract')
        if (not isinstance(price,(int,float)) or not math.isfinite(price) or price <= 0
                or payload.get('mode')!='RITHMIC' or payload.get('price_type')!='direct_trade'
                or not contract or not 0 <= t-event['occurred_at'] <= max_gap):
            rejected['invalid_price']+=1
            previous=None; pending=None
            if position: rejected['gaps']+=1; position=None
            continue
        if previous and (t-previous['t'] > max_gap or contract!=previous['contract']):
            rejected['gaps' if contract==previous['contract'] else 'contract_switch']+=1
            position=None; pending=None; previous=None
        if position:
            move=position['side']*(price-position['entry_price'])
            position['mfe_points']=max(position['mfe_points'],move)
            position['mae_points']=min(position['mae_points'],move)
            if t >= position['entry_at']+horizon:
                exit_price=price-position['side']*impact
                net=position['side']*(exit_price-position['entry_price'])*point_value-commission
                trade={**position,'exit_at':t,'exit_price':exit_price,'net_pnl_usd':net,
                       'segment':'test' if split_at is not None and position['signal_at']>=split_at else 'train' if split_at is not None else 'unsplit'}
                if split_at is not None and trade['signal_at'] < split_at <= t:
                    rejected['split_overlap']+=1
                else:
                    trades.append(trade)
                position=None
        elif pending and t>pending['signal_at'] and t-pending['context_at']<=90 and t-pending['chain_ts']<=chain_max_age and 0<=t-pending['projection_ts']<=1800:
            position={**pending,'entry_at':t,'entry_price':price+pending['side']*impact,
                      'mfe_points':0.,'mae_points':0.}
            pending=None
        # Use only snapshots STRICTLY available before the tick arrived.
        i=bisect_left(times,t)-1
        context=snapshots[i] if i>=0 else None
        if pending and (t-pending['context_at']>90 or t-pending['chain_ts']>chain_max_age or not 0<=t-pending['projection_ts']<=1800):
            rejected['stale_or_unavailable_context']+=1; pending=None
        valid_context=bool(context and context['symbol']==symbol and context.get('levels',{}).get('available',False)
            and context.get('contract')==contract and context.get('price_mode')=='RITHMIC'
            and 0 <= t-context.get('chain_ts',0) <= chain_max_age
            and 0 <= t-context['recorded_at'] <= 90
            and context.get('projection',{}).get('fresh',False)
            and isinstance(context.get('projection',{}).get('qts'),(int,float))
            and 0<=t-context['projection']['qts']<=1800)
        if not valid_context:
            rejected['stale_or_unavailable_context']+=1
            previous=None
            continue
        value=context['levels'].get(level)
        if not isinstance(value,(int,float)) or not math.isfinite(value) or value<=0:
            previous=None
            continue
        side_of_level=1 if price>value else -1 if price<value else 0
        if previous and not pending and not position and previous['level']==value:
            # A moving level is never interpreted as a price crossing.
            if previous['side_of_level']*side_of_level<0:
                side=1 if price>value else -1
                if strategy=='reversion': side=-side
                pending=dict(signal_at=t,level=value,level_name=level,side=side,contract=contract,
                             snapshot_id=context.get('id'),context_at=context['recorded_at'],chain_ts=context['chain_ts'],projection_ts=context['projection']['qts'])
        previous=dict(t=t,price=price,level=value,contract=contract,
            side_of_level=side_of_level or (previous['side_of_level'] if previous and previous['level']==value else 0))
    rejected['unclosed']=int(position is not None)+int(pending is not None)

    def summary(rows):
        n=len(rows); wins=sum(r['net_pnl_usd']>0 for r in rows)
        pnl=sum(r['net_pnl_usd'] for r in rows)
        equity=peak=drawdown=0.
        for r in rows:
            equity+=r['net_pnl_usd'];peak=max(peak,equity);drawdown=max(drawdown,peak-equity)
        return dict(trades=n,net_pnl_usd=round(pnl,4),win_rate=wins/n if n else None,
                    mean_mae_points=sum(r['mae_points'] for r in rows)/n if n else None,
                    mean_mfe_points=sum(r['mfe_points'] for r in rows)/n if n else None,
                    max_drawdown_usd=drawdown,
                    evidence='insufficient_sample' if n<30 else 'descriptive_only_not_independent_validation')
    return dict(available=bool(events),strategy=strategy,level=level,horizon_seconds=horizon,
                assumptions=dict(symbol=symbol,tick_size=tick,point_value=point_value,
                    round_trip_commission_usd=commission,spread_ticks=spread_ticks,slippage_ticks=slippage_ticks,
                    projected_contract_identity='Yahoo continuous vs Rithmic delivery not independently verified',
                    entry='next valid observed tick after signal plus adverse execution costs',max_gap_seconds=max_gap),
                summary=summary(trades),train=summary([r for r in trades if r['segment']=='train']),
                test=summary([r for r in trades if r['segment']=='test']),split_at=split_at,
                trades=trades,rejected=rejected,
                limitation='Paper simulation, not actual fills. Price samples do not prove market depth. MAE/MFE only on recorded ticks; gaps/retention may hide extrema. No profitability or out-of-sample signoff.')
