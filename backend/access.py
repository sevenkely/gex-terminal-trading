"""Optional read-access gate, short-lived HttpOnly sessions and bounded quotas.

Not an SSO/multi-tenant identity system. Production host/TLS policy belongs at
both TrustedHostMiddleware and the trusted reverse proxy.
"""
from collections import defaultdict, deque
import hashlib
import hmac
import os
import secrets
import threading
import time
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from security import admin_authorized, allowed_origin

COOKIE='gex_read_session'


def check_bearer(header, secret):
    return bool(secret and hmac.compare_digest(header.encode(),('Bearer '+secret).encode()))


def new_session(now=None):
    expires=int(time.time() if now is None else now)+3600
    payload=f'{expires}.{secrets.token_hex(16)}'
    signature=hmac.new(os.getenv('GEX_VIEWER_TOKEN','').encode(),payload.encode(),hashlib.sha256).hexdigest()
    return f'{payload}.{signature}'


def valid_session(cookie,now=None):
    secret=os.getenv('GEX_VIEWER_TOKEN','')
    if not secret or not cookie or len(cookie)>200:
        return False
    try:
        expires,nonce,signature=cookie.split('.')
        current=time.time() if now is None else now
        if not current<int(expires)<=current+3600 or len(nonce)!=32:
            return False
        expected=hmac.new(secret.encode(),f'{expires}.{nonce}'.encode(),hashlib.sha256).hexdigest()
        return hmac.compare_digest(signature,expected)
    except (ValueError,TypeError):
        return False


def viewer_authorized(header='',cookie=None):
    secret=os.getenv('GEX_VIEWER_TOKEN','')
    return not secret or check_bearer(header,secret) or admin_authorized(header) or valid_session(cookie)


class RequestLimits:
    def __init__(self,max_clients=1024):
        self.buckets={}
        self.lock=threading.Lock()
        self.max_clients=max_clients
        self.active_ws=defaultdict(int)
        self.total_ws=0

    def allow(self,ip,group='general',now=None):
        now=time.monotonic() if now is None else now
        limit={'login':10,'evaluation':6,'ingest':120,'general':240}[group]
        key=(ip,group)
        with self.lock:
            q=self.buckets.get(key)
            if q is None:
                if len(self.buckets)>=self.max_clients:
                    stale=[k for k,v in self.buckets.items() if not v or now-v[-1]>=60]
                    for k in stale: del self.buckets[k]
                    if len(self.buckets)>=self.max_clients:
                        return False
                q=self.buckets[key]=deque()
            while q and now-q[0]>=60: q.popleft()
            if len(q)>=limit: return False
            q.append(now)
            return True

    def open_ws(self,ip):
        with self.lock:
            if self.total_ws>=64 or self.active_ws.get(ip,0)>=8: return False
            self.active_ws[ip]+=1;self.total_ws+=1
            return True

    def close_ws(self,ip):
        with self.lock:
            if self.active_ws.get(ip,0):
                self.total_ws-=1;self.active_ws[ip]-=1
                if not self.active_ws[ip]: del self.active_ws[ip]


class Login(BaseModel):
    model_config=ConfigDict(extra='forbid')
    token: str=Field(min_length=1,max_length=1024)


def build_access_router():
    router=APIRouter()

    @router.get('/api/access')
    def access_state(request:Request):
        return dict(required=bool(os.getenv('GEX_VIEWER_TOKEN')),
                    authorized=viewer_authorized(request.headers.get('authorization',''),request.cookies.get(COOKIE)))

    @router.post('/api/session')
    def login(body:Login,request:Request):
        if not check_bearer('Bearer '+body.token,os.getenv('GEX_VIEWER_TOKEN','')):
            raise HTTPException(401,'Jeton de lecture invalide')
        response=JSONResponse({'ok':True})
        response.set_cookie(COOKIE,new_session(),max_age=3600,httponly=True,
                            secure=request.url.scheme=='https',samesite='strict',path='/')
        response.headers['Cache-Control']='no-store'
        return response

    @router.delete('/api/session')
    def logout():
        response=JSONResponse({'ok':True});response.delete_cookie(COOKIE,path='/')
        return response
    return router


class BodyLimitMiddleware:
    """Enforce actual streamed bytes too, not only untrusted Content-Length."""
    def __init__(self,app,limit=2*1024*1024):
        self.app=app;self.limit=limit

    async def __call__(self,scope,receive,send):
        if scope['type']!='http':
            await self.app(scope,receive,send);return
        used=0
        async def limited_receive():
            nonlocal used
            message=await receive()
            if message['type']=='http.request':
                used+=len(message.get('body',b''))
                if used>self.limit:
                    from starlette.exceptions import HTTPException
                    raise HTTPException(413,'Payload exceeds 2MiB streamed-body limit')
            return message
        await self.app(scope,limited_receive,send)
