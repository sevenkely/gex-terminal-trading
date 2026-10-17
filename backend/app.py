"""
GEX Terminal — FastAPI server.

Serves the dashboard, the GEX/levels API and a live websocket that streams
ticks + re-priced walls.

Data:
  - CBOE delayed option chains (free JSON)  -> GEX engine
  - Yahoo Finance                           -> candles + futures quotes
  - Deribit (public API, no key)            -> BTC : chaîne d'options, spot,
    candles et tape temps réel (perp + options) -> see deribit.py
  - Live feed: SIM (default) or RITHMIC     -> see live_feed.py / README

Futures (ES/NQ/GC) display the GEX of their cash underlying (SPX/NDX/GLD)
projected onto the futures scale via the live basis (additive) or ratio
(multiplicative for GC/GLD) — the standard "GEX proxy" approach.
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
import os
import time
import threading
from collections import deque
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from contextlib import asynccontextmanager

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, PlainTextResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware
from access import COOKIE, viewer_authorized, build_access_router, RequestLimits, BodyLimitMiddleware
from operations import Metrics
from security import admin_authorized, allowed_origin, validate_gateway, RithmicConfig
from research_routes import build_research_router
from market_calendar import session_info
from pricing import assumptions
from event_journal import EventRecorder
from option_ingest import LicensedOptionTape, build_ingest_router

import numpy as np
import basis as basis_mod
import cboe
import deribit
import derivs as derivs_mod
import flow as flow_mod
import gex
import history
from research import OptionTape, ResearchStore
import rithmic_gateways
from env_file import load_env
from live_feed import PriceEngine
from rithmic_bridge import RithmicBridge, PRESETS, PAPER_URL

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("gex-app")

FRONTEND = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")

# CBOE chains we fetch (NDX feeds the NQ tab but has no tab of its own)
CHAIN_SYMBOLS = ["SPX", "SPY", "QQQ", "GLD", "NDX"]
# crypto : même moteur GEX, mais chaîne/prix/tape Deribit (24/7, temps réel)
CRYPTO_SYMBOLS = ["BTC"]
# futures tab -> cash GEX source + mapping kind
FUTURES = {
    "ES": {"src": "SPX", "kind": "basis"},
    "NQ": {"src": "NDX", "kind": "basis"},
    "GC": {"src": "GLD", "kind": "ratio"},
}
# tab order
TABS = ["SPX", "ES", "SPY", "QQQ", "NQ", "GLD", "GC"] + CRYPTO_SYMBOLS
SYMBOLS = TABS

CHAIN_REFRESH = 900      # seconds (matches CBOE 15-min delay)
CHAIN_REFRESH_CRYPTO = 60  # options BTC : OI/IV bougent, l'API est gratuite
PROFILE_EVERY_N_TICKS = 5
LEVEL_KEYS = ["call_wall", "put_wall", "gamma_peak_call", "gamma_peak_put",
              "zero_gex", "em_up", "em_down", "spot",
              "gamma_flip", "max_pain", "struct_call", "struct_put"]

load_env()   # .env → os.environ avant la création du bridge (priorité sur le JSON)

STATE: dict = {"chains": {}, "fmap": {}, "tick_count": {}, "zero_cache": {},
               "alerts": {s: deque(maxlen=60) for s in SYMBOLS},
               "alert_seq": 0, "alert_sides": {}, "alert_levels": {}, "alert_cooldown": {}}
engine = PriceEngine()
bridge = RithmicBridge(engine)
crypto_flow = flow_mod.OrderFlowEngine()   # tape BTC (perp + options Deribit)
option_tape = OptionTape()
licensed_option_tape = LicensedOptionTape()
research_store = ResearchStore(os.getenv("GEX_RESEARCH_DB") or os.path.join(os.path.dirname(FRONTEND), "data", "research.sqlite3"))
crypto_feed = deribit.DeribitFeed()
metrics = Metrics()
request_limits = RequestLimits()
http_slots = threading.BoundedSemaphore(128)
event_recorder = EventRecorder(enabled=os.getenv("GEX_RECORD_EVENTS", "false").lower() in ("1","true","yes"))


def record_external_price(symbol, price, ts, mode):
    contract = bridge.status["contracts"].get(symbol, {})
    event_recorder.capture(symbol, "price", ts, {
        "price":price, "mode":mode, "contract":contract.get("contract"),
        "price_type":"direct_trade" if symbol in FUTURES and contract.get("mode")=="direct" else "index_or_proxy"})


engine.on_external = record_external_price

ALERT_LEVELS = [("zero_gex", "ZERO GEX"), ("call_wall", "CALL WALL"),
                ("put_wall", "PUT WALL")]
ALERT_COOLDOWN = 90.0   # secondes entre deux alertes sur un même niveau


# --------------------------------------------------------------- data loading
def _update_futures_map() -> None:
    for fut, cfg in FUTURES.items():
        src: gex.Chain | None = STATE["chains"].get(cfg["src"])
        if not src:
            continue
        q = None
        try:
            q = history.fetch_quote(fut)
            cash_q = history.fetch_quote(cfg["src"])
            pair = basis_mod.synchronized_projection(q, cash_q, cfg["kind"],max_age=1800)
        except Exception:
            # Recover the last coherent pair (e.g. cash close during ETH),
            # preserve its age, and disable alerts when it is stale.
            try:
                rows=asyncio.run(basis_mod.basis_series(fut,cfg['src'],cfg['kind']))
                if not rows: raise ValueError('No aligned bars')
                last=rows[-1]
                fq=dict(price=last['future_price'],ts=last['t'],instrument=history.YF_SYMBOLS[fut])
                cq=dict(price=last['cash_price'],ts=last['t'],instrument=history.YF_SYMBOLS[cfg['src']])
                pair=basis_mod.synchronized_projection(fq,cq,cfg['kind'],max_age=96*3600)
                pair['method']='aligned_5m_closes'
                q=q or dict(price=fq['price'],prev_close=fq['price'])
            except Exception:
                log.warning("Projection %s non mise à jour : aucune paire synchronisée",fut)
                continue
        STATE["fmap"][fut] = {**pair, "src":cfg["src"], "prev_close":q["prev_close"]}
        engine.rebase(fut, q["price"], src.iv30)
        log.info("projection %s (%s): %.4f skew=%.0fs", fut, pair["kind"], pair["v"], pair["skew_seconds"])



def _aggression(direction: str | None) -> int:
    """1 = achat agressif, 2 = vente agressive (convention flow.py)."""
    return 1 if direction == "buy" else 2 if direction == "sell" else 0


def load_crypto_chain(sym: str, force: bool = False) -> None:
    """Chaîne d'options BTC (Deribit) → STATE + moteur de prix."""
    raw = deribit.fetch_chain(sym, force=force)
    chain = gex.chain_from_deribit(sym, raw)
    STATE["chains"][sym] = chain
    research_store.record_oi(sym, chain)
    engine.rebase(sym, chain.spot, chain.iv30)
    # La chaîne ne constitue pas un heartbeat du flux de prix.
    # A chain refresh is not proof of a live price feed.
    # Only _crypto_price may mark this symbol DERIBIT live.
    log.info("chaîne %s (Deribit): spot=%.0f iv30=%.1f contrats=%d OI=%.0f BTC",
             sym, chain.spot, chain.iv30, len(chain.strike), chain.oi.sum())


