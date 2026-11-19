"""The live lab: runs the real agent (ReplayHarness.decide) on demand for one viewer and one scenario.

Isolation. Every request gets its own harness, state store, verifier and model provider, so runs never see each
other and never touch the precomputed sample run. The loaded pack is shared read-only.

Memory. The pack's 140k history events are the bulk of its footprint (~340 MB as dicts). They are kept here as one
compressed pickle per viewer and decoded only for the viewers a run involves; a run gets a shallow copy of the pack
whose `history` holds just those viewers. Nothing else in the agent reads `pack.history` (only StateStore does).
"""
import copy
import gc
import pickle
import time
import uuid
import zlib
from collections import defaultdict
from datetime import timedelta

from src.data_loader import Pack
from src.fact_resolver import IST, iso, parse_ts
from src.learning import record
from src.replay_harness import ReplayHarness

SCENARIOS = {
    'normal': ('A normal app open', 'One fresh app open. The agent assembles facts, commits to a goal and decides.'),
    'offline': ('Buffered offline, delivered late', 'The app open happened hours ago and was buffered on the phone. '
                'The visit is over; acting on it now would be acting on a stale session.'),
    'duplicate': ('The same trigger, delivered twice', 'Identical event id twice. The second delivery must produce '
                  'a decision line and no second action.'),
    'dialects': ('Three dialects disagree', 'App setting, profile and campaign link each name a different dialect. '
                 'The agent must use the dialect the viewer will actually see, and keep the conflicts visible.'),
    'model_claim': ('Model claims what it cannot know', 'The model says the viewer is on a trial "confirmed in '
                    'billing". There is no billing source. The output is rejected and the rule choice stands.'),
    'model_malformed': ('Model returns broken JSON', 'Malformed output is never parsed into a decision.'),
    'model_down': ('Model provider is down', 'Every model call returns HTTP 503. The agent falls back to its '
                   'deterministic rules and still decides on time.'),
    'store_slow': ('Data store unavailable', 'The state read times out at 800 ms. Cached state is used and '
                   'consent-gated channels (push, WhatsApp) fail closed.'),
    'purchase_after': ('A purchase lands 2 minutes later', 'The agent decides, then a purchase event arrives. '
                       'State updates on arrival: conversion goals close and queued messages are cancelled.'),
    'rule_corrected': ('Goal rule corrected first', 'The G03 success rule is corrected before this app open. '
                       'New and open goals use the new rule version.'),
    'learned_failure': ('The agent remembers a failure', 'Runs twice: once fresh, then with a learning that this '
                        'viewer failed that goal 2 days ago. The failed goal is tried after the alternatives.'),
    'burst': ('Traffic burst', 'Hundreds of different viewers open the app in the same minute. Decisions queue on '
              'a fixed worker pool; latency is measured against the 60 s budget.'),
}


