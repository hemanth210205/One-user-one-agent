"""Per-viewer learnings: how judged outcomes feed back into the next decision for the same viewer.

A learning is a structured record in the viewer's state:

    {'at': <when it became knowable>, 'kind': ..., 'goal_id' | 'channel': ..., 'evidence': [...], 'learning': <text>}

kinds
  goal_succeeded / goal_failed / goal_inconclusive   written by the outcome judge (at = success event time / deadline)
  goal_achieved_live / goal_obsolete_live            written during the replay when a live event closes a goal
  channel_unreachable                                 a push token was reported invalid (message_failed)
  rule_corrected                                      the goal's success rule changed while it was open

How the planner uses them (`apply_to_eligible`, `blocked_channels`):
  * A goal this viewer FAILED within GOAL_FAILURE_COOLDOWN is moved behind every other eligible goal. It is not
    removed: if it is the only eligible goal it is still chosen, and the decision says so. Trying the same thing
    again straight away is the cheapest way to repeat a failure; trying nothing at all is not justified by one miss.
  * Inconclusive outcomes teach nothing and are ignored (no attributable signal either way).
  * A channel marked unreachable is not planned again; the message planner falls through to the next channel.

Only learnings with at <= now are used, so a replay can never act on an outcome it could not yet have observed.
Goal learnings are recorded for holdout shadow goals as well, so goal choice stays the same procedure in both arms.
"""
from datetime import timedelta

from .fact_resolver import iso, parse_ts

GOAL_FAILURE_COOLDOWN = timedelta(days=14)


def record(st, at, kind, learning, **fields):
    entry = {'at': at if isinstance(at, str) else iso(at), 'kind': kind, 'learning': learning}
    entry.update(fields)
    st['learnings'].append(entry)
    return entry


def known(st, now):
    """Learnings that had become knowable by `now` (structured ones only)."""
    return [x for x in st.get('learnings', []) if x.get('kind') and parse_ts(x['at']) <= now]


def apply_to_eligible(eligible, st, now):
    """Re-orders the eligible goals using this viewer's past outcomes.
    Returns (eligible, applied) where applied lists the learnings that changed the order."""
    failed = {}
    for x in known(st, now):
        if x['kind'] == 'goal_failed' and now - parse_ts(x['at']) <= GOAL_FAILURE_COOLDOWN:
            failed.setdefault(x['goal_id'], x)
    if not failed:
        return eligible, []
    keep = [c for c in eligible if c['goal_id'] not in failed]
    demoted = [c for c in eligible if c['goal_id'] in failed]
    applied = [failed[c['goal_id']] for c in demoted]
    return keep + demoted, applied


def blocked_channels(st, now):
    out = {}
    for x in known(st, now):
        if x['kind'] == 'channel_unreachable':
            out.setdefault(x['channel'], x)
    return out


def cite(x):
    ref = x.get('goal_id') or x.get('channel')
    return 'learning:%s:%s@%s' % (x['kind'], ref, x['at'])
