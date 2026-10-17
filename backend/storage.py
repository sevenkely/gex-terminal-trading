"""Atomic, unique temporary files: concurrent cache refreshes cannot collide."""
import json
import os
import tempfile
from pathlib import Path


def write_json(path, payload, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name+'.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            os.fchmod(file.fileno(), mode)
            json.dump(payload, file, allow_nan=False)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
