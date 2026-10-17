"""Chargeur .env minimal (sans dépendance) pour les identifiants Rithmic.

Priorité des sources, du plus fort au plus faible :
  1. variables d'environnement déjà définies (shell, service, CI) ;
  2. fichier `.env` à la racine du projet (`gex-dashboard/.env`) ;
  3. `data/rithmic_config.json` (config remplie depuis l'interface).

Le fichier .env n'est jamais lu par le frontend et doit rester hors du dépôt
(voir .gitignore) : `RITHMIC_USER`, `RITHMIC_PASS`, `RITHMIC_SYSTEM`,
`RITHMIC_URL` (+ `RITHMIC_APP_NAME`, `RITHMIC_AUTO_CONNECT` en option).
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger("gex.env")

DEFAULT_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")


def load_env(path: str = DEFAULT_PATH) -> int:
    """Injecte les paires KEY=VALUE du fichier dans os.environ (sans écraser).

    Retourne le nombre de variables posées. Les lignes vides, les commentaires
    (#) et les guillemets autour des valeurs sont gérés.
    """
    if not os.path.exists(path):
        return 0
    count = 0
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if key.startswith("export "):
                    key = key[len("export "):].strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
                    count += 1
    except OSError:
        log.exception("lecture de %s impossible", path)
        return count
    if count:
        log.info("%d variable(s) chargée(s) depuis %s", count, os.path.basename(path))
    return count
