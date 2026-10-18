#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache/ui
python_bin="${GEX_TEST_PYTHON:-python}"
if [[ -z "${GEX_TEST_PYTHON:-}" && -x .venv/bin/python ]]; then python_bin=.venv/bin/python; fi
# Fail rather than accidentally reuse a real data server.
"$python_bin" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",8010)); s.close()'
GEX_RESEARCH_DB="$PWD/.cache/ui/fixture.sqlite3" PYTHONPATH=backend:tests \
  "$python_bin" -m uvicorn ui_fixture:app --host 0.0.0.0 --port 8010 >.cache/ui/fixture.log 2>&1 &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true' EXIT
node tests/react_browser.cjs
node tests/react_tools_browser.cjs

node tests/design_browser.cjs
