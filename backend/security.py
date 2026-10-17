"""Admin boundary for Rithmic and strict outbound gateway validation."""
from __future__ import annotations

import hmac
import os
from urllib.parse import urlsplit
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal


def admin_authorized(header: str) -> bool:
    token = os.getenv("GEX_ADMIN_TOKEN", "")
    return bool(token and hmac.compare_digest(header.encode(), ("Bearer " + token).encode()))


def allowed_origin(origin: str | None, host: str, scheme: str = "https") -> bool:
    if not origin:
        return True  # non-browser clients; admin authentication still required
    configured = {s.strip() for s in os.getenv("GEX_ALLOWED_ORIGINS", "").split(",") if s.strip()}
    return origin == f"{scheme}://{host}" or origin in configured


def validate_gateway(value: str) -> str:
    """Only explicitly trusted Rithmic hosts, TLS and port 443; no userinfo/path."""
    parsed = urlsplit(value if "://" in value else "wss://" + value)
    hosts = {"rituz00100.rithmic.com", "rprotocol-ie.rithmic.com",
             "rprotocol-de.rithmic.com", "rprotocol-sg.rithmic.com"}
    hosts.update(s.strip().lower() for s in os.getenv("GEX_RITHMIC_HOSTS", "").split(",") if s.strip())
    if (parsed.scheme != "wss" or parsed.hostname not in hosts
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Gateway non autorisé : utiliser un preset Rithmic TLS (port 443).")
    return f"wss://{parsed.hostname}:443"


class ContractMapping(BaseModel):
    model_config = ConfigDict(extra="forbid")
    exchange: str | None = Field(None, max_length=32)
    contract: str | None = Field(None, max_length=64)
    mode: Literal["direct", "anchor"] | None = None


class RithmicConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=512)
    user: str | None = None
    password: str | None = None
    system_name: str | None = None
    url: str | None = None
    app_name: str | None = None
    app_version: str | None = None
    enabled: bool | None = None
    auto_connect: bool | None = None
    mappings: dict[str, ContractMapping] | None = Field(None, max_length=16)
