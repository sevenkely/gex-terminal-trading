"""Diagnostic bas niveau d'une connexion Rithmic : affiche chaque trame de
réponse (template_id, rp_code, user_msg) reçue pendant le login, pour
distinguer un refus serveur d'une incompatibilité de la librairie.

Usage :
    RITHMIC_USER=xxx RITHMIC_PASS=yyy python rithmic_diag.py [gateway_url] [system_name]

Le mot de passe n'est jamais journalisé : seuls les CHAMPS DE RÉPONSE le sont.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys

from async_rithmic import RithmicClient
from async_rithmic.plants import base as base_mod

logging.getLogger("rithmic").setLevel(logging.CRITICAL)

SAFE_FIELDS = ("template_id", "user_msg", "rp_code", "heartbeat_interval",
               "template_version", "user", "unique_user_id")


async def _patched_process_response(self, response):
    fields = {}
    for name in SAFE_FIELDS:
        if hasattr(response, name):
            try:
                fields[name] = list(getattr(response, name)) or getattr(response, name)
            except TypeError:
                fields[name] = getattr(response, name)
    print(f"  <- {type(response).__name__} {fields}", flush=True)
    return await _patched_process_response.original(self, response)


async def main() -> int:
    user = os.environ.get("RITHMIC_USER", "")
    password = os.environ.get("RITHMIC_PASS", "")
    if not user or not password:
        print("RITHMIC_USER et RITHMIC_PASS sont requis.")
        return 2
    url = sys.argv[1] if len(sys.argv) > 1 else "rituz00100.rithmic.com:443"
    system = sys.argv[2] if len(sys.argv) > 2 else "Rithmic Test"

    _patched_process_response.original = base_mod.BasePlant._process_response
    base_mod.BasePlant._process_response = _patched_process_response

    print(f"gateway={url}  system_name={system!r}  user={user[:3]}***")
    client = RithmicClient(user=user, password=password, system_name=system,
                           app_name="GexDiag", app_version="1.0", url=url)
    try:
        await asyncio.wait_for(client.connect(), timeout=30)
        print("RESULTAT: connecté")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"RESULTAT: échec -> {type(exc).__name__}: {exc}"[:300])
        return 1
    finally:
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