def _crypto_price(px: float, ts: float) -> None:
    engine.set_external("BTC", px, ts, mode="DERIBIT")


def _crypto_trade(kind: str, ts: float, price: float, amount: float,
                  side: str | None, instrument: str, index_price: float,
                  trade_id=None, iv=None) -> None:
    """Tape Deribit → flow.py.

    Perp : `amount` est déjà un notionnel USD (contrat de 10 $) → la « taille »
    du print est le notionnel, le delta s'exprime en dollars agressifs.
    Options : la taille devient la prime payée (contrats × prix en BTC × index),
    le prix suivi est celui de l'index (une absorption = prime agressive qui ne
    fait pas bouger le sous-jacent).
    """
    agg = _aggression(side)
    if kind == "options":
        idx = index_price or engine.price("BTC")
        if not option_tape.add(ts, price, amount, side, instrument, idx, trade_id, iv):
            return
        event_recorder.capture("BTC", "option_trade", ts, {"instrument":instrument,
            "amount":amount,"price_btc":price,"index_price":idx,"side":side,"trade_id":trade_id,"iv":iv})
        premium = amount * price * idx
        if premium <= 0:
            return
        crypto_flow.add_trade(("DERIBIT", "BTC-OPTIONS"), "BTC-OPTIONS", ts,
                              idx, premium, agg, kind="options",
                              instrument=instrument)
    else:
        crypto_flow.add_trade(("DERIBIT", deribit.PERP), deribit.PERP, ts,
                              price, amount, agg, kind="perp",
                              instrument=instrument)


def seed_crypto_flow(count: int = 100) -> None:
    """Amorce le tape avec les derniers trades publics (panneau jamais vide)."""
    now = time.time()
    for kind, key, mode in (("future", deribit.PERP, "perp"),
                            ("option", "BTC-OPTIONS", "options")):
        try:
            trades = deribit.recent_trades(kind=kind, count=count)
        except Exception:  # noqa: BLE001
            log.exception("deribit seed %s failed", kind)
            continue
        for t in reversed(trades):
            ts = float(t.get("timestamp", now * 1000)) / 1000.0
            amount = float(t.get("amount") or t.get("contracts") or 0)
            idx = float(t.get("index_price") or 0.0)
            if mode == "options":
                _crypto_trade("options", ts, float(t.get("price") or 0), amount,
                              t.get("direction"), t.get("instrument_name") or "", idx,
                              trade_id=t.get("trade_id"), iv=t.get("iv"))
            else:
                _crypto_trade("perp", ts, float(t.get("price") or 0), amount,
                              t.get("direction"), t.get("instrument_name") or "", idx,
                              trade_id=t.get("trade_id"), iv=t.get("iv"))
        log.info("deribit seed %s: %d trades", kind, len(trades))


def load_chains(force: bool = False) -> None:
    for sym in CRYPTO_SYMBOLS:
        try:
            load_crypto_chain(sym, force=force)
        except Exception:  # noqa: BLE001
            log.exception("failed to load crypto chain %s", sym)
    for sym in CHAIN_SYMBOLS:
        try:
            raw = cboe.fetch_chain(sym, force=force)
            chain = gex.chain_from_cboe(sym, raw)
            STATE["chains"][sym] = chain
            research_store.record_oi(sym, chain)
            engine.rebase(sym, chain.spot, chain.iv30)
            log.info("chain %s: spot=%.2f iv30=%.1f contracts=%d",
                     sym, chain.spot, chain.iv30, len(chain.strike))
        except Exception:  # noqa: BLE001
            log.exception("failed to load chain %s", sym)
    _update_futures_map()


# --------------------------------------------------------------- GEX helpers
def _chain_for(sym: str) -> gex.Chain | None:
    if sym in FUTURES:
        if sym not in STATE["fmap"]:
            return None  # never draw cash strikes on a futures scale without a mapping
        return STATE["chains"].get(FUTURES[sym]["src"])
    return STATE["chains"].get(sym)


def _to_src(sym: str, px: float) -> float:
    fm = STATE["fmap"].get(sym)
    if not fm:
        return px
    return px - fm["v"] if fm["kind"] == "basis" else px / fm["v"]


def _from_src(sym: str, x: float) -> float:
    fm = STATE["fmap"].get(sym)
    if not fm:
        return x
    return x + fm["v"] if fm["kind"] == "basis" else x * fm["v"]


def _transform(res: dict, sym: str) -> dict:
    """Map a GEX result computed in cash units onto the futures scale."""
    fm = STATE["fmap"].get(sym)
    if not fm or not res:
        return res
    for k in LEVEL_KEYS:
        if res.get(k) is not None:
            res[k] = _from_src(sym, res[k])
    if fm["kind"] == "ratio" and res.get("em_sigma") is not None:
        res["em_sigma"] *= fm["v"]
    if "strikes" in res and isinstance(res["strikes"], list):
        res["strikes"] = [_from_src(sym, s) for s in res["strikes"]]
    w = res.get("walls")
    if isinstance(w, dict):
        for key in ("flip", "pain"):
            if w.get(key) is not None:
                w[key] = _from_src(sym, w[key])
        for side in ("call", "put"):
            for e in w.get(side, []):
                e["strike"] = _from_src(sym, e["strike"])
    return res