class LiveAgent:
    def __init__(self, pack_dir):
        t0 = time.time()
        pack = Pack(pack_dir)
        self._blobs = {uid: zlib.compress(pickle.dumps(evs, protocol=pickle.HIGHEST_PROTOCOL), 6)
                       for uid, evs in pack.history.items()}
        pack.history = defaultdict(list)
        gc.collect()
        self.pack = pack
        self.day = min(parse_ts(t['deliver_at']) for t in pack.triggers).astimezone(IST).replace(
            hour=0, minute=0, second=0, microsecond=0)
        rule_fix = [c for c in pack.control_events if c['type'] == 'goal_rule_corrected']
        self.rule_correction = rule_fix[0] if rule_fix else None
        self._live_by_user = defaultdict(list)
        for e in pack.live_events:
            self._live_by_user[e['user_id']].append(e)
        self._suggest_cache = {}
        self.load_s = round(time.time() - t0, 2)

    def live_by_user_for(self, uids):
        return [e for u in uids for e in self._live_by_user.get(u, [])]

    # ---- helpers -------------------------------------------------------------------------------------------------
    def history(self, uid):
        b = self._blobs.get(uid)
        return pickle.loads(zlib.decompress(b)) if b else []

    def known(self, uid):
        return uid in self.pack.profiles or uid in self._blobs or uid in self._live_by_user

    def viewer_card(self, uid):
        p = self.pack.profiles.get(uid) or {}
        evs = self.history(uid)
        last = next((e for e in reversed(evs) if e.get('app_dialect')), None)
        return {'viewer_id': uid, 'arm': self.pack.arms.get(uid), 'has_profile': bool(p),
                'subscription_status': p.get('subscription_status'), 'preferred_dialect': p.get('preferred_dialect'),
                'last_app_dialect': last.get('app_dialect') if last else None,
                'push_opt_in': p.get('notifications_opt_in'), 'whatsapp_opt_in': p.get('whatsapp_opt_in'),
                'events_in_history': len(evs), 'signup_at': p.get('signup_at')}

    def suggestions(self, n=24):
        """Agent-arm viewers with a profile and some history: good subjects for the lab."""
        out = []
        for uid in sorted(self.pack.profiles):
            if self.pack.arms.get(uid) == 'agent' and uid in self._blobs and \
                    self.pack.profiles[uid].get('preferred_dialect') in self.pack.valid_dialects:
                out.append(uid)
        step = max(1, len(out) // n)
        return out[::step][:n]

    # A suggestion must make the scenario's effect visible, so candidates are tried for real (each run is ~3 ms).
    EFFECT = {
        'normal': lambda r: r['steps'][0]['decision']['status'] == 'PUBLISHED',
        'offline': lambda r: True,
        'duplicate': lambda r: r['steps'][0]['decision']['status'] == 'PUBLISHED',
        'dialects': lambda r: r['steps'][0]['decision']['status'] == 'PUBLISHED'
        and len(r['steps'][0]['decision']['dialect']['conflicts']) >= 2,
        'model_claim': lambda r: r['steps'][0]['decision']['model_status'] == 'unsupported_claim',
        'model_malformed': lambda r: r['steps'][0]['decision']['model_status'] == 'malformed_output',
        'model_down': lambda r: r['steps'][0]['decision']['model_status'] in ('unavailable', 'circuit_open'),
        'store_slow': lambda r: 'message: consent_not_verifiable_store_degraded' in r['steps'][0]['decision']['notes'],
        'purchase_after': lambda r: bool(r['steps'][1]['revisions']),
        'rule_corrected': lambda r: r['steps'][0]['decision']['status'] == 'PUBLISHED',
        'learned_failure': lambda r: len(r['steps']) == 2 and r['steps'][0]['decision'].get('goal')
        and r['steps'][1]['decision'].get('goal')
        and r['steps'][0]['decision']['goal']['goal_id'] != r['steps'][1]['decision']['goal']['goal_id'],
    }

    def suggest_for(self, scenario, hhmm='19:30', tries=400):
        key = (scenario, hhmm)
        if key in self._suggest_cache:
            return self._suggest_cache[key]
        if scenario == 'burst':
            return None
        P = self.pack.profiles
        cands = [u for u in sorted(P) if self.pack.arms.get(u) == 'agent' and u in self._blobs
                 and P[u].get('preferred_dialect') in self.pack.valid_dialects]
        if scenario == 'rule_corrected':          # fresh signups exist only in the live feed (no profile row yet)
            cands = sorted({e['user_id'] for e in self.pack.live_events if e['event'] == 'signup_completed'
                            and self.pack.arms.get(e['user_id']) == 'agent'}) + cands
        elif scenario == 'purchase_after':
            cands = [u for u in cands if P[u].get('subscription_status') == 'never'] + cands
        test = self.EFFECT.get(scenario, lambda r: True)
        pick = None
        for u in cands[:tries]:
            try:
                if test(self.run(u, scenario, hhmm)):
                    pick = u
                    break
            except Exception:                     # a candidate that cannot run is simply skipped
                continue
        self._suggest_cache[key] = pick or (self.suggestions(1) or [None])[0]
        return self._suggest_cache[key]

    def _harness(self, uids, at=None):
        """A fresh, isolated agent. Each viewer's history is the pack history plus every live-feed event received
        before `at` (what the real replay would know by then)."""
        p = copy.copy(self.pack)
        hist = {u: self.history(u) for u in uids}
        if at is not None:
            for e in self.live_by_user_for(uids):
                if parse_ts(e['received_at']) < at:
                    hist[e['user_id']].append(e)
        p.history = defaultdict(list, hist)
        h = ReplayHarness(p)
        return h

    def _default_dialect(self, uid):
        c = self.viewer_card(uid)
        return c['last_app_dialect'] or c['preferred_dialect'] or sorted(self.pack.valid_dialects)[0]

    def _trigger(self, uid, at, dialect, eid=None, age_s=0, props=None, event='app_open'):
        sent = at
        occ = sent - timedelta(seconds=age_s)
        return {'event_id': eid or 'live-%s' % uuid.uuid4().hex[:12], 'user_id': uid, 'event': event,
                'occurred_at': iso(occ), 'sent_at': iso(sent), 'received_at': iso(at), 'deliver_at': iso(at),
                'session_id': 'live-%s' % uuid.uuid4().hex[:8], 'app_dialect': dialect, 'app_language': 'hin',
                'platform': 'android', 'app_version': '6.1.4', 'properties': props or {}}

    @staticmethod
    def _start(h, at):
        h.workers = [at] * h.n_workers

    @staticmethod
    def _control(dep, at, kind='dependency_unavailable'):
        return {'type': kind, 'dependency': dep, 'at': iso(at - timedelta(minutes=1)),
                'until': iso(at + timedelta(minutes=10)), 'detail': 'live lab: %s %s' % (dep, kind)}

    def _step(self, h, label, d, uid, n_actions_before, n_rev_before):
        st = h.store.get(uid)
        acts = h.actions[n_actions_before:] + [a for a in h.pending.values() if a['decision_id'] == d['decision_id']]
        return {'label': label, 'decision': d, 'actions': acts, 'revisions': h.revisions[n_rev_before:],
                'facts': st['facts'], 'learnings': st['learnings'], 'active_goal': st['active_goal']}

    # ---- scenarios -----------------------------------------------------------------------------------------------
    def run(self, uid, scenario, hhmm='19:30', dialect=None, offline_hours=6, burst_size=300):
        if scenario not in SCENARIOS:
            raise ValueError('unknown scenario %s' % scenario)
        if scenario != 'burst' and not self.known(uid):
            raise KeyError(uid)
        hh, mm = (int(x) for x in hhmm.split(':'))
        at = self.day + timedelta(hours=hh, minutes=mm)
        t0 = time.perf_counter()
        if scenario == 'burst':
            res = self._burst(at, max(10, min(int(burst_size), 600)))
        else:
            res = self._single(uid, scenario, at, dialect or self._default_dialect(uid), offline_hours)
        res.update(scenario=scenario, title=SCENARIOS[scenario][0], explain=SCENARIOS[scenario][1],
                   at=iso(at), server_ms=round((time.perf_counter() - t0) * 1000, 1))
        used = set()
        for st in res.get('steps', []):
            d = st.get('decision') or {}
            used.update(c.split(':', 1)[1] for c in d.get('content', []))
        cat = self.pack.catalogue
        res['titles'] = {t: {k: cat[t].get(k) for k in ('title', 'dialect', 'language', 'genres')} for t in used if t in cat}
        return res

    def _single(self, uid, scenario, at, dialect, offline_hours):
        h = self._harness([uid], at)
        self._start(h, at)
        steps, notes, rule_change = [], [], None
        props, age = {}, 0
        if scenario == 'offline':
            age = int(max(0.25, min(float(offline_hours), 96)) * 3600)
        if scenario == 'dialects':
            dl = sorted(self.pack.valid_dialects)
            prof = (self.pack.profiles.get(uid) or {}).get('preferred_dialect')
            others = [x for x in dl if x not in (prof, dialect)]
            if dialect == prof and others:
                dialect = others.pop(0)
            camp = others[0] if others else dl[0]
            tid = next((t for t, c in sorted(self.pack.catalogue.items()) if c['dialect'] == camp), 'T0001')
            props['deeplink'] = 'ott://c/cmp-live/%s/title/%s' % (camp, tid)
            notes.append('app setting %s, profile %s, campaign link %s' % (dialect, prof, camp))
        trig = self._trigger(uid, at, dialect, age_s=age, props=props)
        if scenario in ('model_claim', 'model_malformed'):
            src = next(f for f in self.pack.model_faults.values()
                       if f['fault'] == ('unsupported_claim' if scenario == 'model_claim' else 'malformed_output'))
            h.provider.faults = dict(h.provider.faults, **{trig['event_id']: dict(src, trigger_event_id=trig['event_id'])})
            notes.append('model fault injected on this trigger: %s' % src['fault'])
        if scenario == 'model_down':
            h.on_control(self._control('model_provider', at), at)
        if scenario == 'store_slow':
            h.on_control(self._control('user_data_store', at), at)
        if scenario == 'rule_corrected' and self.rule_correction:
            c = dict(self.rule_correction, at=iso(at - timedelta(minutes=5)))
            h.on_control(c, at - timedelta(minutes=5))
            notes.append('%s rule corrected before the app open; rule version now %s' % (c['goal_id'], h.planner.rule_version))
            rule_change = {'goal_id': c['goal_id'], 'from': c.get('old_success'), 'to': c['new_success'],
                           'rule_version': h.planner.rule_version, 'note': c.get('note')}

        if scenario == 'learned_failure':
            base = self._harness([uid], at)
            self._start(base, at)
            d0 = base.decide(dict(trig))
            steps.append(self._step(base, 'Without memory', d0, uid, 0, 0))
            if d0.get('goal'):
                gid = d0['goal']['goal_id']
                record(h.store.get(uid), at - timedelta(days=2), 'goal_failed',
                       'goal %s failed (seeded for the live lab)' % gid, goal_id=gid, evidence=['live-lab'])
                notes.append('seeded learning: %s failed for this viewer 2 days ago' % gid)
            else:
                notes.append('no goal was chosen without memory, so there is nothing to remember')
            d = h.decide(dict(trig))
            steps.append(self._step(h, 'With the learning', d, uid, 0, 0))
            return {'steps': steps, 'notes': notes, 'viewer': self.viewer_card(uid)}

        n_a, n_r = len(h.actions), len(h.revisions)
        d = h.decide(trig)
        steps.append(self._step(h, 'App open', d, uid, n_a, n_r))
        if scenario == 'duplicate':
            n_a, n_r = len(h.actions), len(h.revisions)
            d2 = h.decide(dict(trig, deliver_at=iso(at + timedelta(seconds=3)), received_at=iso(at + timedelta(seconds=3))))
            steps.append(self._step(h, 'Same event id, 3 s later', d2, uid, n_a, n_r))
        if scenario == 'purchase_after':
            t2 = at + timedelta(minutes=2)
            buy = self._trigger(uid, t2, dialect, event='purchase_completed')
            buy['properties'] = {'plan_id': 'P_MONTH', 'price_inr': 149, 'is_trial': False}
            n_a, n_r = len(h.actions), len(h.revisions)
            h.on_live(buy, t2)
            st = h.store.get(uid)
            steps.append({'label': 'Purchase arrives (+2 min)', 'event': buy, 'revisions': h.revisions[n_r:],
                          'actions': [], 'facts': st['facts'], 'learnings': st['learnings'],
                          'active_goal': st['active_goal']})
            t3 = at + timedelta(minutes=6)
            self._start(h, t3)
            n_a, n_r = len(h.actions), len(h.revisions)
            d3 = h.decide(self._trigger(uid, t3, dialect))
            steps.append(self._step(h, 'Next app open (+6 min)', d3, uid, n_a, n_r))
        if rule_change:
            gid = (d.get('goal') or {}).get('goal_id')
            rule_change['affects_this_viewer'] = gid == rule_change['goal_id']
            notes.append("this viewer's goal is %s: %s" % (gid, 'it is judged by the corrected rule'
                         if rule_change['affects_this_viewer'] else 'nothing to re-point; only G03 goals change, '
                         'no other viewer or goal is reprocessed'))
        return {'steps': steps, 'notes': notes, 'viewer': self.viewer_card(uid), 'rule_change': rule_change}

    def _burst(self, at, n):
        pool = [u for u in sorted(self.pack.profiles) if u in self._blobs][:max(n, 1) * 2]
        uids = pool[::2][:n] if len(pool) >= 2 * n else pool[:n]
        h = self._harness(uids, at)
        self._start(h, at)
        ds = []
        for i, uid in enumerate(uids):
            t = at + timedelta(milliseconds=int(60000 * i / max(1, len(uids))))
            ds.append(h.decide(self._trigger(uid, t, self._default_dialect(uid))))
        lat = sorted(d['decided_in_ms'] for d in ds)

        def q(p):
            return lat[min(len(lat) - 1, int(p * len(lat)))] if lat else None
        reasons = defaultdict(int)
        for d in ds:
            reasons[d['no_action_reason'] or d['action']] += 1
        return {'burst': {'n': len(ds), 'window_s': 60, 'workers': h.n_workers, 'p50_ms': q(.5), 'p95_ms': q(.95),
                          'max_ms': lat[-1] if lat else None, 'over_60s': sum(x > 60000 for x in lat),
                          'outcomes': dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
                          'queue_ms_max': max((d['latency_breakdown_ms']['queue'] for d in ds), default=0),
                          'series': [{'i': i, 'ms': d['decided_in_ms'], 'queue': d['latency_breakdown_ms']['queue'],
                                      'status': d['status']} for i, d in enumerate(ds)]},
                'steps': [{'label': 'Sample decision from the burst', 'decision': ds[len(ds) // 2], 'actions': [],
                           'revisions': [], 'facts': {}, 'learnings': [], 'active_goal': None}] if ds else [],
                'notes': ['%d distinct viewers, app opens spread over 60 s, %d workers' % (len(ds), h.n_workers)],
                'viewer': None}
