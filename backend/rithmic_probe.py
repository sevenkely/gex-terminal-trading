"""Diagnostic de connexion Rithmic : essaie plusieurs system_name et rapporte
celui qui authentifie (sans rien écrire sur le disque).

Usage :
    RITHMIC_USER=xxx RITHMIC_PASS=yyy python rithmic_probe.py [gateway_url] [system_name ...]

Exemple (gateway R|Protocol Chicago, systèmes réels servis par ce host) :
    python rithmic_probe.py rprotocol-mobile.rithmic.com:443 "Rithmic Paper Trading" "Rithmic 01"

Le mot de passe n'est jamais journalisé par ce script.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys

from async_rithmic import RithmicClient

# La lib journalise la trame de login (mot de passe en clair) et un traceback
# complet à chaque échec : on garde la sortie du script seule.
logging.getLogger("rithmic").setLevel(logging.CRITICAL)

CANDIDATES = [
    "Rithmic Paper Trading Chicago",
    "Rithmic Paper Trading",
    "Rithmic Paper Trading (Chicago)",
    "Rithmic Test",
]
DEFAULT_URL = "rituz00100.rithmic.com:443"


async def try_login(user: str, password: str, system: str, url: str,
                    timeout: float = 25.0) -> tuple[bool, str]:
    client = RithmicClient(user=user, password=password, system_name=system,
                           app_name="GexProbe", app_version="1.0", url=url)
    try:
        await asyncio.wait_for(client.connect(), timeout=timeout)
        return True, "authentifié"
    except asyncio.TimeoutError:
        return False, f"timeout ({timeout:.0f} s)"
    except Exception as e:  # noqa: BLE001
        return False, (str(e) or e.__class__.__name__)[:160]
    finally:
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass


async def main() -> int:
    user = os.environ.get("RITHMIC_USER", "")
    password = os.environ.get("RITHMIC_PASS", "")
    if not user or not password:
        print("RITHMIC_USER et RITHMIC_PASS sont requis (variables d'environnement).")
        return 2
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    candidates = sys.argv[2:] or CANDIDATES
    print(f"probe {url} — user {user[:3]}***")
    for system in candidates:
        ok, msg = await try_login(user, password, system, url)
        print(f"{'OK  ' if ok else 'FAIL'} {system!r} -> {msg}")
        if ok:
            print(f"\n=== system_name à utiliser : {system!r} ===")
            return 0
    print("\nAucun system_name parmi les candidats n'a authentifié.")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