def _map_desc(sym: str) -> str | None:
    fm = STATE["fmap"].get(sym)
    if not fm:
        return None
    if fm["kind"] == "basis":
        return f"basis {sym}−{fm['src']} = {fm['v']:+.2f} pts"
    return f"ratio {sym}/{fm['src']} = ×{fm['v']:.3f}"


PROFILE_CACHE: dict = {}
PROFILE_LOCK = threading.Lock()


def level_snapshot(sym: str, filt: str, with_zero: bool,
                   win: float = 0.03) -> dict:
    """Shared per-symbol snapshot, independent of the number of subscribers.

    Full profile + zero share one valuation time. Cache expires after 5 seconds
    or immediately on a new chain; key includes the wall window.
    """
    chain = _chain_for(sym)
    if not chain:
        return {}
    key = (sym, filt, round(win, 4))
    now = time.time()
    with PROFILE_LOCK:
        cached = PROFILE_CACHE.get(key)
        expiry_crossed = cached and np.any((chain.exp_epoch > cached[1]) & (chain.exp_epoch <= now))
        if cached and cached[0] is chain and now - cached[1] < 5 and not expiry_crossed:
            return cached[2]
        spot_src = _to_src(sym, engine.price(sym))
        prof = _transform(gex.compute_profile(chain, spot_src, filt,
                          valuation_time=now, win=win), sym)
        if len(PROFILE_CACHE) >= 256:
            PROFILE_CACHE.clear()
        PROFILE_CACHE[key] = (chain, now, prof)
        return prof


def projection_status(sym: str) -> dict | None:
    mapping = STATE["fmap"].get(sym)
    if sym not in FUTURES:
        return None
    if not mapping:
        return {"valid":False, "reason":"Aucune paire de cotations synchronisées"}
    age = max(0, time.time()-mapping.get("qts", 0))
    return {**mapping, "age_seconds":age, "fresh":age <= 1800,
            "valid":True, "contract_identity_verified":False}


def chain_status(sym: str, filt: str) -> dict:
    chain = _chain_for(sym)
    if chain is None:
        return {}
    now = time.time()
    mask = gex._mask_for(chain, filt, now)
    future = chain.exp_epoch[chain.exp_epoch > now]
    tz = timezone.utc if sym in CRYPTO_SYMBOLS else gex.ET
    return {
        "available": bool(mask.any()),
        "filtered_contracts": int(mask.sum()),
        "filtered_oi": float(chain.oi[mask].sum()),
        "filter": filt,
        "timezone": "UTC" if sym in CRYPTO_SYMBOLS else "America/New_York",
        "valuation_date": datetime.fromtimestamp(now, tz).date().isoformat(),
        "next_expiry": float(future.min()) if len(future) else None,
        "chain_age_seconds": max(0, now - chain.ts_epoch),
        "chain_ts_epoch": chain.ts_epoch,
        "oi_reference": "Date OI non fournie par la source" if sym not in CRYPTO_SYMBOLS else "OI snapshot Deribit",
        "session":session_info(sym),
        "model_inputs":assumptions(chain),
        "projection":projection_status(sym),
        "methodology": "GEX estimé : calls + / puts − ; positionnement dealer non observé",
    }


# ---------------------------------------------------------------- alerts
async def alert_loop():
    """Surveille tick par tick le franchissement des niveaux clés
    (zero-GEX, call wall, put wall) et journalise des alertes."""
    while True:
        now = time.time()
        for sym in TABS:
            if _chain_for(sym) is None:
                continue
            price = engine.price(sym)
            projection = projection_status(sym)
            if engine.mode_for(sym) not in ("RITHMIC", "DERIBIT") or (projection and not projection.get("fresh")):
                for key, _ in ALERT_LEVELS:
                    STATE["alert_sides"].pop((sym, key), None)
                continue
            if not price:
                continue
            try:
                lv = await asyncio.to_thread(level_snapshot, sym, "all", False)
            except Exception:  # noqa: BLE001
                continue
            for key, label in ALERT_LEVELS:
                lvl = lv.get(key)
                if not lvl:
                    continue
                side = 1 if price > lvl else (-1 if price < lvl else 0)
                sk = (sym, key)
                prev = STATE["alert_sides"].get(sk)
                if STATE["alert_levels"].get(sk) != lvl:
                    prev = None  # changing a wall is not a price crossing
                STATE["alert_levels"][sk] = lvl
                STATE["alert_sides"][sk] = side
                if prev in (1, -1) and side in (1, -1) and side != prev \
                        and now - STATE["alert_cooldown"].get(sk, 0) >= ALERT_COOLDOWN:
                    STATE["alert_cooldown"][sk] = now
                    direction = "à la hausse" if side == 1 else "à la baisse"
                    STATE["alert_seq"] += 1
                    STATE["alerts"][sym].append({
                        "seq": STATE["alert_seq"], "ts": now, "level": key,
                        "label": label, "level_price": round(lvl, 2),
                        "price": round(price, 2), "direction": direction,
                        "text": f"{sym} franchit {label} {direction} — niveau "
                                f"{lvl:,.2f} · prix {price:,.2f}",
                    })
                    log.info("ALERTE %s", STATE["alerts"][sym][-1]["text"])
        await asyncio.sleep(1.2)


# --------------------------------------------------------------------- server
async def rollover_loop():
    while True:
        try:
            await bridge.check_rollover()
        except Exception:
            log.warning("Rollover check unavailable")
        await asyncio.sleep(900)


async def heartbeat_loop():
    previous=time.monotonic()
    while True:
        await asyncio.sleep(1)
        now=time.monotonic()
        metrics.loop_lag=max(0,now-previous-1)
        metrics.last_heartbeat=time.time()
        previous=now


