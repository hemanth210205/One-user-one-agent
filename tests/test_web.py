"""Web app: public read API, the gated live lab, and the safety properties of the front end.

Needs the web extras:  python -m pip install -r requirements-dev.txt
"""
import os
import re

import pytest

pytest.importorskip('fastapi')
pytest.importorskip('httpx')

os.environ['LIVE_ACCESS_CODE'] = 'test-code'
from fastapi.testclient import TestClient  # noqa: E402

from web.app import S, app  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C = TestClient(app)
OK = {'X-Access-Code': 'test-code'}
needs_live = pytest.mark.skipif(S.live is None, reason='data pack not available')


def test_health_and_overview():
    h = C.get('/api/health').json()
    assert h['ok'] and h['decisions'] == S.summary['decisions']
    ov = C.get('/api/overview').json()
    assert ov['summary']['triggers'] > 0 and ov['stories'] and 'viewers' not in ov


def test_viewer_index_filters_detail_and_decision_lookup():
    res = C.get('/api/viewers', params={'arm': 'holdout', 'status': 'published'}).json()
    assert res['total'] == 0                              # holdout viewers never get an action
    one = C.get('/api/viewers', params={'outcome': 'succeeded', 'arm': 'agent', 'limit': 1}).json()['rows'][0]
    v = C.get('/api/viewers/' + one['viewer_id']).json()
    assert v['viewer_id'] == one['viewer_id'] and any(o['status'] == 'succeeded' for o in v['outcomes'])
    did = v['decisions'][0]['decision_id']
    assert C.get('/api/decisions/' + did).json()['decision_id'] == did
    assert C.get('/api/viewers/U-NOPE').status_code == 404


def test_security_headers_on_every_response():
    for path in ('/', '/api/overview', '/static/app.js'):
        r = C.get(path)
        assert r.headers['x-content-type-options'] == 'nosniff'
        assert r.headers['x-frame-options'] == 'DENY'
        assert 'noindex' in r.headers['x-robots-tag']
        assert "script-src 'self'" in r.headers['content-security-policy']


def test_front_end_is_self_contained_and_never_parses_html():
    static = os.path.join(ROOT, 'web', 'static')
    for name in os.listdir(static):
        text = open(os.path.join(static, name), encoding='utf-8').read()
        assert not re.search(r'(src|href)=["\']https?://', text), name      # no third-party resources
        assert 'innerHTML' not in text and 'insertAdjacentHTML' not in text, name
    assert '<script>' not in open(os.path.join(static, 'index.html'), encoding='utf-8').read()  # CSP: no inline JS


@needs_live
def test_live_lab_is_gated():
    assert C.post('/api/live/unlock').status_code == 401
    assert C.post('/api/live/unlock', headers={'X-Access-Code': 'wrong'}).status_code == 401
    assert C.post('/api/live/run', json={'viewer_id': 'U-00004'}).status_code == 401
    r = C.post('/api/live/unlock', headers=OK).json()
    assert r['ok'] and len(r['scenarios']) >= 10 and r['suggestions']


@needs_live
def test_live_run_validates_input():
    assert C.post('/api/live/run', headers=OK, json={'viewer_id': 'U-00004', 'at': '25:00'}).status_code == 422
    assert C.post('/api/live/run', headers=OK, json={'viewer_id': 'U-00004', 'scenario': 'rm -rf'}).status_code == 400
    assert C.post('/api/live/run', headers=OK, json={'viewer_id': 'U-99999'}).status_code == 404


@needs_live
def test_live_scenarios_run_the_real_agent():
    uid = S.live.suggestions()[0]

    def run(scenario, **kw):
        r = C.post('/api/live/run', headers=OK, json=dict(viewer_id=uid, scenario=scenario, at='19:30', **kw))
        assert r.status_code == 200, r.text
        return r.json()
    dup = run('duplicate')['steps']
    assert dup[1]['decision']['no_action_reason'] == 'duplicate_event_id' and not dup[1]['actions']
    stale = run('offline', offline_hours=8)['steps'][0]['decision']
    assert stale['no_action_reason'] == 'stale_offline_buffered_trigger'
    claim = run('model_claim')['steps'][0]['decision']
    assert claim['model_status'] == 'unsupported_claim' and claim['fallback_used']
    burst = run('burst', burst_size=50)['burst']
    assert burst['n'] == 50 and burst['over_60s'] == 0


@needs_live
def test_live_runs_are_isolated_from_each_other_and_from_the_replay():
    uid = S.live.suggestions()[0]
    body = {'viewer_id': uid, 'scenario': 'normal', 'at': '19:30'}
    a = C.post('/api/live/run', headers=OK, json=body).json()['steps'][0]['decision']
    b = C.post('/api/live/run', headers=OK, json=body).json()['steps'][0]['decision']
    assert a['status'] == b['status'] == 'PUBLISHED'       # a second run is not seen as a duplicate or a live page
    assert a['decision_id'] == b['decision_id'] == 'D-0001'
    assert C.get('/api/health').json()['decisions'] == S.summary['decisions']


@needs_live
def test_suggestions_make_the_scenario_effect_visible():
    for scenario in ('purchase_after', 'store_slow', 'learned_failure'):
        uid = C.get('/api/live/suggest/' + scenario, headers=OK).json()['viewer_id']
        r = S.live.run(uid, scenario)
        assert S.live.EFFECT[scenario](r), scenario
