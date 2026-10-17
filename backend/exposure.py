"""Current modeled strike x expiry grid. Never reconstructed intraday history."""
import time
import numpy as np
import gex
from pricing import rates_for, assumptions


def grid(chain, spot, filt='all', metric='gamma', band=.05, now=None,
         max_strikes=160, max_expiries=24):
    if not np.isfinite(spot) or spot<=0: raise ValueError("Invalid spot")
    now=time.time() if now is None else now
    mask, gamma, years=gex._gamma_at(chain,spot,filt,now)
    if metric=='vanna':
        mask &= chain.iv>1e-4
        values=np.zeros(len(mask))
        t=np.maximum(years[mask],1/gex.YEAR_SECONDS)
        vol=chain.iv[mask];k=chain.strike[mask]
        d1=(np.log(spot/k)+(rates_for(chain,t)-chain.dividend_yield+.5*vol**2)*t)/(vol*np.sqrt(t))
        values[mask]=-np.exp(-chain.dividend_yield*t)*gex._npdf(d1)*(d1-vol*np.sqrt(t))/vol
        values *= chain.oi*chain.multiplier*spot*.01
    elif metric=='gamma':
        values=gamma*chain.oi*chain.multiplier*spot**2*.01
    else:
        raise ValueError('Unsupported exposure')
    values *= np.where(chain.is_call,1.,-1.)
    eligible=mask & (chain.strike>=spot*(1-band)) & (chain.strike<=spot*(1+band))
    all_exp=np.unique(chain.exp_epoch[mask]);exp=all_exp[:max_expiries]
    all_k=np.unique(chain.strike[eligible & np.isin(chain.exp_epoch,exp)])
    strikes=np.sort(all_k[np.argsort(np.abs(all_k-spot),kind='stable')[:max_strikes]])
    use=eligible & np.isin(chain.exp_epoch,exp) & np.isin(chain.strike,strikes)
    matrix=np.zeros((len(strikes),len(exp)));counts=np.zeros(matrix.shape,dtype=int)
    if use.any():
        i=np.searchsorted(strikes,chain.strike[use]);j=np.searchsorted(exp,chain.exp_epoch[use])
        np.add.at(matrix,(i,j),values[use]);np.add.at(counts,(i,j),1)
    return dict(available=bool(use.any()),strikes=strikes.tolist(),expiries=exp.tolist(),
                values=matrix.tolist(),counts=counts.tolist(),metric=metric,spot=spot,
                valuation_time=now,chain_ts=chain.ts_epoch,filter=filt,
                unit='USD / +1% spot' if metric=='gamma' else 'USD delta-equivalent / +1 pt IV',
                truncated=len(all_exp)>len(exp) or len(all_k)>len(strikes),
                total_expiries=len(all_exp),total_strikes_in_band=len(all_k),
                model_inputs=assumptions(chain),
                reason=None if use.any() else 'Aucune option éligible dans ce filtre et cette fenêtre. Aucun repli ALL.',
                limitation='Snapshot calculé actuel, calls + / puts −. Ni historique ni positionnement dealer observé. Cellule absente distincte d’une exposition nette nulle.')
