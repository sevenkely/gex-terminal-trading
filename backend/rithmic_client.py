"""Client Rithmic R | Protocol (WebSocket + protobuf) — module autonome.

Ce fichier ne dépend ni de FastAPI ni de l'app GEX : il peut tourner seul en
console (`python rithmic_client.py --symbol NQ --exchange CME`) ou être importé
par le reste du backend. Les seules dépendances sont `websockets` et les
bindings protobuf générés depuis les .proto du dev kit (dossier `rithmic_pb/`).

Points du protocole, reprises telles quelles de `0.90.0.0/samples/samples.py/
SampleMD.py` du kit :

  - gateway du kit          : wss://rituz00100.rithmic.com:443
  - RequestLogin            : template 10  -> ResponseLogin 11
  - RequestLogout           : template 12
  - RequestRithmicSystemInfo: template 16  -> réponse 17
  - RequestHeartbeat        : template 18  -> réponse 19
  - RequestSystemGatewayInfo: template 20  -> réponse 21 (gateway_name/uri)
  - RequestMarketDataUpdate : template 100 -> réponse 101 (abonnement)
  - LastTrade               : template 150
  - BestBidOffer            : template 151
  - infra_type              : TICKER_PLANT (1) pour du market data
  - template_version        : "5.55" (valeur du sample)

Sécurité : aucun identifiant n'est écrit ici. Tout vient de l'environnement
(`.env` chargé par `env_file.py`, non versionné).
"""
from __future__ import annotations

import asyncio
import logging
import os
import ssl
import time
from typing import Callable

import websockets
from websockets.exceptions import ConnectionClosed

from rithmic_pb import (
    best_bid_offer_pb2,
    last_trade_pb2,
    request_heartbeat_pb2,
    request_login_pb2,
    request_logout_pb2,
    request_market_data_update_pb2,
    request_rithmic_system_gateway_info_pb2,
    request_rithmic_system_info_pb2,
    response_heartbeat_pb2,
    response_login_pb2,
    response_market_data_update_pb2,
    response_rithmic_system_gateway_info_pb2,
    response_rithmic_system_info_pb2,
)

log = logging.getLogger("gex.rithmic.client")

# URL du gateway de test : celle des exemples du kit (SampleMD.py), pas une
# valeur devinée. Le système servi par ce host est « Rithmic Test » (vérifié
# avec RequestRithmicSystemInfo, template 16).
KIT_GATEWAY = "wss://rituz00100.rithmic.com:443"
KIT_SYSTEM = "Rithmic Test"

# Numéros de champ Rithmic (pas standard protobuf) vers template_id.
F_TEMPLATE_ID = 154467

T_LOGIN_RESP = 11
T_LOGOUT_RESP = 13
T_SYSTEM_INFO_RESP = 17
T_HEARTBEAT_RESP = 19
T_GATEWAY_INFO_RESP = 21
T_MDU_RESP = 101
T_LAST_TRADE = 150
T_BBO = 151

# UpdateBits de RequestMarketDataUpdate
UPDATE_LAST_TRADE = 1
UPDATE_BBO = 2
UPDATE_ORDER_BOOK = 4

_CA_PATH = os.path.join(os.path.dirname(__file__), ".rithmic_ca.pem")
_CA_FALLBACK = (
    "C:/Users/ANDRY/AppData/Local/Python/pythoncore-3.14-64/"
    "Lib/site-packages/async_rithmic/certificates/rithmic_ssl_cert_auth_params"
)


class RithmicError(RuntimeError):
    """Erreur renvoyée par Rithmic (rp_code) ou par la couche réseau."""

    def __init__(self, message: str, rp_code: str | None = None) -> None:
        super().__init__(message)
        self.rp_code = rp_code

    @property
    def fatal(self) -> bool:
        """Un refus d'authentification ne se répare pas en réessayant."""
        return self.rp_code in {"7", "13", "14", "15"}


