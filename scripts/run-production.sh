#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Requires Python 3.11+ and Node supported by terminal-react/package.json.
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
npm ci --prefix terminal-react
npm run build --prefix terminal-react
export GEX_DEMO_MODE=false
export PYTHONPATH=backend
exec .venv/bin/python -m uvicorn app:app --host 0.0.0.0 --port "${PORT:-8000}"
