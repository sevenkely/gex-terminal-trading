"""Explicit model inputs. No guessed units, no fabricated market rate curve.

Optional GEX_MODEL_INPUTS JSON: {"SPX":{"asof":epoch,"rate":.04,
"dividend_yield":.01,"curve":[[30,.04],[365,.035]]}}.
Rates/continuous yield are decimals. Inputs newer than the source snapshot are
not used. Default assumptions are always labelled, never 'calibrated'.
"""
import json
import math
import os
from pathlib import Path
import numpy as np


def model_inputs(symbol, snapshot_time):
    default = dict(rate=0.0 if symbol == 'BTC' else .04, dividend_yield=0.,
                   rate_curve=(), model_source='assumed_flat_inputs', model_asof=None)
    path = os.getenv('GEX_MODEL_INPUTS')
    if not path:
        return default
    try:
        value = json.loads(Path(path).read_text())[symbol]
        asof = float(value['asof'])
        if not math.isfinite(asof) or asof > snapshot_time:
            return {**default, 'model_source':'assumed_inputs_calibration_not_yet_known'}
        rate = float(value['rate']); q = float(value.get('dividend_yield', 0))
        curve = tuple((float(d), float(r)) for d, r in value.get('curve', []))
        if not (-.1 <= rate <= 1 and 0 <= q <= 1) or len(curve) > 100:
            raise ValueError('invalid model inputs')
        if any(not (math.isfinite(d) and d > 0 and -.1 <= r <= 1) for d,r in curve):
            raise ValueError('invalid curve')
        if len({d for d,r in curve}) != len(curve):
            raise ValueError('duplicate tenor')
        return dict(rate=rate, dividend_yield=q, rate_curve=tuple(sorted(curve)),
                    model_source='operator_supplied_inputs_not_independently_verified', model_asof=asof)
    except (ValueError, OSError, KeyError, TypeError):
        return {**default, 'model_source':'assumed_inputs_invalid_calibration'}


def rates_for(chain, years):
    years = np.asarray(years, dtype=float)
    if chain.rate_curve:
        days, rates = zip(*chain.rate_curve)
        return np.interp(years*365.25, days, rates)
    return np.full_like(years, chain.rate)


def assumptions(chain):
    return dict(model='Black-Scholes spot approximation', rate=chain.rate,
                dividend_yield=chain.dividend_yield, rate_curve=list(chain.rate_curve),
                source=chain.model_source, asof=chain.model_asof,
                limitations='European spot model. ETF American exercise/discrete dividends and Deribit inverse settlement are not fully modelled; validate against source Greeks.')
