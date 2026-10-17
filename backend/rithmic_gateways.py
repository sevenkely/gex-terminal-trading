"""Sonde R|Protocol brute : interroge un gateway Rithmic sur la liste des
systèmes (template 16) et des gateways (template 20), sans compte.

Le kit R|Protocol (RProtocolAPI.zip) documente `RequestRithmicSystemGatewayInfo`
(template 20) dont la réponse contient `gateway_name` / `gateway_uri` — c'est
l'information qui manque pour un compte paper. Le kit ne fournit pas les
bindings Python de ces deux messages : on encode/décode donc la trame à la main
(le protocole est du protobuf standard, seuls les numéros de champ Rithmic
changent, cf. 0.90.0.0/proto/request_rithmic_system_gateway_info.proto).

Usage :
    python rithmic_gateways.py [wss://rituz00100.rithmic.com:443] [system_name]
"""
from __future__ import annotations

import asyncio
import json
import os
import ssl
import sys
import time
import zipfile

import websockets

KIT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                   "RProtocolAPI.zip")
CERT_FALLBACK = ("C:/Users/ANDRY/AppData/Local/Python/pythoncore-3.14-64/"
                 "Lib/site-packages/async_rithmic/certificates/"
                 "rithmic_ssl_cert_auth_params")

# numéros de champ Rithmic (cf. 0.90.0.0/proto/*.proto)
F_TEMPLATE_ID = 154467     # int32  (valeur = numéro de template)
F_USER_MSG = 132760        # repeated string
F_RP_CODE = 132766         # repeated string
F_SYSTEM_NAME = 153628     # repeated string
F_GATEWAY_NAME = 153640    # repeated string (réponse 20)
F_GATEWAY_URI = 153641     # repeated string (réponse 20)

T_IDX_INFO = 16            # RequestRithmicSystemInfo  -> réponse 17
T_IDX_GATEWAY = 20         # RequestRithmicSystemGatewayInfo -> réponse 21
T_RESP_INFO = 17
T_RESP_GATEWAY = 21


# ------------------------------------------------------------------ protobuf
def _varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def enc_int(field: int, value: int) -> bytes:
    return _varint(field << 3) + _varint(value)


def enc_str(field: int, text: str) -> bytes:
    data = text.encode()
    return _varint(field << 3 | 2) + _varint(len(data)) + data


def dec_msg(buf: bytes) -> dict[int, list]:
    """Décode un message protobuf en {numéro_de_champ: [valeurs]}."""
    out: dict[int, list] = {}
    i, n = 0, len(buf)
    while i < n:
        key = 0
        shift = 0
        while True:
            b = buf[i]
            i += 1
            key |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        field, wire = key >> 3, key & 7
        if wire == 0:
            val, shift = 0, 0
            while True:
                b = buf[i]
                i += 1
                val |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
            out.setdefault(field, []).append(val)
        elif wire == 2:
            ln, shift = 0, 0
            while True:
                b = buf[i]
                i += 1
                ln |= (b & 0x7F) << shift
                shift += 7
                if not b & 0x80:
                    break
            out.setdefault(field, []).append(buf[i:i + ln])
            i += ln
        elif wire == 5:
            i += 4
        elif wire == 1:
            i += 8
        else:
            raise ValueError(f"wire type {wire} non géré (champ {field})")
    return out


def _strs(msg: dict, field: int) -> list[str]:
    return [v.decode("utf-8", "replace") for v in msg.get(field, [])
            if isinstance(v, bytes)]


def _ssl_context() -> ssl.SSLContext:
    """Certificats USERTRUST, comme le kit (etc/rithmic_ssl_cert_auth_params)."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    pem = None
    try:
        with zipfile.ZipFile(KIT) as z:
            pem = z.read("0.90.0.0/etc/rithmic_ssl_cert_auth_params")
    except Exception:
        pass
    path = os.path.join(os.path.dirname(__file__), ".rithmic_ca.pem")
    if pem:
        with open(path, "wb") as f:
            f.write(pem)
    elif os.path.exists(CERT_FALLBACK):
        path = CERT_FALLBACK
    ctx.load_verify_locations(path)
    return ctx


# -------------------------------------------------------------------- probe
async def ask_once(uri: str, template: int, user_msg: str,
                   system_name: str | None, want: int,
                   timeout: float = 8.0) -> dict:
    """Une connexion par requête : le serveur ferme le socket après réponse."""
    payload = enc_int(F_TEMPLATE_ID, template) + enc_str(F_USER_MSG, user_msg)
    if system_name is not None:
        payload += enc_str(F_SYSTEM_NAME, system_name)
    async with websockets.connect(uri, ssl=_ssl_context(), ping_interval=20) as ws:
        await ws.send(payload)
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=deadline - time.time())
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                break
            msg = dec_msg(raw if isinstance(raw, bytes) else raw.encode())
            tpl = (msg.get(F_TEMPLATE_ID) or [None])[0]
            if tpl == want:
                return msg
            print(f"    (trame reçue template={tpl}, rp_code={_strs(msg, F_RP_CODE)},"
                  f" rejet={_strs(msg, F_SYSTEM_NAME)[:2] or _strs(msg, 130002)[:2]})")
    return {}


async def discover(uri: str, system_name: str | None = None) -> dict:
    """Interroge un gateway : systèmes servis (16) + gateways R|Protocol (20).

    Réutilisé par l'API (`/api/rithmic/discover`) et par la ligne de commande.
    """
    out: dict = {"url": uri, "systems": [], "gateways": [], "rp_code": None,
                 "error": None}
    try:
        rp = await ask_once(uri, T_IDX_INFO, "systems", None, T_RESP_INFO)
        if rp:
            out["systems"] = _strs(rp, F_SYSTEM_NAME)
            out["rp_code"] = (_strs(rp, F_RP_CODE) or [None])[0]
        else:
            out["error"] = "aucune réponse au RequestRithmicSystemInfo (16)"

        rp = await ask_once(uri, T_IDX_GATEWAY, "gateways", system_name,
                            T_RESP_GATEWAY)
        if rp:
            names = _strs(rp, F_GATEWAY_NAME)
            uris = _strs(rp, F_GATEWAY_URI)
            out["gateways"] = [{"name": n, "uri": u}
                               for n, u in zip(names, uris)]
            code = _strs(rp, F_RP_CODE)
            if code and code[0] != "0":
                out["gateway_error"] = " ".join(code)
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


async def main() -> int:
    uri = sys.argv[1] if len(sys.argv) > 1 else "wss://rituz00100.rithmic.com:443"
    # R|Protocol : la valeur demandée doit correspondre à ce que sert le gateway
    target = sys.argv[2] if len(sys.argv) > 2 else "Rithmic Test"

    print(f"connexion {uri} …\n")
    info = await discover(uri, target)
    if info.get("error"):
        print("  erreur :", info["error"])
    print("  rp_code:", info.get("rp_code"))
    print("  systèmes servis par ce gateway:", info["systems"])
    print(f"\n  {len(info['gateways'])} gateways R|Protocol:")
    for g in info["gateways"]:
        print(f"    {g['name']:28} {g['uri']}")
    if info.get("gateway_error"):
        print("  gateway_info:", info["gateway_error"])
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