async def initial_load():
    # API/static UI starts immediately; slow public providers must not block boot.
    await asyncio.to_thread(load_chains)
    await asyncio.to_thread(save_snapshots)
    STATE["next_refresh"] = time.time() + CHAIN_REFRESH
    await asyncio.to_thread(seed_crypto_flow)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if bridge.config.get("enabled") and bridge.config.get("auto_connect") and bridge.config.get("user"):
        await bridge.connect()
    crypto_feed.on_price = _crypto_price
    crypto_feed.on_trade = _crypto_trade
    tasks = [asyncio.create_task(coro) for coro in (
        initial_load(), engine.run_sim(), refresh_loop(), crypto_refresh_loop(),
        alert_loop(), research_loop(), record_loop(), heartbeat_loop(), rollover_loop(), crypto_feed.run())]
    yield
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    if bridge.client:
        await bridge.disconnect("Arrêt du serveur")
    for _ in range(10):
        if not event_recorder.status()['queued']:
            break
        try:
            await asyncio.to_thread(event_recorder.flush,research_store)
        except Exception:
            log.error("Final journal flush failed; recording is incomplete")
            break


async def refresh_loop():
    while True:
        await asyncio.sleep(CHAIN_REFRESH)
        try:
            await asyncio.to_thread(load_chains, True)
            await asyncio.to_thread(save_snapshots)
            STATE["next_refresh"] = time.time() + CHAIN_REFRESH
        except Exception:  # noqa: BLE001
            log.exception("chain refresh failed")


async def crypto_refresh_loop():
    """Options BTC : rafraîchies chaque minute (OI et IV bougent en continu)."""
    while True:
        await asyncio.sleep(CHAIN_REFRESH_CRYPTO)
        for sym in CRYPTO_SYMBOLS:
            try:
                await asyncio.to_thread(load_crypto_chain, sym, True)
            except Exception:  # noqa: BLE001
                log.exception("crypto chain refresh failed for %s", sym)


app = FastAPI(title="GEX Terminal", lifespan=lifespan)
app.add_middleware(BodyLimitMiddleware)
app.add_middleware(TrustedHostMiddleware,allowed_hosts=[h.strip() for h in os.getenv("GEX_ALLOWED_HOSTS","*").split(",") if h.strip()])
app.add_middleware(
    CORSMiddleware,
    allow_origins=[s.strip() for s in os.getenv("GEX_ALLOWED_ORIGINS", "").split(",") if s.strip()],
    allow_methods=["GET", "POST"], allow_headers=["Content-Type", "Authorization"]
)


