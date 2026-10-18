"""Exchange schedules with explicit provenance, holidays and early closes.

XNYS is the cash-session proxy for the tracked US indices/ETFs. CMES/COMEX
are library schedules, not product-specific broker entitlement validation.
CME's daily 17:00–18:00 ET maintenance is intersected with the schedule.
"""
from datetime import date, datetime, time as clock_time, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo
import exchange_calendars as xc
import pandas as pd

ET = ZoneInfo('America/New_York')
FUTURES = {'ES', 'NQ', 'GC'}


@lru_cache(maxsize=24)
def calendar(name, year):
    return xc.get_calendar(name, start=f'{year-1}-01-01', end=f'{year+1}-12-31')


def session_info(symbol, ts=None):
    now = datetime.fromtimestamp(ts, timezone.utc) if ts is not None else datetime.now(timezone.utc)
    if symbol == 'BTC':
        return dict(open=True, source='crypto_24_7', checked_at=now.timestamp(), next_transition=None,
                    limitation=None)
    name = 'COMEX' if symbol == 'GC' else 'CMES' if symbol in FUTURES else 'XNYS'
    cal = calendar(name, now.year)
    minute = pd.Timestamp(now).floor('min')
    opened = bool(cal.is_open_on_minute(minute))
    et = now.astimezone(ET)
    if symbol in FUTURES and 17 <= et.hour < 18:
        opened = False
    # Restrict to a short bounded schedule, no naive weekday assumptions.
    rows = cal.schedule.loc[str(et.date()):].head(4)
    transitions = [v.timestamp() for _, row in rows.iterrows()
                   for v in (row['open'], row['close']) if not pd.isna(v) and v.timestamp() > now.timestamp()]
    if symbol in FUTURES and et.weekday() < 5:
        for hour in (17, 18):
            t = et.replace(hour=hour, minute=0, second=0, microsecond=0).timestamp()
            if t > now.timestamp():
                transitions.append(t)
    return dict(open=opened, source=f'exchange_calendars:{name}', checked_at=now.timestamp(),
                next_transition=min(transitions) if transitions else None,
                limitation='Cash proxy XNYS; CME/COMEX schedules require product-specific broker confirmation.')


def settlement_epoch(day: date, am_settled=False):
    """Reject non-session dates; PM cut-off follows holiday/early close schedule."""
    cal = calendar('XNYS', day.year)
    label = pd.Timestamp(day)
    if not cal.is_session(label):
        raise ValueError(f'Non-trading option expiry date: {day.isoformat()}')
    if am_settled:
        return datetime.combine(day, clock_time(9, 30), ET).timestamp()
    return cal.session_close(label).timestamp()
