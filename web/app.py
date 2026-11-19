"""One User, One Agent: web app.

    uvicorn web.app:app --reload                     # local, http://127.0.0.1:8000
    LIVE_ACCESS_CODE=... uvicorn web.app:app         # enables the live lab

Public, read-only:  the precomputed replay in sample_run/ (overview, viewers, decisions, impact, latency).
Behind a code:      /api/live/*  runs the real agent (src.replay_harness.ReplayHarness.decide) on demand.

Environment
  LIVE_ACCESS_CODE   code for the live lab; if unset the lab is disabled (results stay browsable)
  OUA_PACK           path to one_user_one_agent_pack (default: auto-detected next to / inside the project)
  OUA_RUN            replay output directory to serve (default: sample_run)
  OUA_LIVE           set to 0 to skip loading the live agent (saves ~340 MB; results stay browsable)
"""
import gc
import hmac
import json
import os
import time
from collections import defaultdict, deque

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from src.build_site import build_data

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
RUN_DIR = os.environ.get('OUA_RUN') or os.path.join(ROOT, 'sample_run')


def _find_pack():
    for c in [os.environ.get('OUA_PACK'), os.path.join(ROOT, 'one_user_one_agent_pack'),
              os.path.join(ROOT, '..', 'one_user_one_agent_pack')]:
        if c and os.path.isfile(os.path.join(c, 'replay', 'triggers.jsonl')):
            return os.path.abspath(c)
    return None