@app.middleware("http")
async def protect_api(request, call_next):
    started=time.monotonic()
    if not request.url.path.startswith('/api/'):
        return await call_next(request)
    ip=request.client.host if request.client else 'unknown'
    path=request.url.path
    group='login' if path=='/api/session' else 'evaluation' if path.startswith('/api/backtest/') else 'ingest' if path.startswith('/api/ingest/') else 'general'
    if not request_limits.allow(ip,group):
        metrics.observe(429,time.monotonic()-started)
        return JSONResponse({'detail':'Quota dépassé, réessayer dans une minute'},status_code=429,headers={'Retry-After':'60'})
    public=request.method=='OPTIONS' or path in ('/api/access','/api/session','/api/health') or path.startswith('/api/ingest/')
    if not public and not viewer_authorized(request.headers.get('authorization',''),request.cookies.get(COOKIE)):
        metrics.observe(401,time.monotonic()-started)
        return JSONResponse({'detail':'Authentification de lecture requise'},status_code=401)
    if path.startswith('/api/rithmic') and request.method!='OPTIONS' and not admin_authorized(request.headers.get('authorization','')):
        return JSONResponse({'detail':'Administration verrouillée : GEX_ADMIN_TOKEN requis'},status_code=401)
    if (path.startswith('/api/rithmic') or request.method not in ('GET','HEAD','OPTIONS')) and request.method!='OPTIONS' and not allowed_origin(request.headers.get('origin'),request.headers.get('host',''),request.url.scheme):
        return JSONResponse({'detail':'Origine non autorisée'},status_code=403)
    try:
        too_large=int(request.headers.get('content-length','0'))>2*1024*1024
    except ValueError:
        return JSONResponse({'detail':'Invalid Content-Length'},status_code=400)
    if too_large:
        return JSONResponse({'detail':'Payload trop volumineux'},status_code=413)
    if not http_slots.acquire(blocking=False):
        return JSONResponse({'detail':'Serveur occupé'},status_code=503)
    status=500
    try:
        response=await call_next(request)
        status=response.status_code
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        return response
    finally:
        http_slots.release()
        metrics.observe(status,time.monotonic()-started)


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Pas de build/hash ici : on force la revalidation du HTML/JS/CSS par
    ETag pour ne jamais servir une version périmée depuis le cache navigateur."""
    resp = await call_next(request)
    if request.url.path == "/" or request.url.path.endswith((".js", ".css", ".html")):
        resp.headers.setdefault("Cache-Control", "no-cache")
    return resp


SPARK_CACHE: dict = {}


async def _spark(sym: str) -> list:
    if _chain_for(sym) is None:
        return []
    now = time.time()
    c = SPARK_CACHE.get(sym)
    if c and now - c[0] < 300:
        return c[1]
    try:
        bars = await asyncio.wait_for(history.fetch_history(sym, "5m"), timeout=5)
        vals = [round(b["close"], 4) for b in bars[-40:]]
    except Exception:
        vals = []
    SPARK_CACHE[sym] = (now, vals)
    return vals


@app.get('/api/diagnostics')
def diagnostics():
    operational=metrics.snapshot(research_store.path)
    recording=event_recorder.status()
    alerts=[]
    if operational['disk_free_bytes']<200*1024*1024: alerts.append('low_disk_space')
    if operational['loop_lag_seconds']>1: alerts.append('event_loop_lag')
    if recording['dropped'] or recording['failures']: alerts.append('incomplete_event_recording')
    sources={sym:chain_status(sym,'all') for sym in TABS if _chain_for(sym)}
    for sym in TABS:
        if sym not in sources: alerts.append(f'{sym}:missing_chain_or_projection')
    for sym,source in sources.items():
        if source['chain_age_seconds']>(180 if sym=='BTC' else 1800): alerts.append(f'{sym}:stale_chain')
        if engine.mode_for(sym)=='STALE': alerts.append(f'{sym}:stale_price')
        if source.get('projection') and not source['projection'].get('fresh'): alerts.append(f'{sym}:stale_projection')
    return dict(operational=operational,recording=recording,sources=sources,alerts=alerts,
                licensed_options=licensed_option_tape.status(),
                live_acceptance='not_signed_off',rollover=bridge.status.get("rollover",{"policy":"manual_reconnect","checked_at":None}))


@app.get('/api/metrics',response_class=PlainTextResponse)
def operational_metrics():
    data=metrics.snapshot(research_store.path)
    return '\n'.join([f'gex_{key} {value}' for key,value in data.items() if isinstance(value,(int,float))])+f'\ngex_recording_dropped {event_recorder.status()["dropped"]}\n'


@app.get("/api/health")
def api_health():
    return {"status":"ready" if STATE["chains"] else "waiting_for_data",
            "symbols":list(STATE["chains"]),
            "modes":{s:engine.mode_for(s) for s in TABS},
            "demo":os.getenv("GEX_DEMO_MODE", "").lower() in ("1", "true", "yes")}


@app.get("/api/symbols")
async def api_symbols():
    sparks = dict(zip(TABS, await asyncio.gather(*[_spark(t) for t in TABS],
                                                  return_exceptions=True)))
    out = []
    for sym in TABS:
        chain = _chain_for(sym)
        if not chain:
            continue
        px = engine.price(sym)
        fm = STATE["fmap"].get(sym)
        prev = fm["prev_close"] if fm else chain.prev_close
        sp = sparks.get(sym)
        out.append({
            "symbol": sym,
            "price": px,
            "prev_close": prev,
            "change_pct": (px / prev - 1) * 100 if prev else 0,
            "iv30": chain.iv30,
            "contracts": int(len(chain.strike)),
            "chain_ts": chain.ts,
            "mode": engine.mode_for(sym),
            "session":session_info(sym),
            "gex_source": fm["src"] if fm else None,
            "map_desc": _map_desc(sym),
            "spark": list(sp) if isinstance(sp, list) else [],
            "next_refresh": _next_refresh(sym),
        })
    return out


def _next_refresh(sym: str) -> float | None:
    """Prochaine mise à jour de la chaîne de cet onglet (les options BTC se
    rafraîchissent chaque minute, le CBOE toutes les 15 min)."""
    if sym in CRYPTO_SYMBOLS:
        chain = STATE["chains"].get(sym)
        return (chain.ts_epoch + CHAIN_REFRESH_CRYPTO) if chain else None
    return STATE.get("next_refresh")


@app.get("/api/gex/{symbol}")
def api_gex(symbol: str, filter: str = "all", win: float = Query(3.0, ge=0.5, le=15, allow_inf_nan=False)):
    sym = symbol.upper()
    chain = _chain_for(sym)
    if not chain:
        return {"error": "unknown symbol"}
    filt = filter if filter in gex.FILTERS else "all"
    win = min(max(win, 0.5), 15.0) / 100.0
    px = engine.price(sym)
    spot_src = _to_src(sym, px)
    prof = level_snapshot(sym, filt, True, win)
    fm = STATE["fmap"].get(sym)
    prev = fm["prev_close"] if fm else chain.prev_close
    return {
        "symbol": sym,
        "filter": filt,
        "meta": {
            **chain_status(sym, filt),
            "spot": px,
            "price_ts": engine.external_ts.get(sym),
            "delayed_spot": chain.spot if not fm else engine.base.get(sym, px),
            "cash_spot": spot_src if fm else None,
            "prev_close": prev,
            "iv30": chain.iv30,
            "chain_ts": chain.ts,
            "mode": engine.mode_for(sym),
            "contracts": int(chain.oi.sum()),
            "gex_source": fm["src"] if fm else None,
            "map_desc": _map_desc(sym),
        },
        **prof,
    }


@app.get("/api/scenario/{symbol}")
async def api_scenario(symbol: str, dspot: float = Query(0.0, ge=-0.1, le=0.1, allow_inf_nan=False),
                       div: float = Query(0.0, ge=-15, le=15, allow_inf_nan=False),
                       filter: str = "all",
                       minutes: float = Query(0, ge=0, le=1440, allow_inf_nan=False)):
    """Re-price la chaîne du jour (OI inchangé) à un spot hypothétique
    (dspot, fraction relative) et/ou une IV décalée (div, points de vol).
    Renvoie le profil GEX complet + niveaux reconstruits."""
    sym = symbol.upper()
    chain = _chain_for(sym)
    if not chain:
        return {"error": "unknown symbol"}
    dspot = min(max(dspot, -0.10), 0.10)
    div = min(max(div, -15.0), 15.0)
    filt = filter if filter in gex.FILTERS else "all"
    px = engine.price(sym)
    ch = chain
    if abs(div) > 1e-9:
        ch = dataclasses.replace(chain, iv=np.clip(chain.iv + div / 100.0, 0.02, 3.0),
                                 iv30=max(0, chain.iv30 + div))
    spot_src = _to_src(sym, px) * (1 + dspot)
    prof = await asyncio.to_thread(
        lambda: _transform(gex.compute_profile(ch, spot_src, filt,
                                               compute_zero=True,
                                               valuation_time=time.time() + minutes * 60), sym))
    return {"symbol": sym, "dspot": dspot, "div": div, "minutes":minutes, "filter": filt, **prof}


@app.get("/api/derivs/{symbol}")
def api_derivs(symbol: str):
    """Structure par terme de l'IV, skew 25Δ, OI et max pain par échéance."""
    sym = symbol.upper()
    chain = _chain_for(sym)
    if not chain:
        return {"available": False, "reason": "chaîne indisponible"}
    spot = _to_src(sym, engine.price(sym))
    out = derivs_mod.payload(chain, spot)
    out["symbol"] = sym
    return out


