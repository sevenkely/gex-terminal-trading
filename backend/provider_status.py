"""Bounded provider attempt diagnostics. No probes on GET, no credentials/errors leaked."""
import threading
import time
from functools import wraps

_lock = threading.Lock()
_attempts = {}


def record(provider, symbol, error=None):
    if provider not in {"deribit", "cboe", "yahoo"} or symbol not in {"SPX", "ES", "SPY", "QQQ", "NQ", "NDX", "GLD", "GC", "BTC"}:
        return
    key = (provider, symbol)
    with _lock:
        previous = _attempts.get(key, {})
        _attempts[key] = dict(provider=provider, symbol=symbol, checked_at=time.time(),
                             ok=error is None, error=type(error).__name__ if error else None,
                             last_success=time.time() if error is None else previous.get('last_success'))


def tracked(provider):
    def decorate(fn):
        @wraps(fn)
        def call(symbol, *args, **kwargs):
            try:
                result = fn(symbol, *args, **kwargs)
            except Exception as error:
                record(provider, symbol, error)
                raise
            record(provider, symbol)
            return result
        return call
    return decorate


def snapshot():
    with _lock:
        return [dict(value) for value in _attempts.values()]
