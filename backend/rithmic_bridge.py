"""
RithmicBridge — accès optionnel aux données de marché Rithmic pour le prix
temps réel (async_rithmic). Configurable depuis l'UI (modale Paramètres).

- Les onglets futures (ES/NQ/GC) reçoivent le prix direct du contrat
  (front-month auto-résolu ou contrat précisé par l'utilisateur).
- Les onglets cash (SPX/SPY/QQQ/GLD) peuvent être "ancrés" : les variations
  viennent du tick Rithmic, le niveau reste celui du cash (offset calculé au
  premier tick) — évite le saut du basis.
- Sans accès données : sources publiques différées. En cas de coupure live :
  prix figé et statut STALE ; aucune simulation automatique.
- Analyse uniquement : TICKER_PLANT, sans connexion aux plants ordres/P&L.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from security import validate_gateway
from storage import write_json
from flow_store import FlowStore

import flow as flow_mod

log = logging.getLogger("gex.rithmic")
# La librairie async_rithmic journalise la requête de login COMPLÈTE (mot de
# passe en clair) dans son logger « rithmic » en cas d'échec : on coupe ses
# logs pour ne rien écrire d'exploitable sur disque (data/server.log).
logging.getLogger("rithmic").setLevel(logging.CRITICAL)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
CONFIG_PATH = os.path.join(DATA_DIR, "rithmic_config.json")

# Gateways et system_name réels, relevés avec le template 20 du R|Protocol
# (`python rithmic_client.py --gateways`) puis le template 16 sur chaque host :
#   rprotocol-mobile (Chicago Area), -ie (Europe), -de (Francfort), -sg…
# « Rithmic Paper Trading » n'est servi QUE par -ie / -de / -sg ; le host de
# conformance ne sert que « Rithmic Test ». Le gateway Chicago Area refuse la
# poignée de main TLS hors app mobile, d'où son absence des préréglages.
PAPER_URL = "rprotocol-ie.rithmic.com:443"
CONFORMANCE_URL = "rituz00100.rithmic.com:443"
PRESETS = [
    {"label": "Conformance — Rithmic Test (défaut)", "system_name": "Rithmic Test",
     "url": CONFORMANCE_URL},
    {"label": "Paper Trading — Europe", "system_name": "Rithmic Paper Trading",
     "url": PAPER_URL},
    {"label": "Paper Trading — Francfort", "system_name": "Rithmic Paper Trading",
     "url": "rprotocol-de.rithmic.com:443"},
    {"label": "Paper Trading — Singapour", "system_name": "Rithmic Paper Trading",
     "url": "rprotocol-sg.rithmic.com:443"},
    {"label": "Live — Rithmic 01 (Europe)", "system_name": "Rithmic 01",
     "url": PAPER_URL},
    {"label": "Prop firm — Apex", "system_name": "Apex", "url": PAPER_URL},
    {"label": "Prop firm — Tradeify", "system_name": "Tradeify", "url": PAPER_URL},
]

DEFAULT_MAPPINGS = {
    "ES":  {"exchange": "CME",   "contract": "", "root": "ES", "mode": "direct"},
    "NQ":  {"exchange": "CME",   "contract": "", "root": "NQ", "mode": "direct"},
    "GC":  {"exchange": "COMEX", "contract": "", "root": "GC", "mode": "direct"},
    "SPX": {"exchange": "CME",   "contract": "", "root": "ES", "mode": "anchor"},
    "SPY": {"exchange": "CME",   "contract": "", "root": "ES", "mode": "anchor"},
    "QQQ": {"exchange": "CME",   "contract": "", "root": "NQ", "mode": "anchor"},
    "GLD": {"exchange": "COMEX", "contract": "", "root": "GC", "mode": "anchor"},
}

DEFAULT_CONFIG = {
    "enabled": False,
    "user": "",
    "password": "",
    "system_name": "Rithmic Test",
    "url": CONFORMANCE_URL,
    "app_name": "GexTerminal",
    "app_version": "1.0",
    "auto_connect": True,
    "mappings": DEFAULT_MAPPINGS,
}


class RithmicBridge:
    def __init__(self, engine) -> None:
        self.engine = engine
        self.config = self._load()
        if os.path.exists(CONFIG_PATH):
            self._save()  # migrate legacy files: remove persisted password
        self.client = None
        self._connect_task: asyncio.Task | None = None
        self.status: dict = {
            "state": "disconnected",   # disconnected|connecting|connected|error
            "message": "",
            "since": None,
            "contracts": {},           # tab -> {exchange, contract, mode, last_price, last_ts, ticks}
        }
        self._subs: dict[tuple, list[str]] = {}   # (exchange, contract) -> tabs
        self._anchors: dict[str, float] = {}      # tab -> offset
        self.books: dict[tuple, dict] = {}        # (exchange, contract) -> order book
        self._book_batches: dict[tuple, dict] = {}
        self.flow = flow_mod.OrderFlowEngine(FlowStore(os.path.join(DATA_DIR, "flow.sqlite"), "rithmic"))    # gros trades / absorption / delta
        self._bbo: dict[tuple, tuple] = {}        # (exchange, contract) -> (bid, ask, ts)

    # ------------------------------------------------------------ order book
    def _book_for(self, key: tuple) -> dict:
        if key not in self.books:
            self.books[key] = {"bids": {}, "asks": {}, "ts": None,
                               "update_type": None}
        return self.books[key]

    @staticmethod
    def _field(data, name, default=None):
        """Champ d'une trame Rithmic : message protobuf (flux réel, template 156)
        ou dict (jeux de test)."""
        if isinstance(data, dict):
            return data.get(name, default)
        return getattr(data, name, default)

    @staticmethod
    def _levels(data) -> list[tuple]:
        """Le carnet Rithmic arrive avec des listes de niveaux par message."""
        def lst(name):
            v = RithmicBridge._field(data, name)
            if v is None:
                return []
            if isinstance(v, (str, bytes, int, float)):
                return [v]
            try:
                return list(v)
            except TypeError:
                return [v]

        bp, bs, bo = lst("bid_price"), lst("bid_size"), lst("bid_orders")
        ap, aq, ao = lst("ask_price"), lst("ask_size"), lst("ask_orders")
        out = []
        for i in range(max(len(bp), len(bs), len(ap), len(aq))):
            out.append((
                bp[i] if i < len(bp) else None,
                (bs[i] if i < len(bs) else 0) or (bo[i] if i < len(bo) else 0),
                ap[i] if i < len(ap) else None,
                (aq[i] if i < len(aq) else 0) or (ao[i] if i < len(ao) else 0),
            ))
        return out

    @staticmethod
    def _apply_level(target: dict, bp, bs, ap, aq) -> None:
        """Un niveau : taille > 0 = upsert, taille 0 = suppression."""
        if bp and bp > 0:
            if bs and bs > 0:
                target["bids"][float(bp)] = float(bs)
            else:
                target["bids"].pop(float(bp), None)
        if ap and ap > 0:
            if aq and aq > 0:
                target["asks"][float(ap)] = float(aq)
            else:
                target["asks"].pop(float(ap), None)

    def _handle_book(self, data) -> None:
        try:
            key = (self._field(data, "exchange"), self._field(data, "symbol"))
            book = self._book_for(key)
            ut = int(self._field(data, "update_type") or 0)
            levels = self._levels(data)
            # 1=CLEAR 2=NO_BOOK 3=SNAPSHOT 4=BEGIN 5=MIDDLE 6=END 7=SOLO
            if ut in (1, 2):
                book["bids"], book["asks"] = {}, {}
                self._book_batches.pop(key, None)
                book["ts"] = time.time()
            elif ut == 3:                       # SNAPSHOT : remplace le carnet
                book["bids"], book["asks"] = {}, {}
                for bp, bs, ap, aq in levels:
                    self._apply_level(book, bp, bs, ap, aq)
                book["ts"] = time.time()
            elif ut == 4:                       # BEGIN (début de lot)
                self._book_batches[key] = {"bids": {}, "asks": {}}
            elif ut == 5:                       # MIDDLE (entrée du lot)
                batch = self._book_batches.setdefault(key, {"bids": {}, "asks": {}})
                for bp, bs, ap, aq in levels:
                    self._apply_level(batch, bp, bs, ap, aq)
            elif ut == 6:                       # END (validation du lot)
                batch = self._book_batches.pop(key, None)
                if batch:
                    book["bids"].update(batch["bids"])
                    book["asks"].update(batch["asks"])
                    for side in ("bids", "asks"):
                        for p, q in batch[side].items():
                            if q <= 0:
                                book[side].pop(p, None)
                book["ts"] = time.time()
            else:                               # 7=SOLO, ou niveaux sans update_type
                for bp, bs, ap, aq in levels:
                    self._apply_level(book, bp, bs, ap, aq)
                if levels:
                    book["ts"] = time.time()
            book["update_type"] = ut
        except Exception:  # noqa: BLE001
            log.exception("order book handling failed")

    def get_book(self, tab: str, levels: int = 12) -> dict | None:
        m = self.config["mappings"].get(tab)
        if not m or self.status["state"] != "connected":
            return None
        contract = None
        for (exch, c), tabs in self._subs.items():
            if tab in tabs:
                contract, exchange = c, exch
                break
        if not contract:
            return None
        book = self.books.get((exchange, contract))
        if not book or not book["ts"] or time.time() - book["ts"] > 60:
            return None
        bids = sorted(book["bids"].items(), key=lambda kv: -kv[0])[:levels]
        asks = sorted(book["asks"].items(), key=lambda kv: kv[0])[:levels]
        return {
            "exchange": exchange, "contract": contract, "ts": book["ts"],
            "bids": [[p, q] for p, q in bids],
            "asks": [[p, q] for p, q in asks],
        }

    def flow_key(self, tab: str) -> tuple | None:
        """Clé (exchange, contract) du contrat sous-jacent à l'onglet."""
        for (exch, c), tabs in self._subs.items():
            if tab in tabs:
                return (exch, c)
        return None

    def get_flow(self, tab: str) -> dict | None:
        """Gros trades / absorption / delta du contrat sous-jacent à l'onglet
        (SPX->ES, NQ/QQQ->NQ, GLD/GC->GC…), alimenté par les ticks Rithmic."""
        key = self.flow_key(tab)
        if not key:
            return None
        exchange, contract = key
        snap = self.flow.get(key)
        if not snap or not snap.get("trades"):
            return None
        snap.update(contract=contract, exchange=exchange,
                    live=self.status["state"] == "connected")
        return snap

    def get_flow_bars(self, tab: str, interval: str = "5m",
                      limit: int = 240) -> list[dict]:
        """Delta/CVD par bougie du contrat sous-jacent à l'onglet."""
        key = self.flow_key(tab)
        return self.flow.bars(key, interval, limit) if key else []

    # ------------------------------------------------------------ config I/O
    def _redact(self, text: str) -> str:
        """Masque le mot de passe configuré s'il apparaît dans un message."""
        secret = self.config.get("password") or ""
        return text.replace(secret, "***") if secret else text

    def _load(self) -> dict:
        cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
        try:
            if os.path.exists(CONFIG_PATH):
                with open(CONFIG_PATH) as f:
                    saved = json.load(f)
                cfg.update({k: v for k, v in saved.items() if k != "mappings"})
                for tab, m in (saved.get("mappings") or {}).items():
                    if tab in cfg["mappings"]:
                        cfg["mappings"][tab].update(m)
        except Exception:  # noqa: BLE001
            log.exception("config load failed, using defaults")
        # .env / variables d'environnement : priorité sur le JSON (aucun
        # identifiant en dur dans le code ni dans le dépôt)
        for key, var in (("user", "RITHMIC_USER"), ("password", "RITHMIC_PASS"),
                         ("system_name", "RITHMIC_SYSTEM"), ("url", "RITHMIC_URL"),
                         ("app_name", "RITHMIC_APP_NAME"),
                         ("app_version", "RITHMIC_APP_VERSION")):
            value = (os.environ.get(var) or "").strip()
            if value:
                cfg[key] = value
        if (os.environ.get("RITHMIC_AUTO_CONNECT") or "").lower() in ("1", "true", "yes"):
            cfg["enabled"] = True
            cfg["auto_connect"] = True
        return cfg

    def _save(self) -> None:
        os.makedirs(DATA_DIR, exist_ok=True)
        write_json(CONFIG_PATH, {k:v for k,v in self.config.items() if k != "password"})

    def public(self) -> dict:
        cfg = json.loads(json.dumps(self.config))
        cfg["password"] = "•" * 8 if cfg.get("password") else ""
        return cfg

    def update_config(self, body: dict) -> None:
        if "url" in body:
            validate_gateway(body["url"])
        if "password" in body and not isinstance(body["password"], str):
            raise ValueError("Mot de passe invalide")
        for k in ("user", "system_name", "url", "app_name", "app_version"):
            if k in body and isinstance(body[k], str):
                self.config[k] = body[k].strip()
        if body.get("password"):
            self.config["password"] = body["password"]
        for k in ("enabled", "auto_connect"):
            if k in body:
                self.config[k] = bool(body[k])
        if isinstance(body.get("mappings"), dict):
            for tab, m in body["mappings"].items():
                if tab in self.config["mappings"] and isinstance(m, dict):
                    cur = self.config["mappings"][tab]
                    if "exchange" in m: cur["exchange"] = str(m["exchange"]).strip().upper()
                    if "contract" in m: cur["contract"] = str(m["contract"]).strip().upper()
                    if "mode" in m and m["mode"] in ("direct", "anchor"):
                        cur["mode"] = m["mode"]
        self._save()

    # --------------------------------------------------------------- connect
    async def connect(self) -> None:
        try:
            validate_gateway(self.config.get("url", ""))
        except ValueError as exc:
            self._set_state("error", str(exc))
            return
        if self.status["state"] in ("connecting","connected"):
            return
        if not (self.config.get("user") and self.config.get("password")):
            self._set_state("error", "Identifiants Rithmic manquants")
            return
        self._set_state("connecting", "Connexion à Rithmic…")
        self._connect_task = asyncio.create_task(self._connect_flow())

    async def check_rollover(self):
        """Detect provider front-month changes without silently replacing feeds."""
        if not self.client or self.status['state']!='connected':
            return
        checked={};pending=[];errors=0
        for tab,mapping in self.config['mappings'].items():
            current=self.status['contracts'].get(tab,{}).get('contract')
            if mapping.get('contract') or not current:
                continue
            key=(mapping.get('root'),mapping.get('exchange'))
            if key not in checked:
                try:
                    checked[key]=await asyncio.wait_for(self.client.get_front_month_contract(*key),timeout=10)
                except Exception:
                    checked[key]=None;errors+=1
            recommended=checked[key]
            if recommended and recommended!=current:
                pending.append(dict(symbol=tab,current=current,recommended=recommended))
        self.status['rollover']=dict(checked_at=time.time(),pending=pending,errors=errors,
            policy='manual_reconnect',limitation='Provider front-month convention; explicit contracts never auto-rolled.')

    async def _connect_flow(self) -> None:
        try:
            from async_rithmic import (RithmicClient, DataType, SysInfraType,
                                       LastTradePresenceBits,
                                       BestBidOfferPresenceBits)
        except ImportError:
            self._set_state("error", "async-rithmic non installé (pip install async-rithmic)")
            return
        try:
            client = RithmicClient(
                user=self.config["user"],
                password=self.config["password"],
                system_name=self.config["system_name"],
                app_name=self.config.get("app_name") or "GexTerminal",
                app_version=self.config.get("app_version") or "1.0",
                url=self.config["url"],
            )
            # Explicitly avoid the SDK default, which also connects ORDER/PNL plants.
            await asyncio.wait_for(client.connect(plants=[SysInfraType.TICKER_PLANT]), timeout=60)
            self.client = client

            # résolve les contrats et abonne
            self._subs = {}
            self._anchors = {}
            futures = []
            unresolved = []
            for tab, m in self.config["mappings"].items():
                contract = m.get("contract") or ""
                if not contract:
                    # La conformance ne sert pas les données de référence : un
                    # échec ici ne doit pas faire tomber une session pourtant
                    # authentifiée. On saute l'onglet et on le signale.
                    try:
                        contract = await client.get_front_month_contract(
                            m["root"], m["exchange"])
                        log.info("front month %s/%s -> %s", m["root"], m["exchange"], contract)
                    except Exception as exc:  # noqa: BLE001
                        log.warning("front month %s/%s indisponible : %s",
                                    m["root"], m["exchange"], self._redact(str(exc))[:120])
                        contract = ""
                if not contract:
                    unresolved.append(tab)
                    continue
                key = (m["exchange"], contract)
                self._subs.setdefault(key, []).append(tab)
                futures.append((tab, m, contract))

            if not self._subs:
                self._set_state(
                    "connected",
                    "Authentifié, mais aucun contrat résolu ("
                    + ", ".join(unresolved)
                    + ") : ce gateway ne sert pas les données de référence CME. "
                    "Renseignez un contrat explicite (ex. ESM6) ou utilisez un "
                    "compte market data. Les prix restent différés/figés.")
                return

            async def on_tick(data: dict) -> None:
                self._handle_tick(data)

            async def on_book(data: dict) -> None:
                self._handle_book(data)

            client.on_tick += on_tick
            client.on_order_book += on_book
            dtype = DataType.LAST_TRADE | DataType.BBO
            for (exch, contract), tabs in self._subs.items():
                await client.subscribe_to_market_data(contract, exch, dtype)
                # carnet d'ordres L2 pour les onglets en mode direct (futures)
                if any(self.config["mappings"][t]["mode"] == "direct" for t in tabs):
                    try:
                        await client.subscribe_to_market_data(
                            contract, exch, DataType.ORDER_BOOK)
                    except Exception:  # noqa: BLE001
                        log.warning("order book subscription failed for %s", contract)
                for t in tabs:
                    self.status["contracts"][t] = {
                        "exchange": exch, "contract": contract,
                        "mode": self.config["mappings"][t]["mode"],
                        "last_price": None, "last_ts": None, "ticks": 0,
                    }
            names = ", ".join(sorted({c for _, c in self._subs}))
            # La conformance authentifie mais ne relaie pas les flux CME : sans
            # cette précision, l'absence de ticks passerait pour un bug.
            note = (" · conformance : pas de flux CME (tests d'ordres)"
                    if self.config["system_name"] == "Rithmic Test" else "")
            self._set_state("connected", f"Connecté — {names}{note}")
        except asyncio.TimeoutError:
            self._set_state("error", "Timeout de connexion (60 s) — vérifiez l'URL du gateway")
        except Exception as e:  # noqa: BLE001
            # pas de traceback brut : l'exception Rithmic embarque la requête
            # de login complète (mot de passe) dans son message
            msg = self._redact(str(e))
            log.error("rithmic connect failed: %s", msg)
            if "valid SYSTEM_NAME" in msg:
                msg = ("Ce gateway ne sert pas ce system_name. Avec « Découvrir systèmes & "
                       "gateways » (templates 16 + 20) vous obtenez la liste servie par ce "
                       "host : la conformance ne sert que « Rithmic Test » ; "
                       "« Rithmic Paper Trading » n'existe que sur -ie/-de/-sg. "
                       f"[détail : {msg[:120]}]")
            elif "permission denied" in msg.lower() or "rp_code=13" in msg \
                    or "heartbeat_interval" in msg:
                msg = ("Authentification valide mais compte non habilité sur ce couple "
                       "system_name + gateway (rp_code 13 / permission denied). "
                       "Vérifiez le system_name exact (bouton « Découvrir systèmes & "
                       "gateways ») : les identifiants testés fonctionnent sur "
                       "« Rithmic Test » @ rituz00100, pas sur « Rithmic Paper Trading ». "
                       f"[détail : {self._redact(str(e))[:160]}]")
            elif isinstance(e, (OSError, ConnectionError)):
                msg = f"Gateway injoignable ({self.config['url']}) : {e}"
            self._set_state("error", f"Échec connexion : {msg}")
            self.client = None

    def _handle_tick(self, data: dict) -> None:
        try:
            from async_rithmic import DataType, LastTradePresenceBits, BestBidOfferPresenceBits
            exch = data.get("exchange")
            sym = data.get("symbol")
            price = None
            dt = data.get("data_type")
            now = time.time()
            if dt == DataType.LAST_TRADE:
                if data.get("presence_bits", 0) & LastTradePresenceBits.LAST_TRADE:
                    price = data.get("trade_price")
                    # tape : prix, taille, aggressor (1=BUY, 2=SELL) -> flux
                    size = float(data.get("trade_size") or 0)
                    if price and size > 0 and not data.get("is_snapshot"):
                        agg = int(data.get("aggressor") or 0)
                        if not agg:
                            bbo = self._bbo.get((exch, sym))
                            if bbo and bbo[0] and price >= bbo[1]:
                                agg = 1
                            elif bbo and bbo[1] and price <= bbo[0]:
                                agg = 2
                        self.flow.add_trade((exch, sym), sym, now,
                                            float(price), size, agg)
            elif dt == DataType.BBO:
                bid, ask = data.get("bid_price"), data.get("ask_price")
                bits = data.get("presence_bits", 0)
                has_bid = bits & BestBidOfferPresenceBits.BID and bid
                has_ask = bits & BestBidOfferPresenceBits.ASK and ask
                if has_bid or has_ask:
                    self._bbo[(exch, sym)] = (float(has_bid or 0),
                                              float(has_ask or 0), now)
                if has_bid and has_ask:
                    price = (bid + ask) / 2.0
                elif has_bid or has_ask:
                    price = float(has_bid or has_ask)
            if not price:
                return
            for tab in self._subs.get((exch, sym), []):
                m = self.config["mappings"][tab]
                px = float(price)
                if m["mode"] == "anchor":
                    if tab not in self._anchors:
                        self._anchors[tab] = self.engine.price(tab) - px
                    px += self._anchors[tab]
                self.engine.set_external(tab, px, now)
                c = self.status["contracts"].get(tab)
                if c:
                    c.update(last_price=px, last_ts=now, ticks=c["ticks"] + 1)
        except Exception:  # noqa: BLE001
            log.exception("tick handling failed")

    async def disconnect(self, message: str = "Déconnecté") -> None:
        if self._connect_task and not self._connect_task.done():
            self._connect_task.cancel()
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self.client = None
        self._subs = {}
        self._anchors = {}
        self.books = {}
        self._book_batches = {}
        for tab in list(self.status["contracts"]):
            self.engine.drop_external(tab)
        self.status["contracts"] = {}
        self._set_state("disconnected", message)

    def _set_state(self, state: str, message: str) -> None:
        self.status.update(state=state, message=message, since=time.time())
        log.info("rithmic %s: %s", state, message)