@app.get("/api/history/{symbol}")
async def api_history(symbol: str, interval: str = "1d"):
    try:
        bars = await history.fetch_history(symbol.upper(), interval)
    except Exception as e:  # noqa: BLE001
        log.exception("history fetch failed")
        return {"error": str(e)}
    return {"symbol": symbol.upper(), "interval": interval, "bars": bars}


@app.get("/api/alerts/{symbol}")
def api_alerts(symbol: str):
    sym = symbol.upper()
    dq = STATE["alerts"].get(sym)
    if dq is None:
        return {"alerts": []}
    return {"alerts": list(dq)[-30:], "last_seq": STATE["alert_seq"]}


@app.get("/api/basis/{symbol}")
async def api_basis(symbol: str):
    sym = symbol.upper()
    fm = STATE["fmap"].get(sym)
    if not fm:
        return {"available": False}
    try:
        series = await basis_mod.basis_series(sym, fm["src"], fm["kind"])
    except Exception as e:  # noqa: BLE001
        log.exception("basis history failed")
        return {"available": False, "error": str(e)}
    vals = [p["v"] for p in series]
    return {
        "available": True, "symbol": sym, "src": fm["src"], "kind": fm["kind"],
        "current": fm["v"], "series": series,
        "min": min(vals) if vals else None,
        "max": max(vals) if vals else None,
    }


# ---------------------------------------------------------------- snapshots
HIST_DIR = os.path.join(os.path.dirname(__file__), "..", "data")


def _hist_path(sym: str) -> str:
    d = os.path.join(HIST_DIR, "gex_hist")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{sym}.jsonl")


def save_snapshots() -> None:
    """Journalise le profil GEX agrégé à chaque refresh de chaîne (15 min) :
    alimente le mode HIST du heatmap au fil des sessions."""
    import json as _json
    for tab in TABS:
        chain = _chain_for(tab)
        if chain is None:
            continue
        try:
            prof = gex.compute_profile(chain, chain.spot, "all", compute_zero=True,
                                       valuation_time=chain.ts_epoch)
            prof = _transform(prof, tab)
            spot = _from_src(tab, chain.spot) if tab in FUTURES else chain.spot
            line = {
                "ts": round(time.time(), 1),
                "schema_version": 2,
                "chain_ts": chain.ts_epoch,
                "source": FUTURES.get(tab, {}).get("src", tab),
                "filter": "all",
                "methodology": "estimated_calls_positive_puts_negative",
                "spot": round(spot, 2),
                "strikes": [round(s, 2) for s in prof["strikes"]],
                "netM": [round(v / 1e6, 3) for v in prof["net_gex"]],  # en millions $
                "cw": prof.get("call_wall"), "pw": prof.get("put_wall"),
                "fl": prof.get("gamma_flip"),
            }
            p = _hist_path(tab)
            with open(p, "a") as f:
                f.write(_json.dumps(line) + "\n")
            # borne la taille du journal
            if os.path.getsize(p) > 8 * 1024 * 1024:
                with open(p) as f:
                    lines = f.readlines()[-3000:]
                with open(p, "w") as f:
                    f.writelines(lines)
        except Exception:  # noqa: BLE001
            log.exception("snapshot failed for %s", tab)


HM_CACHE: dict = {}


@app.get("/api/heatmap/{symbol}")
async def api_heatmap(symbol: str, mode: str = "session", interval: str = "5m",
                      rng: float = Query(0.05, alias="range", ge=0.01, le=0.15, allow_inf_nan=False), filter: str = "all"):
    import json as _json
    sym = symbol.upper()
    chain = _chain_for(sym)
    if chain is None:
        return {"error": "unknown symbol"}
    filt = filter if filter in gex.FILTERS else "all"
    rng = min(max(rng, 0.01), 0.15)
    key = (sym, mode, interval, round(rng, 3), filt)
    now = time.time()
    if key in HM_CACHE and now - HM_CACHE[key][0] < 120:
        return HM_CACHE[key][1]

    px = engine.price(sym)
    if mode == "hist":
        if filt != "all":
            return {"available": False, "reason": "Les snapshots historiques enregistrés couvrent ALL uniquement. Choisir ALL ; aucun filtre ne sera simulé."}
        p = _hist_path(sym)
        rows = []
        if os.path.exists(p):
            with open(p) as f:
                rows = [l for l in f.readlines() if l.strip()]
            rows = [_json.loads(l) for l in rows[-400:]]
        if len(rows) < 2:
            out = {"available": False,
                   "reason": "Historique insuffisant — les snapshots s'accumulent "
                             "toutes les 15 min depuis le démarrage du serveur."}
            HM_CACHE[key] = (now, out)
            return out
        if len(rows) > 180:
            step = len(rows) / 180.0
            rows = [rows[int(i * step)] for i in range(180)] + [rows[-1]]
        strikes = rows[-1]["strikes"]
        smap = [{s: v for s, v in zip(r["strikes"], r["netM"])} for r in rows]
        matrix = [[m.get(s, 0.0) for s in strikes] for m in smap]   # lignes=temps
        times = [r["ts"] for r in rows]
        spot_path = [r["spot"] for r in rows]
        cw_path = [r.get("cw") for r in rows]
        pw_path = [r.get("pw") for r in rows]
        fl_path = [r.get("fl") for r in rows]
        unit = "M"
    else:
        ivl = interval if interval in ("5m", "15m", "1h") else "5m"
        bars = await history.fetch_history(sym, ivl)
        bars = bars[-160:]
        if not bars:
            return {"available": False, "reason": "Pas de bougies disponibles"}
        # session = dernière journée de cotation (fuseau ET) ; repli sur 2 jours
        etz = ZoneInfo("America/New_York")
        def _etday(b):
            return datetime.fromtimestamp(b["time"], timezone.utc).astimezone(etz).date()
        days = sorted({_etday(b) for b in bars}, reverse=True)
        keep_days = days[:1]
        bars = [b for b in bars if _etday(b) in keep_days]
        spots_disp = [b["close"] for b in bars]
        spots_src = [_to_src(sym, s) for s in spots_disp]
        times = [b["time"] for b in bars]
        strikes_src, mat = await asyncio.to_thread(
            gex.gex_matrix, chain, spots_src, filt)
        strikes = [_from_src(sym, s) for s in strikes_src.tolist()]
        matrix = [(mat[:, j] / 1e6).round(3).tolist() for j in range(mat.shape[1])]
        spot_path = spots_disp
        unit = "M"

    lo, hi = px * (1 - rng), px * (1 + rng)
    keep = [i for i, s in enumerate(strikes) if lo <= s <= hi]
    if len(keep) < 8:
        keep = list(range(len(strikes)))
    out = {
        "available": bool(len(strikes)), "mode": mode, "unit": unit,
        "reason": None if len(strikes) else "Aucun strike disponible pour ce filtre.",
        "provenance": "recorded_snapshots" if mode == "hist" else "reconstructed_current_chain",
        "limitation": "OI, IV et temps du snapshot constants ; pas un historique observé" if mode != "hist" else "Snapshots ALL enregistrés à partir de chaînes différées",
        "times": times,
        "strikes": [strikes[i] for i in keep],
        "matrix": [[row[i] for i in keep] for row in matrix],  # lignes = temps
        "spot_path": spot_path,
    }
    if mode == "hist":
        out["cw"] = cw_path
        out["pw"] = pw_path
        out["fl"] = fl_path
    if len(HM_CACHE) > 128:
        HM_CACHE.clear()
    HM_CACHE[key] = (now, out)
    return out


