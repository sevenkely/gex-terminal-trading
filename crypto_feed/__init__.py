"""Feed crypto autonome : options Deribit (OI, murs, GEX) + flux Binance/Bybit.

Le paquet ne dépend ni de FastAPI ni du reste du dashboard : il s'exécute seul
(`python -m crypto_feed`) ou s'importe comme bibliothèque :

    from crypto_feed import Config, MarketFeed, get_state

`get_state()` retourne un dict JSON avec :
  - `options` : spot, OI et GEX par strike, call/put wall, gamma flip ;
  - `flow`    : delta / CVD, gros trades, absorptions, VWAP ;
  - `depth`   : carnet L2 (option `--depth`) ;
  - `feed`    : état de la connexion (source, stream, reconnexions, erreurs).

Les sous-modules lourds (`main`, qui tire aiohttp/websockets) sont importés à la
demande : `import crypto_feed` reste instantané et `python -m crypto_feed.main`
ne déclenche pas de double import.
"""
from __future__ import annotations

from typing import Any

from .config import DEFAULT, Config
from .options import ChainSnapshot, DeribitOptions, bs_gamma, parse_instrument
from .state import SharedState, configure
from .tape import FlowState, OrderBook, TapeFeed

__all__ = [
    "Config", "DEFAULT", "MarketFeed", "get_state", "SharedState", "configure",
    "DeribitOptions", "ChainSnapshot", "bs_gamma", "parse_instrument",
    "FlowState", "TapeFeed", "OrderBook",
]
__version__ = "1.0.0"

_LAZY = {"MarketFeed": ("main", "MarketFeed"), "get_state": ("main", "get_state")}


def __getattr__(name: str) -> Any:  # PEP 562
    target = _LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} n'a pas d'attribut {name!r}")
    from importlib import import_module

    return getattr(import_module(f".{target[0]}", __name__), target[1])


def __dir__() -> list[str]:
    return sorted(list(globals()) + list(_LAZY))
