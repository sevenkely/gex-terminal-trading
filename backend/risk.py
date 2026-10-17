"""Model sensitivities, not observed dealer hedging demand.

Same BS assumptions and signed-OI convention as gex.py. USD delta-equivalent
per +1 absolute vol point (vanna) / +1 calendar day (charm). Not P&L forecasts.
"""
import time
import math
from pricing import rates_for, assumptions
import numpy as np
import gex


def sensitivities(chain, spot, filt='all', valuation_time=None):
    now = time.time() if valuation_time is None else valuation_time
    mask = gex._mask_for(chain, filt, now) & (chain.iv > 1e-4)
    if not mask.any():
        return {'available':False, 'reason':'Aucune option avec IV exploitable pour ce filtre.'}
    t = np.maximum((chain.exp_epoch[mask]-now)/gex.YEAR_SECONDS, 1/gex.YEAR_SECONDS)
    k, vol = chain.strike[mask], chain.iv[mask]
    sqrt_t = np.sqrt(t)
    d1 = (np.log(spot/k)+(rates_for(chain,t)-chain.dividend_yield+.5*vol**2)*t)/(vol*sqrt_t)
    d2 = d1-vol*sqrt_t
    pdf = gex._npdf(d1)
    vanna = -np.exp(-chain.dividend_yield*t)*pdf*d2/vol
    def deltas(tt):
        dd = (np.log(spot/k)+(rates_for(chain,tt)-chain.dividend_yield+.5*vol**2)*tt)/(vol*np.sqrt(tt))
        ncdf = np.array([.5*(1+math.erf(float(x)/math.sqrt(2))) for x in dd])
        return np.exp(-chain.dividend_yield*tt)*(ncdf-np.where(chain.is_call[mask],0.,1.))
    h = min(1/gex.YEAR_SECONDS, float(t.min())/4)
    charm = (deltas(t-h)-deltas(t+h))/(2*h)
    weight = np.where(chain.is_call[mask],1.,-1.)*chain.oi[mask]*chain.multiplier*spot
    return {
        'available':True, 'valuation_time':now, 'contracts':int(mask.sum()),
        'vanna_usd_per_vol_point':float((vanna*weight*.01).sum()),
        'charm_usd_per_calendar_day':float((charm*weight/365.25).sum()),
        'model_inputs':assumptions(chain),
        'limitation':"Sensibilités locales BS à spot/IV constants, paramètres affichés ; convention calls + / puts −. Dollars de delta équivalent, pas du P&L ni une prévision de flux. Extrapolation journalière non fiable près de l'expiration.",
    }