@app.get("/api/flow/{symbol}")
def api_flow(symbol: str, src: str = "perp"):
    """Gros trades / absorption / delta agressif.

    - actions/futures : tape Rithmic du contrat sous-jacent (indisponible en SIM) ;
    - BTC : tape Deribit, `src=perp` (notionnel USD) ou `src=options` (prime USD).
    """
    sym = symbol.upper()
    if sym not in SYMBOLS:
        return {"available": False, "reason": "symbole inconnu"}
    if sym in CRYPTO_SYMBOLS:
        kind = "options" if src == "options" else "perp"
        contract = "BTC-OPTIONS" if kind == "options" else deribit.PERP
        snap = crypto_flow.get(("DERIBIT", contract))
        out = dict(snap) if snap else {}
        out.update(available=bool(snap and snap.get("trades")),
                   contract=contract, exchange="DERIBIT", src=kind,
                   sources=["perp", "options"],
                   live=crypto_feed.status["state"] == "connected",
                   feed={k: crypto_feed.status[k] for k in
                         ("state", "error", "last_msg", "counts", "reconnects")})
        if not out["available"]:
            out["reason"] = ("Aucun print encore reçu de Deribit sur cet "
                             "instrument (le tape se remplit en continu).")
        return out
    data = bridge.get_flow(sym)
    if not data:
        return {"available": False, "sources": ["perp"],
                "reason": "Flux d'ordres : nécessite un compte Rithmic connecté "
                          "(les ticks SIM n'ont ni tape ni carnet)."}
    data["available"] = True
    data["live"] = engine.mode_for(sym) == "RITHMIC"
    return data


@app.get("/api/flow/{symbol}/bars")
def api_flow_bars(symbol: str, interval: str = "5m", limit: int = 240,
                  src: str = "perp"):
    """Delta agressif et CVD par bougie (bande basse du graphique).

    Même source que `/api/flow/{sym}` : tape Deribit pour BTC (`src=perp` ou
    `options`), tape Rithmic pour les futures. Ne remonte que ce qui a été vu
    depuis le démarrage du serveur — pas de backfill historique.
    """
    sym = symbol.upper()
    if sym not in SYMBOLS:
        return {"available": False, "reason": "symbole inconnu"}
    limit = max(20, min(int(limit), 420))
    if sym in CRYPTO_SYMBOLS:
        contract = "BTC-OPTIONS" if src == "options" else deribit.PERP
        bars = crypto_flow.bars(("DERIBIT", contract), interval, limit)
        unit = "USD"
    else:
        bars = bridge.get_flow_bars(sym, interval, limit)
        snap = bridge.get_flow(sym) or {}
        unit = snap.get("unit", "contrats")
    return {
        "available": bool(bars),
        "symbol": sym, "interval": interval, "unit": unit,
        "bars": bars,
        "reason": None if bars else
                  ("Le tape se remplit depuis le démarrage du serveur : "
                   "aucune bougie pour l'instant."),
    }


async def record_loop():
    while True:
        try:
            await asyncio.to_thread(event_recorder.flush, research_store)
        except Exception:
            log.exception("Event recording failed; coverage is incomplete")
        await asyncio.sleep(1)


async def research_loop():
    """Sample known levels every 30s, preserving availability times and source age."""
    while True:
        try:
            rows = []
            for sym in TABS:
                chain = _chain_for(sym)
                if chain is None or engine.mode_for(sym) == "SIM":
                    continue
                for filt in ("all", "0dte", "weekly", "monthly"):
                    prof = await asyncio.to_thread(level_snapshot, sym, filt, True)
                    levels = {k:prof.get(k) for k in ("spot", "call_wall", "put_wall", "zero_gex", "gamma_flip", "max_pain", "net_gex_total", "regime", "walls", "available")}
                    rows.append({"symbol":sym, "filter":filt, "recorded_at":time.time(),
                        "chain_ts":chain.ts_epoch, "valuation_time":prof.get("valuation_time"),
                        "price":engine.price(sym), "price_ts":engine.external_ts.get(sym),
                        "price_mode":engine.mode_for(sym), "levels":levels,
                        "gex_source":FUTURES.get(sym, {}).get("src", sym),
                        "contract":bridge.status["contracts"].get(sym, {}).get("contract"),
                        "projection":projection_status(sym),"model_inputs":assumptions(chain)})
            await asyncio.to_thread(research_store.save_snapshots, rows)
        except Exception:
            log.exception("Research journal sample failed")
        await asyncio.sleep(30)


