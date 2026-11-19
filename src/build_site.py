"""Builds a self-contained, offline walkthrough site from a replay's output directory.

    python -m src.build_site                    # reads sample_run/, writes sample_run/site/index.html
    python -m src.build_site --run other_run    # any run directory

Every number on the site is read from the run's files (decisions, actions, outcomes, revisions, viewer_state,
impact_summary, latency_report, data_audit); nothing is typed in. The page loads no network resources, so the
pack's personal data never leaves the machine (brief section 7). Catalogue text is embedded as data and rendered
with textContent only, so the injected catalogue descriptions cannot execute in the page either.
"""
import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, 'site_template.html')
IST = timezone(timedelta(hours=5, minutes=30))
BIN_MIN = 10


def _ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def _jsonl(path):
    if not os.path.isfile(path):
        return []
    with open(path, encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def _json(path, default=None):
    if not os.path.isfile(path):
        return default
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def _first(items, pred):
    return next((x for x in items if pred(x)), None)


# ---- stories: one real viewer per brief surprise / behaviour, found in the data ------------------------------------
def find_stories(decisions, outcomes, revisions, states):
    D = [d for d in decisions if d['arm'] == 'agent']
    out = []

    def add(key, title, blurb, d=None, uid=None):
        if d is None and uid is None:
            return
        out.append({'key': key, 'title': title, 'blurb': blurb, 'viewer': uid or d['viewer_id'],
                    'decision': d['decision_id'] if d else None})

    add('dialects', 'Three dialects disagree',
        'App setting, profile and campaign link each name a different dialect. The app setting wins and the '
        'conflicts are kept on the decision.',
        _first(D, lambda d: d['status'] == 'PUBLISHED' and len((d['dialect'] or {}).get('conflicts', [])) >= 2))
    rev = _first(revisions, lambda r: r['kind'] in ('goal_closed', 'goal_obsolete') and 'purchase' in r['detail'])
    if rev:
        add('purchase', 'A purchase lands after the decision',
            'The snapshot said "never paid". A live purchase closes the conversion goal and cancels any queued '
            'message.', uid=rev['user_id'])
    add('withdrawn', 'Title withdrawn mid-day',
        'A licence ends early. Live pages that show the title are rebuilt without it, and messages naming it '
        'are cancelled.',
        _first(decisions, lambda d: d['trigger']['event'].startswith('control:title_withdrawn')))
    add('unsupported', 'The model claims something it cannot know',
        'The model asserts eligibility from a source that does not exist. Its output is rejected and the '
        'rule-based choice stands.',
        _first(decisions, lambda d: d['model_status'] == 'unsupported_claim'))
    add('outage', 'Model provider outage',
        'Every model call returns HTTP 503 for seven minutes. Decisions fall back to the deterministic rules, '
        'still on time.',
        _first(D, lambda d: d['model_status'] in ('unavailable', 'circuit_open') and d['status'] == 'PUBLISHED'))
    add('store', 'Data store degraded',
        'A state read times out after 800 ms. Cached state is used, and push / WhatsApp fail closed because '
        'consent cannot be verified.',
        _first(D, lambda d: any('user_data_store read timed out' in n for n in d['notes'])))
    add('stale', 'An app open that is days old',
        'Buffered offline on the phone, delivered late. Acting on it now would be acting on a visit that is '
        'long over, so the agent abstains.',
        _first(D, lambda d: d['no_action_reason'] == 'stale_offline_buffered_trigger'
               and (d['trigger'].get('event_age_s') or 0) > 86400))
    add('duplicate', 'The same trigger, twice',
        'A duplicated delivery gets its own decision line, and no second action.',
        _first(D, lambda d: d['no_action_reason'] == 'duplicate_event_id'))
    add('already_live', 'Doing nothing, on purpose',
        'A personalised page is still live in this dialect. Republishing would add nothing, so the agent '
        'records why it did nothing.',
        _first(D, lambda d: d['no_action_reason'] == 'personalised_page_already_live'))
    win = _first(outcomes, lambda o: o['arm'] == 'agent' and o['status'] == 'succeeded' and o['primary']
                 and any(a['type'] == 'push' for a in states.get(o['user_id'], {}).get('published_actions', [])))
    if win:
        add('succeeded', 'From app open to a judged success',
            'Goal chosen, page and reminder published, and the success signal observed in the window by the '
            'outcome judge.', uid=win['user_id'])
    hold = _first(outcomes, lambda o: o['arm'] == 'holdout' and o['primary'])
    if hold:
        add('holdout', 'A holdout viewer',
            'Same planner, same moment, a shadow goal and no action. This is what makes the comparison fair.',
            uid=hold['user_id'])
    lu = _first(sorted(states), lambda u: any(x.get('kind') == 'channel_unreachable'
                                              for x in states[u].get('learnings', [])))
    if lu:
        add('learning', 'What the agent learned',
            'The push token turned out to be invalid. Next time, push is not planned and the message falls '
            'through to the next channel.', uid=lu)
    return out


# ---- the day: trigger volume per 10-minute bin, plus the surprise windows -----------------------------------------
def day_timeline(decisions, revisions, latency):
    trig = [d for d in decisions if not d['trigger']['event'].startswith('control:')]
    if not trig:
        return {'bins': [], 'events': []}
    t0 = min(_ts(d['trigger']['deliver_at']) for d in trig).astimezone(IST)
    day0 = t0.replace(hour=0, minute=0, second=0, microsecond=0)
    n = 24 * 60 // BIN_MIN
    bins = [{'fresh': 0, 'stale': 0, 'published': 0} for _ in range(n)]
    for d in trig:
        m = (_ts(d['trigger']['deliver_at']).astimezone(IST) - day0).total_seconds() / 60
        i = int(m // BIN_MIN)
        if 0 <= i < n:
            stale = d['no_action_reason'] == 'stale_offline_buffered_trigger'
            bins[i]['stale' if stale else 'fresh'] += 1
            bins[i]['published'] += d['status'] == 'PUBLISHED'

    def minute(s):
        return (_ts(s).astimezone(IST) - day0).total_seconds() / 60

    labels = {'title_withdrawn': 'Title withdrawn', 'goal_rule_corrected': 'Goal rule corrected',
              'dependency_unavailable': 'Model outage', 'dependency_degraded': 'Data store degraded'}
    events = []
    for r in revisions:
        if r['user_id'] != '*' or r['kind'] not in labels:
            continue
        ev = {'kind': r['kind'], 'label': labels[r['kind']], 'start': minute(r['at']), 'detail': r['detail'],
              'at': r['at']}
        m = re.search(r'until (\S+?Z)', r['detail'])
        if m:
            ev['end'] = minute(m.group(1))
        events.append(ev)
    names = {'traffic_peak_live': 'Evening peak', 'offline_backlog_burst': 'Offline backlog'}
    for k, b in (latency or {}).get('bursts', {}).items():
        events.append({'kind': k, 'label': names.get(k, k), 'start': minute(b['start']),
                       'end': minute(b['start']) + b['minutes'], 'at': b['start'],
                       'detail': '%d triggers in %d min = %.1fx the median live rate' % (
                           b['triggers'], b['minutes'], b['x_median'])})
    events.sort(key=lambda e: e['start'])
    return {'day': day0.date().isoformat(), 'bin_min': BIN_MIN, 'bins': bins, 'events': events}


def latency_hist(decisions):
    edges = [0, 50, 100, 200, 300, 400, 500, 1000, 2000]
    counts = [0] * len(edges)
    for d in decisions:
        v = d['decided_in_ms']
        i = max(j for j, e in enumerate(edges) if v >= e)
        counts[i] += 1
    return [{'lo': edges[i], 'hi': edges[i + 1] if i + 1 < len(edges) else None, 'n': c} for i, c in enumerate(counts)]


def build_data(run_dir, catalogue=None):
    decisions = _jsonl(os.path.join(run_dir, 'decisions.jsonl'))
    if not decisions:
        sys.exit('no decisions.jsonl in %s: run python -m src.run_replay first' % run_dir)
    actions = _jsonl(os.path.join(run_dir, 'actions.jsonl'))
    outcomes = _jsonl(os.path.join(run_dir, 'outcomes.jsonl'))
    revisions = _jsonl(os.path.join(run_dir, 'revisions.jsonl'))
    impact = _json(os.path.join(run_dir, 'impact_summary.json'), {})
    latency = _json(os.path.join(run_dir, 'latency_report.json'), {})
    audit = _json(os.path.join(run_dir, 'data_audit.json'), {})
    sim = _json(os.path.join(run_dir, 'sim', 'simulator_report.json'), {})

    sdir = os.path.join(run_dir, 'viewer_state')
    states = {}
    if os.path.isdir(sdir):
        for name in sorted(os.listdir(sdir)):
            if name.endswith('.json'):
                st = _json(os.path.join(sdir, name))
                states[st['user_id']] = st

    by_v = defaultdict(lambda: {'decisions': [], 'actions': [], 'outcomes': []})
    for d in decisions:
        by_v[d['viewer_id']]['decisions'].append(d)
    for a in actions:
        by_v[a['user_id']]['actions'].append(a)
    for o in outcomes:
        by_v[o['user_id']]['outcomes'].append(o)
    viewers = {}
    for uid, v in by_v.items():
        st = states.get(uid, {})
        viewers[uid] = dict(v, arm=st.get('arm') or v['decisions'][0]['arm'], profile=st.get('profile'),
                            profile_source=st.get('profile_source'), facts=st.get('facts', {}),
                            learnings=st.get('learnings', []), revisions=st.get('revisions', []),
                            cancelled=st.get('cancelled_actions', []), event_summary=st.get('event_summary'),
                            goal_history=[{k: g.get(k) for k in ('goal_id', 'id', 'start', 'deadline',
                                                                 'success_signal', 'status', 'rule_version',
                                                                 'revisions', 'shadow', 'target')}
                                          for g in st.get('goal_history', [])])

    titles = {}
    if catalogue:
        used = set()
        for d in decisions:
            used.update(c.split(':', 1)[1] for c in d['content'])
        for tid in sorted(used):
            t = catalogue.get(tid)
            if t:
                titles[tid] = {'title': t.get('title'), 'dialect': t.get('dialect'), 'genres': t.get('genres'),
                               'language': t.get('language')}

    trig = [d for d in decisions if not d['trigger']['event'].startswith('control:')]
    failed_checks = Counter(f.split(':')[0] for d in decisions for f in d['checks']['failed'])
    passed_checks = Counter(c for d in decisions for c in d['checks']['passed'])
    learn = Counter(x.get('kind', 'unstructured') for st in states.values() for x in st.get('learnings', []))
    summary = {
        'triggers': len(trig), 'decisions': len(decisions), 'replans': len(decisions) - len(trig),
        'published': sum(d['status'] == 'PUBLISHED' for d in decisions),
        'abstained': sum(d['status'] == 'ABSTAINED' for d in decisions),
        'actions': dict(Counter(a['type'] for a in actions)),
        'viewers': len(viewers), 'outcomes': dict(Counter(o['status'] for o in outcomes)),
        'judged_goals': len(outcomes),
        'goals_committed': sum(1 for d in decisions if d['goal'] and d['goal']['committed'] == 'new'),
        'model_status': dict(Counter(d['model_status'] for d in decisions)),
        'fallbacks': sum(bool(d['fallback_used']) for d in decisions),
        'policy_problems': sim.get('policy_problem_count'),
        'holdout_actions': sum(1 for a in actions if viewers.get(a['user_id'], {}).get('arm') == 'holdout'),
        'learnings': dict(learn),
        'conflicts_logged': sum(1 for d in decisions if (d['dialect'] or {}).get('conflicts')),
        'max_model_calls': max(d['model_calls'] for d in decisions),
        'max_tool_calls': max(d['tool_calls'] for d in decisions),
    }
    return {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'run_dir': os.path.basename(os.path.abspath(run_dir)),
        'summary': summary,
        'abstain': Counter(d['no_action_reason'] for d in decisions if d['no_action_reason']).most_common(),
        'checks': {'failed': failed_checks.most_common(), 'passed': passed_checks.most_common()},
        'timeline': day_timeline(decisions, revisions, latency),
        'latency': latency, 'latency_hist': latency_hist(decisions),
        'impact': impact,
        'audit': {'events': audit.get('events'), 'profiles': audit.get('profiles'),
                  'goals_excluded': audit.get('goals_excluded_unmeasurable'),
                  'rule_corrections': audit.get('rule_corrections'),
                  'replay_counters': audit.get('replay_counters'),
                  'catalogue': {k: v for k, v in (audit.get('catalogue') or {}).items() if k != 'injections'},
                  'injections': (audit.get('catalogue') or {}).get('injections', [])},
        'sim_counts': sim.get('counts', {}),
        'stories': find_stories(decisions, outcomes, revisions, states),
        'viewers': viewers, 'titles': titles,
    }


def build_site(run_dir, pack=None, out_path=None):
    catalogue = getattr(pack, 'catalogue', None) if pack is not None else None
    if catalogue is None:
        try:
            from .data_loader import Pack
            from .run_replay import find_pack
            catalogue = Pack(find_pack()).catalogue
        except (SystemExit, Exception):            # the site still builds without titles' names
            catalogue = None
    data = build_data(run_dir, catalogue)
    blob = json.dumps(data, ensure_ascii=False, separators=(',', ':'), default=str).replace('</', '<\\/')
    with open(TEMPLATE, encoding='utf-8') as f:
        html = f.read()
    assert html.count('__DATA__') == 1, 'template must contain exactly one __DATA__ placeholder'
    html = html.replace('__DATA__', blob)
    out_path = out_path or os.path.join(run_dir, 'site', 'index.html')
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)
    return out_path


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--run', default=os.path.join(os.path.dirname(HERE), 'sample_run'), help='replay output directory')
    ap.add_argument('--out', help='output html path (default <run>/site/index.html)')
    a = ap.parse_args(argv)
    path = build_site(a.run, out_path=a.out)
    print('wrote %s (%.1f MB) - open it in a browser; it works offline' % (path, os.path.getsize(path) / 1e6))


if __name__ == '__main__':
    main()