# --------------------------------------------------------------------- utils
def _peek_template_id(buf: bytes) -> int | None:
    """Lit le champ `template_id` (154467) sans connaître le message.

    Chaque trame Rithmic porte ce champ : c'est ce qui permet de router une
    réponse vers la bonne classe protobuf. Les champs arrivent triés, donc
    `template_id` est en tête ; on s'arrête dès qu'on l'a trouvé.
    """
    i, n = 0, len(buf)
    while i < n:
        key = shift = 0
        while i < n:
            b = buf[i]
            i += 1
            key |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        field, wire = key >> 3, key & 7
        if wire == 0:
            val = shift = 0
            while i < n:
                b = buf[i]
                i += 1
                val |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
            if field == F_TEMPLATE_ID:
                return val
        elif wire == 2:
            ln = shift = 0
            while i < n:
                b = buf[i]
                i += 1
                ln |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
            i += ln
        elif wire == 5:
            i += 4
        elif wire == 1:
            i += 8
        else:
            return None
    return None


def _ssl_context() -> ssl.SSLContext:
    """Contexte TLS avec le certificat fourni par le kit (USERTRUST)."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    path = _CA_PATH if os.path.exists(_CA_PATH) else _CA_FALLBACK
    ctx.load_verify_locations(path)
    return ctx


def settings_from_env() -> dict:
    """Identifiants et gateway, lus uniquement dans l'environnement.

    Les valeurs par défaut reprennent celles du kit (gateway + système), pas
    des identifiants : il n'y a donc rien de secret ici.
    """
    return {
        "user": os.environ.get("RITHMIC_USER", ""),
        "password": os.environ.get("RITHMIC_PASS", ""),
        "system_name": os.environ.get("RITHMIC_SYSTEM", KIT_SYSTEM),
        "url": os.environ.get("RITHMIC_URL", KIT_GATEWAY),
        "app_name": os.environ.get("RITHMIC_APP_NAME", "GexTerminal"),
        "app_version": os.environ.get("RITHMIC_APP_VERSION", "1.0"),
    }


# -------------------------------------------------------------------- client
class RithmicMDClient:
    """Connexion market data Rithmic : login, heartbeat, reconnexion, abonnement.

    Utilisation minimale :

        client = RithmicMDClient(**settings_from_env())
        client.on_trade = lambda t: print(t["price"], t["size"], t["side"])
        await client.run({"NQ": "CME"})     # bloque, se reconnecte seul

    `run()` ne rend la main que sur `stop()` (ou sur une erreur fatale type
    identifiants refusés, qu'il serait absurde de réessayer).
    """

    def __init__(self, user: str, password: str, system_name: str = KIT_SYSTEM,
                 url: str = KIT_GATEWAY, app_name: str = "GexTerminal",
                 app_version: str = "1.0") -> None:
        if not user or not password:
            raise RithmicError("RITHMIC_USER / RITHMIC_PASS absents de l'environnement")
        self.user = user
        self.password = password
        self.system_name = system_name
        self.url = url if "://" in url else f"wss://{url}"
        self.app_name = app_name
        self.app_version = app_version

        self.ws = None
        self.heartbeat_interval = 20.0
        self.connected = False
        self.last_rx = 0.0
        self._stop = asyncio.Event()
        self._subscriptions: list[tuple[str, str, int]] = []
        self._next_req_id = 0
        self.last_sub_error: tuple[str, str] | None = None   # (rp_code, message)

        # callbacks (synchrones ou coroutines)
        self.on_trade: Callable[[dict], None] | None = None
        self.on_bbo: Callable[[dict], None] | None = None
        self.on_status: Callable[[str, str], None] | None = None

    # ------------------------------------------------------------- plumbing
    def _status(self, state: str, message: str = "") -> None:
        log.info("[%s] %s", state, message)
        if self.on_status:
            self.on_status(state, message)

    def _new_req_id(self) -> str:
        self._next_req_id += 1
        return f"gex-{self._next_req_id}"

    async def _send(self, msg) -> None:
        if self.ws is None:
            raise RithmicError("socket fermé")
        await self.ws.send(msg.SerializeToString())

    async def _recv(self) -> tuple[int | None, bytes]:
        raw = await self.ws.recv()
        buf = raw if isinstance(raw, bytes) else raw.encode()
        self.last_rx = time.monotonic()
        return _peek_template_id(buf), buf

    async def _wait_for(self, template_id: int, timeout: float = 15.0) -> bytes:
        """Attend la première trame d'un template donné (les autres sont ignorées)."""
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise RithmicError(f"timeout en attendant le template {template_id}")
            try:
                tpl, buf = await asyncio.wait_for(self._recv(), timeout=left)
            except asyncio.TimeoutError:
                raise RithmicError(f"timeout en attendant le template {template_id}") from None
            if tpl == template_id:
                return buf

    # --------------------------------------------------------------- queries
    async def list_systems(self) -> list[str]:
        """RequestRithmicSystemInfo (16) : noms de systèmes servis par le gateway."""
        rq = request_rithmic_system_info_pb2.RequestRithmicSystemInfo()
        rq.template_id = 16
        rq.user_msg.append(self._new_req_id())
        await self._send(rq)
        rp = response_rithmic_system_info_pb2.ResponseRithmicSystemInfo()
        rp.ParseFromString(await self._wait_for(T_SYSTEM_INFO_RESP))
        code = rp.rp_code[0] if rp.rp_code else "0"
        if code != "0":
            raise RithmicError(f"RequestRithmicSystemInfo refusé : rp_code={code}", code)
        return list(rp.system_name)

    async def gateway_info(self, system_name: str | None = None) -> list[dict]:
        """RequestRithmicSystemGatewayInfo (20) : liste des gateways R|Protocol."""
        rq = request_rithmic_system_gateway_info_pb2.RequestRithmicSystemGatewayInfo()
        rq.template_id = 20
        rq.user_msg.append(self._new_req_id())
        rq.system_name = system_name or self.system_name
        await self._send(rq)
        rp = response_rithmic_system_gateway_info_pb2.ResponseRithmicSystemGatewayInfo()
        rp.ParseFromString(await self._wait_for(T_GATEWAY_INFO_RESP))
        code = rp.rp_code[0] if rp.rp_code else "0"
        if code != "0":
            raise RithmicError(f"RequestRithmicSystemGatewayInfo refusé : rp_code={code}", code)
        return [{"name": n, "url": u} for n, u in zip(rp.gateway_name, rp.gateway_uri)]

    # ---------------------------------------------------------------- session
    async def connect(self) -> None:
        """Ouvre le socket, s'authentifie et démarre le heartbeat."""
        self._status("connecting", f"{self.url} · système « {self.system_name} »")
        self.ws = await websockets.connect(
            self.url, ssl=_ssl_context(), ping_interval=20, ping_timeout=20,
            max_size=None,
        )
        self.last_rx = time.monotonic()

        rq = request_login_pb2.RequestLogin()
        rq.template_id = 10
        rq.template_version = "5.55"           # valeur du sample du kit
        rq.user_msg.append(self._new_req_id())
        rq.user = self.user
        rq.password = self.password
        rq.app_name = self.app_name
        rq.app_version = self.app_version
        rq.system_name = self.system_name
        rq.infra_type = request_login_pb2.RequestLogin.SysInfraType.TICKER_PLANT
        await self._send(rq)

        # Le serveur peut envoyer plusieurs trames 10/11 : on retient la
        # première réponse de login qui porte un rp_code.
        try:
            buf = await self._wait_for(T_LOGIN_RESP)
        except RithmicError:
            raise RithmicError(
                "aucune réponse de login : le gateway a fermé le socket "
                "(URL ou système non servi par ce host ?)"
            ) from None
        rp = response_login_pb2.ResponseLogin()
        rp.ParseFromString(buf)
        code = rp.rp_code[0] if rp.rp_code else "0"
        if code != "0":
            detail = " ".join(rp.rp_code[1:]) or "sans message"
            raise RithmicError(
                f"authentification refusée (rp_code={code}, {detail}) — "
                f"user={self.user} système={self.system_name}",
                code,
            )

        self.heartbeat_interval = float(rp.heartbeat_interval or 20)
        self.connected = True
        self._status(
            "connected",
            f"{self.url} · {self.system_name} · heartbeat {self.heartbeat_interval:.0f}s"
            + (f" · fcm={rp.fcm_id[0]}" if rp.fcm_id else ""),
        )
        await self._send_heartbeat()           # exigé après un login réussi

    async def _send_heartbeat(self) -> None:
        rq = request_heartbeat_pb2.RequestHeartbeat()
        rq.template_id = 18
        await self._send(rq)

    async def _heartbeat_loop(self) -> None:
        """Envoie un heartbeat dès que le flux est muet depuis half-interval.

        Rithmic ferme le socket sans heartbeat ; on ne se contente pas du ping
        WebSocket car le serveur attend la trame applicative 18.
        """
        while True:
            idle = time.monotonic() - self.last_rx
            wait = max(2.0, self.heartbeat_interval / 2 - idle)
            await asyncio.sleep(wait)
            if idle >= self.heartbeat_interval / 2:
                try:
                    await self._send_heartbeat()
                except ConnectionClosed:
                    return

    async def subscribe(self, symbol: str, exchange: str,
                        update_bits: int = UPDATE_LAST_TRADE | UPDATE_BBO) -> None:
        """RequestMarketDataUpdate (100) en mode SUBSCRIBE."""
        rq = request_market_data_update_pb2.RequestMarketDataUpdate()
        rq.template_id = 100
        rq.user_msg.append(self._new_req_id())
        rq.symbol = symbol
        rq.exchange = exchange
        rq.request = request_market_data_update_pb2.RequestMarketDataUpdate.Request.SUBSCRIBE
        rq.update_bits = update_bits
        await self._send(rq)
        self._subscriptions.append((symbol, exchange, update_bits))
        log.info("abonnement demandé : %s.%s (bits %d)", symbol, exchange, update_bits)

    async def unsubscribe(self, symbol: str, exchange: str,
                          update_bits: int = UPDATE_LAST_TRADE | UPDATE_BBO) -> None:
        rq = request_market_data_update_pb2.RequestMarketDataUpdate()
        rq.template_id = 100
        rq.user_msg.append(self._new_req_id())
        rq.symbol = symbol
        rq.exchange = exchange
        rq.request = request_market_data_update_pb2.RequestMarketDataUpdate.Request.UNSUBSCRIBE
        rq.update_bits = update_bits
        await self._send(rq)

    async def logout(self) -> None:
        try:
            rq = request_logout_pb2.RequestLogout()
            rq.template_id = 12
            rq.user_msg.append(self._new_req_id())
            await self._send(rq)
        except Exception:  # noqa: BLE001 — un logout raté ne doit pas masquer l'arrêt
            pass
        if self.ws is not None:
            await self.ws.close(1000, "see you tomorrow")
        self.connected = False

    def stop(self) -> None:
        self._stop.set()

    # ---------------------------------------------------------------- events
    def _dispatch(self, tpl: int | None, buf: bytes) -> None:
        if tpl == T_LAST_TRADE:
            m = last_trade_pb2.LastTrade()
            m.ParseFromString(buf)
            if m.is_snapshot and not m.trade_price:
                return
            size = m.trade_size or m.trade_size_64
            trade = {
                "symbol": m.symbol, "exchange": m.exchange,
                "price": m.trade_price, "size": size,
                "side": "BUY" if m.aggressor == last_trade_pb2.LastTrade.TransactionType.BUY
                        else "SELL" if m.aggressor == last_trade_pb2.LastTrade.TransactionType.SELL
                        else "UNKNOWN",
                "volume": m.volume, "ts": (m.ssboe, m.usecs),
                "snapshot": m.is_snapshot,
            }
            if self.on_trade:
                self.on_trade(trade)

        elif tpl == T_BBO:
            m = best_bid_offer_pb2.BestBidOffer()
            m.ParseFromString(buf)
            bbo = {
                "symbol": m.symbol, "exchange": m.exchange,
                "bid": m.bid_price if m.presence_bits & best_bid_offer_pb2.BestBidOffer.PresenceBits.BID else None,
                "bid_size": m.bid_size or m.bid_size_64,
                "ask": m.ask_price if m.presence_bits & best_bid_offer_pb2.BestBidOffer.PresenceBits.ASK else None,
                "ask_size": m.ask_size or m.ask_size_64,
                "snapshot": m.is_snapshot, "ts": (m.ssboe, m.usecs),
            }
            if self.on_bbo:
                self.on_bbo(bbo)

        elif tpl == T_MDU_RESP:
            m = response_market_data_update_pb2.ResponseMarketDataUpdate()
            m.ParseFromString(buf)
            code = m.rp_code[0] if m.rp_code else "0"
            if code == "0":
                self.last_sub_error = None
                log.info("abonnement confirmé par le serveur (template 101, rp_code=0)")
            elif code == "7":
                # rp_code 7 = « no data » : le gateway n'a rien à diffuser pour
                # ce couple symbole/exchange. Sur la conformance c'est le cas
                # hors séance (aucun flux CME n'y est relayé).
                self.last_sub_error = (code, "no data")
                log.warning(
                    "aucune donnée pour ce flux (template 101, rp_code=7) : "
                    "marché fermé, ou ce gateway ne relaie pas les données CME "
                    "(la conformance ne sert qu'aux tests d'ordres)")
            else:
                self.last_sub_error = (code, " ".join(m.rp_code[1:]))
                log.error("abonnement refusé (template 101) : rp_code=%s %s",
                          code, " ".join(m.rp_code[1:]))

        elif tpl == T_HEARTBEAT_RESP:
            m = response_heartbeat_pb2.ResponseHeartbeat()
            m.ParseFromString(buf)
            log.debug("heartbeat ok (template 19)")

        elif tpl in (T_LOGOUT_RESP, T_SYSTEM_INFO_RESP, T_GATEWAY_INFO_RESP, T_LOGIN_RESP):
            pass  # réponses déjà consommées de façon synchrone
        else:
            log.debug("trame ignorée template=%s", tpl)

    async def _recv_loop(self) -> None:
        while True:
            tpl, buf = await self._recv()
            self._dispatch(tpl, buf)

    # ------------------------------------------------------------------ main
    async def run(self, symbols: dict[str, str], retry_delays=(1, 2, 5, 10, 20, 30),
                  max_retries: int | None = None) -> None:
        """Connexion + abonnements, avec reconnexion exponentielle.

        `symbols` : {"NQ": "CME"}. Lève RithmicError si l'échec est fatal
        (identifiants / système), au lieu de boucler indéfiniment.
        """
        attempt = 0
        while not self._stop.is_set():
            try:
                await self.connect()
                attempt = 0
                for symbol, exchange in symbols.items():
                    await self.subscribe(symbol, exchange)
                tasks = [asyncio.create_task(self._recv_loop(), name="recv"),
                         asyncio.create_task(self._heartbeat_loop(), name="heartbeat")]
                done, pending = await asyncio.wait(
                    tasks + [asyncio.create_task(self._stop.wait(), name="stop")],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for t in pending:
                    t.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                for t in done:
                    if t.cancelled():
                        continue
                    exc = t.exception()
                    if exc:
                        raise exc
            except asyncio.CancelledError:
                raise
            except RithmicError as exc:
                if exc.fatal:
                    self._status("error", str(exc))
                    raise
                self._status("error", str(exc))
            except ConnectionClosed as exc:
                self._status("disconnected", f"socket fermé ({exc.code} {exc.reason or ''})".strip())
            except OSError as exc:
                self._status("error", f"réseau : {exc}")
            finally:
                self.connected = False
                if self.ws is not None:
                    try:
                        await self.ws.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self.ws = None

            if self._stop.is_set():
                break
            attempt += 1
            if max_retries is not None and attempt > max_retries:
                raise RithmicError(f"abandon après {max_retries} tentatives")
            delay = retry_delays[min(attempt - 1, len(retry_delays) - 1)]
            self._status("reconnecting", f"nouvelle tentative dans {delay}s")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass
        await self.logout()


# ----------------------------------------------------------------------- CLI
def _fmt_time(ssboe: int, usecs: int = 0) -> str:
    if not ssboe:
        return "--:--:--"
    return time.strftime("%H:%M:%S", time.gmtime(ssboe)) + f".{usecs // 1000:03d}"


async def _cli(argv: list[str]) -> int:
    import argparse

    from env_file import load_env

    load_env()
    ap = argparse.ArgumentParser(description="Client market data Rithmic R | Protocol")
    ap.add_argument("--symbol", default="NQ")
    ap.add_argument("--exchange", default="CME")
    ap.add_argument("--system", default=None, help="system_name (défaut: env ou 'Rithmic Test')")
    ap.add_argument("--url", default=None, help="gateway (défaut: env ou celui du kit)")
    ap.add_argument("--systems", action="store_true", help="liste les systèmes du gateway puis sort")
    ap.add_argument("--gateways", action="store_true", help="liste les gateways (template 20) puis sort")
    ap.add_argument("--duration", type=float, default=0, help="durée d'écoute en s (0 = illimité)")
    ap.add_argument("--quiet-bbo", action="store_true", help="ne pas afficher le carnet")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    cfg = settings_from_env()
    client = RithmicMDClient(
        user=cfg["user"], password=cfg["password"],
        system_name=args.system or cfg["system_name"],
        url=args.url or cfg["url"],
        app_name=cfg["app_name"], app_version=cfg["app_version"],
    )

    # --systems / --gateways : une seule connexion, pas d'abonnement
    if args.systems or args.gateways:
        await client.connect()
        try:
            if args.systems:
                print("systèmes servis :", await client.list_systems())
            if args.gateways:
                print("gateways R|Protocol :")
                for g in await client.gateway_info():
                    print(f"  {g['name']:28} {g['url']}")
        finally:
            await client.logout()
        return 0

    # flux console : trades + BBO
    stats = {"trades": 0, "vol": 0, "bbo": 0}
    last_bbo = {"bid": None, "ask": None}

    def on_trade(t: dict) -> None:
        stats["trades"] += 1
        stats["vol"] += int(t["size"] or 0)
        print(f"{_fmt_time(*t['ts'])}  TRADE  {t['price']:>10.2f} × {t['size']:<5} "
              f"{t['side']:<4} | cum {stats['trades']:>4} trades, {stats['vol']:,} contrats")

    def on_bbo(b: dict) -> None:
        if args.quiet_bbo:
            return
        if (b["bid"], b["ask"]) == (last_bbo["bid"], last_bbo["ask"]):
            return
        last_bbo.update(bid=b["bid"], ask=b["ask"])
        stats["bbo"] += 1
        print(f"{_fmt_time(*b['ts'])}  BOOK   bid {b['bid']} × {b['bid_size']}  "
              f"/  ask {b['ask']} × {b['ask_size']}")

    client.on_trade = on_trade
    client.on_bbo = on_bbo
    client.on_status = lambda s, m: print(f"[{s}] {m}")

    task = asyncio.create_task(client.run({args.symbol: args.exchange}))
    if args.duration:
        await asyncio.sleep(args.duration)
        client.stop()
    else:
        print("Ctrl+C pour quitter.")
        try:
            await task
        except (KeyboardInterrupt, asyncio.CancelledError):
            client.stop()
    try:
        await asyncio.wait_for(task, timeout=10)
    except asyncio.TimeoutError:
        task.cancel()
    print(f"\nbilan : {stats['trades']} trades, {stats['vol']:,} contrats, "
          f"{stats['bbo']} mises à jour de carnet")
    return 0


if __name__ == "__main__":
    import sys

    try:
        raise SystemExit(asyncio.run(_cli(sys.argv[1:])))
    except RithmicError as exc:
        print(f"ECHEC : {exc}")
        raise SystemExit(2) from None