@app.get("/api/crypto")
def api_crypto():
    """État du flux Deribit (diagnostic : état, compteurs, erreur)."""
    return {"symbols": CRYPTO_SYMBOLS, "feed": crypto_feed.status,
            "price": crypto_feed.price,
            "chain_ts": {s: (STATE["chains"].get(s).ts if STATE["chains"].get(s) else None)
                         for s in CRYPTO_SYMBOLS}}


@app.get("/api/depth/{symbol}")
def api_depth(symbol: str):
    sym = symbol.upper()
    book = bridge.get_book(sym)
    if not book:
        return {"available": False,
                "reason": "Carnet L2 disponible avec un compte Rithmic connecté"}
    book["available"] = True
    book["last_price"] = engine.price(sym)
    return book


@app.websocket("/ws/{symbol}")
async def ws_live(ws: WebSocket, symbol: str, filter: str = "all",
                  win: float = Query(3.0, ge=0.5, le=15, allow_inf_nan=False)):
    sym = symbol.upper()
    if sym not in SYMBOLS:
        await ws.close(code=4004)
        return
    origin = ws.headers.get("origin")
    scheme = "https" if ws.url.scheme == "wss" else "http"
    if not allowed_origin(origin, ws.headers.get("host", ""), scheme):
        await ws.close(code=1008)
        return
    if not viewer_authorized(ws.headers.get("authorization",""),ws.cookies.get(COOKIE)):
        await ws.close(code=4401)
        return
    ip=ws.client.host if ws.client else "unknown"
    if not request_limits.open_ws(ip):
        await ws.close(code=1013)
        return
    filt = filter if filter in gex.FILTERS else "all"
    win = min(max(win, 0.5), 15.0) / 100.0
    last_alert_seq = STATE["alert_seq"]
    last_valuation = None
    try:
        await ws.accept()
        snap = await asyncio.to_thread(level_snapshot, sym, filt, True, win)
        await ws.send_json({
            "type": "init",
            "data_status": chain_status(sym, filt),
            "price": engine.price(sym),
            "mode": engine.mode_for(sym),
            "levels": {k: v for k, v in snap.items() if not isinstance(v, list)},
        })
        while True:
            if not viewer_authorized(ws.headers.get("authorization",""),ws.cookies.get(COOKIE)):
                await ws.close(code=4401)
                return
            price = await engine.wait_tick(sym)
            STATE["tick_count"][sym] = STATE["tick_count"].get(sym, 0) + 1
            send_profile = (STATE["tick_count"][sym] % PROFILE_EVERY_N_TICKS == 0)
            chain = _chain_for(sym)
            fm = STATE["fmap"].get(sym)
            prev = fm["prev_close"] if fm else chain.prev_close if chain else None
            snap = await asyncio.to_thread(level_snapshot, sym, filt, send_profile, win)
            send_profile = snap.get("valuation_time") != last_valuation
            last_valuation = snap.get("valuation_time")
            msg = {
                "type": "tick",
                "data_status": chain_status(sym, filt),
                "ts": time.time(),
                "price": price,
                "mode": engine.mode_for(sym),
                "change_pct": (price / prev - 1) * 100 if prev else 0,
                "levels": {k: v for k, v in snap.items() if not isinstance(v, list)},
            }
            if send_profile:
                msg["profile"] = {k: v for k, v in snap.items() if isinstance(v, list)}
            dq = STATE["alerts"].get(sym)
            if dq:
                new = [a for a in dq if a["seq"] > last_alert_seq]
                if new:
                    msg["alerts"] = new
                    last_alert_seq = new[-1]["seq"]
            await ws.send_json(msg)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.exception("ws error for %s", sym)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass

    finally:
        request_limits.close_ws(ip)


@app.get("/api/rithmic")
def api_rithmic_get():
    st = bridge.status
    return {
        "config": bridge.public(),
        "presets": PRESETS,
        "status": {
            "state": st["state"],
            "message": st["message"],
            "since": st["since"],
            "contracts": st["contracts"],
            "rollover":st.get("rollover"),
            "modes": {s: engine.mode_for(s) for s in TABS},
        },
    }


@app.post("/api/rithmic/config")
async def api_rithmic_config(body: RithmicConfig):
    try:
        bridge.update_config(body.model_dump(exclude_none=True))
    except (ValueError, TypeError) as exc:
        return JSONResponse({"detail": str(exc)}, status_code=422)
    if bridge.status["state"] == "connected":
        await bridge.disconnect("Configuration modifiée")
    if bridge.config.get("enabled") and bridge.config.get("auto_connect"):
        await bridge.connect()
        await asyncio.sleep(0.2)   # let it flip to "connecting"
    return {"ok": True, "config": bridge.public(), "status": bridge.status}


@app.post("/api/rithmic/connect")
async def api_rithmic_connect():
    bridge.config["enabled"] = True
    bridge._save()
    await bridge.connect()
    return {"ok": True, "status": bridge.status}


@app.get("/api/rithmic/discover")
async def api_rithmic_discover(url: str = "", system: str = ""):
    """Découverte R|Protocol (templates 16 et 20) : systèmes servis par un
    gateway et liste des gateways régionaux — sans identifiants."""
    try:
        uri = validate_gateway(url or bridge.config.get("url") or PAPER_URL)
    except ValueError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=422)
    sysname = (system or bridge.config.get("system_name") or "").strip() or None
    try:
        return await asyncio.wait_for(
            rithmic_gateways.discover(uri, sysname), timeout=30)
    except asyncio.TimeoutError:
        return {"url": uri, "error": "timeout (30 s)"}
    except Exception as exc:  # noqa: BLE001
        log.exception("rithmic discover failed")
        return {"url": uri, "error": f"{type(exc).__name__}: {exc}"}


@app.post("/api/rithmic/disconnect")
async def api_rithmic_disconnect():
    await bridge.disconnect("Déconnecté manuellement")
    return {"ok": True, "status": bridge.status}


app.include_router(build_research_router(option_tape, research_store, crypto_feed,
                                         FUTURES, _chain_for, _to_src, engine, event_recorder, licensed_option_tape))
app.include_router(build_ingest_router(licensed_option_tape,event_recorder))
app.include_router(build_access_router())

app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