def _bytes(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'), default=str).encode('utf-8')


class Store:
    """Everything the read API serves, serialised once at startup and kept as bytes (small and immutable)."""

    def __init__(self):
        t0 = time.time()
        self.pack_dir = _find_pack()
        self.live = None
        self.live_error = None
        if os.environ.get('OUA_LIVE', '1') == '0':
            self.live_error = 'live lab switched off (OUA_LIVE=0)'
        elif self.pack_dir:                         # load the live agent first: its freed history is reused below
            try:
                from web.live import LiveAgent
                self.live = LiveAgent(self.pack_dir)
            except Exception as ex:                 # the read-only site must still come up
                self.live_error = '%s: %s' % (type(ex).__name__, ex)
        else:
            self.live_error = 'data pack not deployed'
        data = build_data(RUN_DIR, self.live.pack.catalogue if self.live else None)
        viewers, titles = data.pop('viewers'), data.pop('titles')
        data['stories'] = data.get('stories', [])
        self.overview = _bytes(data)
        self.summary = data['summary']
        self.viewer_bytes, self.index, self.decision_owner = {}, [], {}
        for uid in sorted(viewers):
            v = viewers[uid]
            used = {c.split(':', 1)[1] for d in v['decisions'] for c in d['content']}
            v['titles'] = {t: titles[t] for t in used if t in titles}
            self.viewer_bytes[uid] = _bytes(dict(v, viewer_id=uid))
            for d in v['decisions']:
                self.decision_owner[d['decision_id']] = uid
            prim = next((o for o in v['outcomes'] if o['primary']), None)
            self.index.append({
                'viewer_id': uid, 'arm': v['arm'], 'decisions': len(v['decisions']),
                'published': sum(d['status'] == 'PUBLISHED' for d in v['decisions']),
                'actions': sorted({a['type'] for a in v['actions']}),
                'goal': prim['goal_id'] if prim else None, 'outcome': prim['status'] if prim else None,
                'reasons': sorted({d['no_action_reason'] for d in v['decisions'] if d['no_action_reason']}),
                'conflict': any((d['dialect'] or {}).get('conflicts') for d in v['decisions']),
                'learned': len(v.get('learnings') or []),
                'profile': bool(v.get('profile')),
            })
        del viewers, titles, data
        gc.collect()
        self.boot_s = round(time.time() - t0, 2)


S = Store()
CODE = os.environ.get('LIVE_ACCESS_CODE', '')

app = FastAPI(title='One User, One Agent', version='1.0',
              description='Read API over a replay of the agent, plus a gated live lab that runs the real agent.',
              docs_url='/api/docs', redoc_url=None, openapi_url='/api/openapi.json')
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware('http')
async def headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers['X-Content-Type-Options'] = 'nosniff'
    resp.headers['Referrer-Policy'] = 'no-referrer'
    resp.headers['X-Frame-Options'] = 'DENY'
    resp.headers['X-Robots-Tag'] = 'noindex, nofollow'       # synthetic but personal-shaped data: keep it unindexed
    if not request.url.path.startswith('/api/docs'):
        resp.headers['Content-Security-Policy'] = ("default-src 'self'; script-src 'self'; style-src 'self' "
                                                   "'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
                                                   "frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    return resp


def raw(b, cache=True):
    return Response(b, media_type='application/json',
                    headers={'Cache-Control': 'public, max-age=300'} if cache else {'Cache-Control': 'no-store'})


# ---- public read API -------------------------------------------------------------------------------------------
@app.get('/api/health')
def health():
    return {'ok': True, 'viewers': len(S.index), 'decisions': S.summary['decisions'], 'boot_s': S.boot_s,
            'live': {'enabled': bool(S.live and CODE),
                     'reason': None if (S.live and CODE) else (S.live_error or 'LIVE_ACCESS_CODE not set')}}


@app.get('/api/overview')
def overview():
    return raw(S.overview)


@app.get('/api/viewers')
def viewers(q: str = '', arm: str = '', status: str = '', reason: str = '', goal: str = '', outcome: str = '',
            conflict: bool = False, learned: bool = False,
            offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200)):
    q = q.strip().upper()
    rows = [r for r in S.index
            if (not q or q in r['viewer_id'])
            and (not arm or r['arm'] == arm)
            and (not status or (status == 'published') == (r['published'] > 0))
            and (not reason or reason in r['reasons'])
            and (not goal or r['goal'] == goal)
            and (not outcome or r['outcome'] == outcome)
            and (not conflict or r['conflict'])
            and (not learned or r['learned'])]
    return {'total': len(rows), 'offset': offset, 'rows': rows[offset:offset + limit]}


@app.get('/api/viewers/{uid}')
def viewer(uid: str):
    b = S.viewer_bytes.get(uid.upper())
    if b is None:
        raise HTTPException(404, 'no decisions for %s in this run' % uid)
    return raw(b)


@app.get('/api/decisions/{decision_id}')
def decision(decision_id: str):
    uid = S.decision_owner.get(decision_id.upper())
    if not uid:
        raise HTTPException(404, 'unknown decision')
    v = json.loads(S.viewer_bytes[uid])
    return next(d for d in v['decisions'] if d['decision_id'] == decision_id.upper())


# ---- live lab (gated) ------------------------------------------------------------------------------------------
_hits = defaultdict(deque)


def _rate(request, bucket, n, per_s=60):
    # Render's proxy appends the real client address last; the left-most entries are client-controlled.
    ip = (request.headers.get('x-forwarded-for') or (request.client.host if request.client else '?')).split(',')[-1].strip()
    dq, now = _hits[(bucket, ip)], time.time()
    while dq and now - dq[0] > per_s:
        dq.popleft()
    if len(dq) >= n:
        raise HTTPException(429, 'slow down: %d per %ds' % (n, per_s))
    dq.append(now)


def _gate(request: Request):
    if not S.live:
        raise HTTPException(503, 'live lab unavailable: %s' % S.live_error)
    if not CODE:
        raise HTTPException(503, 'live lab disabled: LIVE_ACCESS_CODE is not set on the server')
    given = request.headers.get('x-access-code', '')
    if not hmac.compare_digest(given.encode(), CODE.encode()):
        _rate(request, 'auth-fail', 10)
        raise HTTPException(401, 'access code required')


@app.post('/api/live/unlock')
def unlock(request: Request):
    _gate(request)
    from web.live import SCENARIOS
    return {'ok': True, 'day': S.live.day.date().isoformat(),
            'scenarios': [{'id': k, 'title': v[0], 'explain': v[1]} for k, v in SCENARIOS.items()],
            'suggestions': S.live.suggestions(), 'dialects': sorted(S.live.pack.valid_dialects)}


@app.get('/api/live/viewer/{uid}')
def live_viewer(uid: str, request: Request):
    _gate(request)
    uid = uid.upper()
    if not S.live.known(uid):
        raise HTTPException(404, 'unknown viewer')
    return S.live.viewer_card(uid)


@app.get('/api/live/suggest/{scenario}')
def live_suggest(scenario: str, request: Request, at: str = '19:30'):
    _gate(request)
    _rate(request, 'suggest', 20)
    return {'scenario': scenario, 'viewer_id': S.live.suggest_for(scenario, at)}


class RunBody(BaseModel):
    viewer_id: str = Field('', max_length=16)
    scenario: str = Field('normal', max_length=32)
    at: str = Field('19:30', pattern=r'^([01]\d|2[0-3]):[0-5]\d$', description='IST time on the replay day')
    dialect: str = Field('', max_length=8)
    offline_hours: float = Field(6, ge=0.25, le=96)
    burst_size: int = Field(300, ge=10, le=600)


@app.post('/api/live/run')
def live_run(body: RunBody, request: Request):
    _gate(request)
    _rate(request, 'run', 30)
    try:
        res = S.live.run(body.viewer_id.upper(), body.scenario, body.at, body.dialect or None,
                         body.offline_hours, body.burst_size)
    except KeyError:
        raise HTTPException(404, 'unknown viewer %s' % body.viewer_id)
    except ValueError as ex:
        raise HTTPException(400, str(ex))
    return JSONResponse(res, headers={'Cache-Control': 'no-store'})


# ---- front end -------------------------------------------------------------------------------------------------
app.mount('/static', StaticFiles(directory=STATIC), name='static')


@app.get('/', include_in_schema=False)
def index():
    return FileResponse(os.path.join(STATIC, 'index.html'), headers={'Cache-Control': 'no-cache'})
