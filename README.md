# One User, One Agent: STAGE take-home

A deterministic **decide → act → verify → measure** agent for STAGE's replay day. For each `app_open` or
`login_success` trigger, it works out who the viewer is, commits to at most one evidence-backed goal, and picks the
smallest useful intervention (home page, push, WhatsApp, in-app message, or nothing). An independent verifier checks
every action before it is published. Impact is then measured against the randomized holdout.

The agent uses only the Python 3.9+ standard library. The tests need `pytest`; the web app needs FastAPI. A mock/replay model provider stands
in for a real model, so no API key, network or third-party package is required.

## Contents

- [Run everything](#run-everything-one-command) · [Web app](#web-app-deployable) · [Deploying to Render](#deploying-to-render) · [Tests](#tests) · [Outputs](#outputs-sample_run) · [Code map](#code-map)
- [Architecture](#architecture) · [Known limitations](#known-limitations) · [AI collaboration](#ai-collaboration)

## Run everything (one command)

From this `submission/` directory:

```bash
python -m src.run_replay
```

This one command:

1. Loads and audits the pack.
2. Replays the day: 2,769 triggers plus the live and control events.
3. Writes `decisions.jsonl` and `actions.jsonl`.
4. Runs `simulator/simulate_outcomes.py` on the actions.
5. Judges every goal from the simulator output.
6. Writes the impact, latency and final reports.
7. Re-runs the simulator with three more seeds as a sensitivity check.
8. Builds the walkthrough site, `sample_run/site/index.html`.

It takes about 45 seconds.

The pack is found automatically if it sits next to `submission/` (as `../one_user_one_agent_pack`) or if
`submission/` is inside the pack. Otherwise, point at it:

```bash
python -m src.run_replay --pack /path/to/one_user_one_agent_pack --seed oua-practice
python -m src.run_replay --robustness-seeds ""      # skip the extra-seed sensitivity runs
python -m src.run_replay --skip-sim                 # agent replay only
python -m src.run_replay --prior-state sample_run/viewer_state --out next_run   # carry learnings into the next day
```

**Privacy.** The brief says to treat the pack as personal data, so `.gitignore` keeps `one_user_one_agent_pack/`
out of the repository. Evaluators already have the pack. Place it next to `submission/` or pass `--pack`.

Nothing is hard-coded to the practice day. Dates, the snapshot time, dialects, withdrawn titles, faults and outage
windows are all read from the pack, so a second replay day runs with the same command.

## Web app (deployable)

`web/` is a FastAPI app with a public, read-only site and API over `sample_run/`, plus a **live lab** behind an
access code. The lab runs the real agent on demand: pick a viewer, fire an app open, inject a surprise from the
brief (offline burst, duplicate, three dialects, model hallucination or outage, slow data store, a purchase
2 minutes later, a corrected rule, a remembered failure, a traffic burst), and watch every stage of the decision.

```bash
python -m pip install -r requirements.txt
LIVE_ACCESS_CODE=demo python -m uvicorn web.app:app --reload     # http://127.0.0.1:8000
```

Deploying to Render (private repo, access code, memory notes): see [Deploying to Render](#deploying-to-render).

## Walkthrough site (offline file)

Open `sample_run/site/index.html` in any browser. It is one self-contained file and works offline. It walks
through the run:

- the decide / act / verify / measure loop, with this run's numbers;
- the day's trigger volume, with each injected surprise marked;
- why the agent did nothing, and what it did when it acted;
- the verifier's checks, and the quarantined catalogue injections shown as plain text;
- impact against the holdout, with the pilot report's selection bias next to the randomised result;
- latency under stress;
- a viewer explorer. Pick a story or any viewer id, then drag the *as of* slider to see what the agent knew,
  decided and observed at that moment.

Every number is read from the run's output files. The page loads nothing from the network, so the pack's data
stays on this machine. To rebuild it from any run directory:

```bash
python -m src.build_site                 # sample_run/ -> sample_run/site/index.html
python -m src.build_site --run next_run
```

## Tests

```bash
python -m pip install -r requirements-dev.txt   # pytest, plus FastAPI/httpx for the web tests
python -m pytest -q          # 35 tests, ~15-30 s (runs the real replay once; web tests skip if FastAPI is missing)
```

These four are mandatory:

1. Holdout users never get an action.
2. A duplicate trigger never produces a duplicate action.
3. Model timeout, malformed output and unsupported claims fall back to rules (unit tests and the replayed faults).
4. Quiet hours, consent and the frequency cap are enforced.

The extra tests cover:

- Stale offline triggers vs. clock-skewed ones.
- Dialect precedence and conflict logging.
- Home-page platform rules.
- Title withdrawal and live-page replacement.
- Prompt-injection quarantine.
- Exclusion of unmeasurable goals.
- The G03 rule correction.
- Re-planning after a live purchase.
- Copy and pricing honesty.
- Latency and call budgets.
- The live evening traffic peak is detected separately from the offline-buffered backlog burst.
- One decision line per trigger.
- An end-to-end check that the simulator reports 0 policy problems.
- Learning feedback: a recently failed goal is demoted and cited, a future-dated learning is ignored, and an
  unreachable push channel is not used again.
- Learnings carry over between runs (`--prior-state`).
- A user-data-store outage fails closed for consent-gated messages and lowers confidence, within the latency budget.
- The walkthrough site builds, embeds data as inert JSON, and loads nothing from the network.

## Outputs (`sample_run/`)

| File | What it is |
|---|---|
| `decisions.jsonl` | One line per trigger (including every `NO_ACTION`, with its reason), plus re-plans after a title withdrawal |
| `actions.jsonl` | Only published actions. This is the simulator's input |
| `revisions.jsonl` | Goal closures, cancelled scheduled messages, rule corrections, dependency incidents |
| `viewer_state/` | One durable JSON state per viewer: facts with provenance, goal, pending actions, ledgers, learnings |
| `outcomes.jsonl` | Every committed goal judged `succeeded` / `failed` / `inconclusive`, with the evidence event ids |
| `impact_report.md`* | ITT uplift with 95% CIs, per-goal results, goal-agnostic ITT, exposure, and the pilot re-analysis |
| `latency_report.json` | Latency percentiles overall, during each outage window, at the live traffic peak and during the offline-backlog burst (found separately, each with its rate vs the median), plus budget use |
| `final_report.md`* | One-page summary: headline numbers, abstention reasons, every data trap and how it was handled |
| `data_audit.json` | Duplicates, missing profiles, injections, malformed deeplinks, excluded goals, rule corrections |
| `site/index.html` | Offline walkthrough site built from this run (`src/build_site.py`) |
| `sim/` | Raw simulator output for the practice seed (`sim_seeds/` holds the sensitivity seeds; it is regenerated by the run and git-ignored) |

\* Written by `python -m src.run_replay`; not committed, to keep this README the only Markdown file in the repo.

## Code map

| Module | Responsibility |
|---|---|
| `src/data_loader.py` | Loads the pack, dedupes events and profiles, scans free text for prompt injection |
| `src/fact_resolver.py` | IST and clock math, freshness, precedence rules, conflict logging |
| `src/state_store.py` | Durable per-viewer state; the user-data-store client with timeout/degradation |
| `src/goal_planner.py` | Eligibility from `goals.json`, unmeasurable-goal detection, interpretations, rule versions, success matching |
| `src/intervention_planner.py` | Builds the home page, push, WhatsApp or in-app candidate |
| `src/model_provider.py` | Mock/replay model, fault reproduction, circuit breaker, output validation |
| `src/verifier.py` | Independent policy checker with veto power |
| `src/replay_harness.py` | Event-ordered replay, per-decision budget, worker-pool latency model, live re-planning |
| `src/outcome_judge.py` | Goal judgement from `outcome_events.jsonl`; writes time-stamped learnings |
| `src/learning.py` | Structured learnings and how they re-order goals and block channels on later decisions |
| `src/impact_reporter.py` | ITT and CIs, pilot re-analysis, latency report, final report |
| `src/run_replay.py` | The single CLI entrypoint |
| `src/build_site.py`, `src/site_template.html` | Offline walkthrough site generated from a run directory |
| `web/app.py` | FastAPI app: public read API over a run, gated live API, security headers, rate limits |
| `web/live.py` | Live lab: isolated per-request harnesses, compressed per-viewer history, scenarios |
| `web/static/` | Front end (no build step, no third-party code) |

## Deploying to Render

The web app (`web/`) serves two things:

- **Public, read-only pages and API** over the replay in `sample_run/`: overview, decisions and abstentions,
  verification, impact against the holdout, reliability, and every viewer's timeline.
- **A live lab behind an access code**, which runs the real agent (`ReplayHarness.decide`) on demand. Each run
  gets a fresh, isolated harness.

### Before you start: the data pack

The live lab needs `one_user_one_agent_pack/` on the server. The brief says to treat the pack as personal data,
so `.gitignore` keeps it out of the repository by default. To deploy it:

1. Use a **private** GitHub repository. Never push the pack to a public one.
2. Add the pack explicitly. The ignore rule stays in place, so a later `git add .` elsewhere can't pick it up
   by accident.

Without the pack, the site still deploys. The results stay browsable and the lab says it is unavailable.

### Steps

```bash
# 1. In the project folder (the one with render.yaml)
git init
git add .
git add -f one_user_one_agent_pack        # only because this repo is PRIVATE
git commit -m "One User, One Agent: agent, replay, web app"

# 2. Create a PRIVATE repo on GitHub, then:
git remote add origin https://github.com/<you>/<private-repo>.git
git branch -M main
git push -u origin main
```

3. On [render.com](https://render.com): **New → Blueprint**. Connect GitHub and allow access to the private
   repo. Render reads `render.yaml` and creates the web service.
4. Render asks for **`LIVE_ACCESS_CODE`**. Pick a code and give it only to the interviewer. It is never
   committed.
5. Deploy. The first build takes 2–4 minutes. The health check is `/api/health`.
6. Open `https://<service>.onrender.com/`. Results are public. The live lab (`#/lab`) asks for the code.

Every later `git push` to `main` redeploys automatically.

### Things to know

| Topic | Detail |
|---|---|
| **Free plan sleeps** | After 15 minutes without traffic the service sleeps, and the next visit takes about a minute to wake it. Open the site a few minutes before the interview. |
| **Memory** | About 410 MB of the 512 MB limit. The pack's history is stored compressed and only unpacked per run. If the service is ever killed for memory, set `OUA_LIVE=0` to serve results only (about 70 MB), or move to a larger plan. |
| **Access code** | Sent as an `X-Access-Code` header and compared in constant time. Failed attempts are rate-limited (10 per minute per IP), and so are runs (30 per minute). The browser keeps the code only for the tab session. |
| **Isolation** | Each live run builds its own harness, state store, verifier and model provider. Runs never see each other, and never change the published replay. |
| **Headers** | Strict CSP (scripts only from this site), `X-Frame-Options: DENY`, `X-Robots-Tag: noindex` so search engines don't index the data, and no third-party scripts or fonts. |
| **Updating the results** | Run `python -m src.run_replay` locally, commit `sample_run/`, and push. |

### Run it locally

```bash
python -m pip install -r requirements.txt
# macOS / Linux
LIVE_ACCESS_CODE=demo python -m uvicorn web.app:app --reload
# Windows PowerShell
$env:LIVE_ACCESS_CODE="demo"; python -m uvicorn web.app:app --reload
```

Then open <http://127.0.0.1:8000>. The interactive API docs are at `/api/docs`.

| Variable | Meaning |
|---|---|
| `LIVE_ACCESS_CODE` | Code for the live lab. If unset, the lab is disabled. |
| `OUA_PACK` | Path to the pack (default: auto-detected). |
| `OUA_RUN` | Replay output to serve (default: `sample_run`). |
| `OUA_LIVE` | Set to `0` to skip loading the live agent. |

## Architecture

### The loop

```
 triggers.jsonl ─┐                ┌──────────────────────── one decision (budget: 8 model / 20 tool calls, 60 s) ───────────────────────┐
 live_events ────┼─► replay ─────►│ idempotency ─► store read ─► resolve facts ─► freshness ─► dialect ─► goal ─► intervention ─► VERIFY │──► publish / abstain
 control_events ─┘   harness      │  (event_id)   (timeout)     (provenance)    (>600 s?)   (valid?)   (1 max)   (smallest)    (veto)  │      │
   (time-ordered)     │           └──────────────────────────────────────────────────────────────────────────────────────────────────────┘      │
                      │ live event: update state, close achieved/obsolete goals, cancel pending messages                                          ▼
                      │ control: withdraw title (replace live pages), correct goal rule (re-point open goals), outage windows   decisions.jsonl / actions.jsonl
                      ▼                                                                                                                           │
               viewer_state/<user>.json ◄── learnings ── outcome_judge ◄── simulator outcome_events ◄────────────────────────────────────────────┘
                                                            │
                                                            └─► impact_reporter: ITT agent vs holdout, 95% CI, pilot re-analysis, latency
```

### Ownership: one viewer, one agent

Each viewer has one logical agent. Its state is one document in `viewer_state/<user_id>.json`, and that state is
never shared between viewers. The harness serialises a viewer's decisions: a viewer's next decision cannot start
before their previous one has published, which is modelled by `user_busy` in the worker pool.

Across viewers, decisions run on a pool of 4 workers in virtual time. A traffic spike therefore shows up as queueing
delay inside `decided_in_ms` instead of being hidden.

Global facts, such as a withdrawn title, a corrected goal rule or an outage window, are broadcast by the harness.
Each agent then acts on them for its own viewer.

### Understanding the viewer (`fact_resolver.py`)

Every fact is `{value, source, as_of, freshness_s, conflicts}`.

**Time.** All maths is on server `received_at`. Phone clocks are wrong in two different ways:

- **Skew** shifts `occurred_at` and `sent_at` together.
- **Offline buffering** delays `sent_at`.

So `age = sent_at − occurred_at` measures buffering without being fooled by skew, and the true event time is
estimated as `received_at − age`. Applying the brief's suggested `received_at − occurred_at` rule to this pack would
have abstained on 23 fresh triggers and acted on 2 stale ones. A trigger buffered for more than 600 s is history,
not a visit. It is recorded, and the agent abstains.

**Precedence rules:**

| Fact | Rule |
|---|---|
| Dialect | The trigger's `app_dialect` wins, because the app shows the page for that dialect. Profile, deeplink and `app_dialect_changed` disagreements are written to `dialect.conflicts`. `d7` and `"NA"` are values the app actually reports and have no catalogue titles, so the dialect is **unresolved** and the agent abstains. A missing value (`None`) is a telemetry gap. The agent falls back to the last valid app setting, then the profile, but only if they don't disagree. That dialect is used for a message only, never a page: no page can match a session that reports no dialect (`simulate_outcomes.py` line 249). |
| Subscription | A purchase, renewal or lapse received after `snapshot_at` overrides the snapshot. Viewers with no profile get their status from events. |
| Consent | Profile opt-in AND no `notification_opt_out` for that channel at any time (the stricter reading). Missing means false. |
| Profiles | Duplicate rows: keep the latest `updated_at`. Missing profiles are synthesised from `signup_completed`. |

### Planning (`goal_planner.py`)

**Measurability first.** A goal whose `success.event` is null (G10) or not in the event schema (G11,
`tv_app_open`) can never be judged. Both are excluded at load time, and the reason is written to `data_audit.json`.

**Priority.** Eligibility runs in a fixed priority order:

```
G04 > G01 > G03 > G07 > G12 > G02 > G09 > G08 > G06 > G05
```

The most specific, evidence-backed need comes first. Low-base-rate conversion goals come last. The first eligible
goal is the rule choice.

**Interpretations.** Ambiguous rules get one written interpretation each, copied into every decision's
`assumptions`:

- **G06** ("recently lapsed") means a lapse observed in the last 30 days.
- **G07** ("unfinished, not played for 3+ days") means the viewer reached episode 2 or completed an episode, has
  episodes left, has not played the series for 72 h, and the series is in the app dialect.

**Commitment.** One goal per viewer at a time. The goal window starts when the decision publishes. Later triggers
continue the open goal; they do not re-plan it.

**Corrections.** `goal_rule_corrected` bumps `rule_version` (v1 → v1.1) and re-points every open goal at the new
rule, with a revision record. The outcome judge uses the rule in force.

**Live re-planning.** A live event that satisfies the open goal closes it as `achieved_live`. A subscription change
that invalidates a conversion goal closes it as `obsolete`. In both cases, pending messages are cancelled. An opt-out
cancels that channel's pending messages. A dialect change cancels messages naming titles in another dialect.

### Acting (`intervention_planner.py`)

**Home page.** This is the default action.

- **Hero.** The goal's own target if it has one (the unfinished series for G07, a new release for G08, a premium
  title for conversion goals). Otherwise, the most popular unwatched title.
- **Rows.** Up to 5 rows, from `next_episode`, `because_you_watched`, `popular_in_dialect`, `new_releases` and
  `genre` (×2), in an order that depends on the goal.
- **Valid titles.** One title per `content_slug` across the whole page, in the app-language variant. A title must be
  in the dialect, and available both at publish time and for the whole 2-hour TTL, so a title expiring at 12:30Z is
  never promoted at 11:00Z. It must not be withdrawn or quarantined.
- **Row size.** Rows with fewer than 3 titles are not built. Row length adapts to thin catalogues (`d3` has 15
  titles).

**Message.** At most one per viewer, and only for goals that need a return on a later day (G03, G07, G09). It is
sent at 19:00 IST the next day, which is outside quiet hours by construction.

- Channel preference is push, then WhatsApp (approved template `wa_recommend_title_v1`, variables copied verbatim
  from the catalogue), then an in-app message when there is no channel consent.
- The copy names only real episodes and real titles, with no prices or offers.
- A scheduled message stays cancellable until its `send_at`.

**No action.** Doing nothing is a normal decision. The agent abstains in these cases:

- duplicate trigger
- stale trigger
- unresolved dialect
- no eligible goal
- personalised page still live (more than 30 minutes left)
- holdout user
- verifier veto
- budget exhausted

### The model's role (`model_provider.py`)

The model is used in one place: choosing among goals that the rules have already found eligible. That is the only
real judgement call in the loop. Its output is treated as untrusted:

- The JSON is parsed strictly.
- The chosen goal must be in the eligible set.
- Its `confidence` and `reason` are recorded but never used as evidence.
- A reason that cites a source the agent does not have (for example "confirmed in billing") is rejected.

Failures fall back to the rule choice:

| Failure | Handling |
|---|---|
| Timeout | Client timeout of 1.5 s |
| HTTP 503 | Rule choice, and a 30-second circuit breaker |
| Malformed output, schema violation, unsupported claim | Rule choice, with `fallback_used: true` |

Holdout viewers go through the same advisor. Their shadow goal is chosen exactly as an agent viewer's would be, so
goal assignment stays identical across arms even once a real model is plugged in.

The model is not called for decisions that continue an open goal, for decisions that end earlier (duplicate, stale,
unresolved dialect), or under load shedding (more than 10 s of queueing, applied to both arms). Every trigger named
in `model_faults.jsonl` carries a `model_fault` record in `decisions.jsonl` saying whether the fault was exercised
and how it was handled. In mock mode, the "model" answers deterministically with the rule choice.

### Verification (`verifier.py`): independent, with veto power

The verifier does not trust the planner. It re-derives what it needs from raw sources:

- holdout from `arms.csv`
- consent from the raw profile row and the raw event log
- the frequency cap from its own approval ledger and delivered messages
- withdrawals from its own copy of the control events

It never repairs an action. It vetoes it, and the failed check is written to `checks.failed`. The checks are:

| Area | Checks |
|---|---|
| Every action | holdout, idempotency (trigger × type), latency < 60 s, model/tool budget |
| Home page | schema, page dialect = app dialect, ≤ 6 rows, 3–10 titles per row, allowed row types, no "continue watching", every title in dialect + available + not withdrawn + not quarantined, `content_slug` unique across hero and rows |
| Push / in-app | consent and opt-out, quiet hours at `send_at`, 1 push+WhatsApp per IST day, title ≤ 40 / body ≤ 120 characters, forbidden phrases, only ₹1 / ₹149 / ₹399 and no offer words, no instruction-like text, deeplink `ott://title/<id>` matching the title, title in dialect and available at `send_at` |
| WhatsApp | approved template only, exact variable set, values equal to catalogue or pricing values |

### Memory (`state_store.py`)

The viewer state holds:

- resolved facts with provenance
- the active goal and goal history, including revisions
- pending, published and cancelled actions
- the live page, with its TTL and title ids
- the message and in-app ledgers per IST day
- processed trigger ids
- decision summaries
- revisions
- **learnings** (`learning.py`): structured records `{at, kind, goal_id|channel, evidence}`. Kinds: each goal's
  judged outcome (`goal_succeeded` / `goal_failed` / `goal_inconclusive`), goals closed live during the replay
  (`goal_achieved_live`, `goal_obsolete_live`), rule corrections applied, and push tokens the simulator found invalid
  (`channel_unreachable`). `at` is when the learning became *knowable*: the success event's time, or the deadline
  for a failure.

#### How learnings feed back into decisions

The planner reads the viewer's learnings on every new goal choice, using only those with `at <= now`, so nothing
leaks from the future:

- A goal this viewer **failed** in the last 14 days moves behind every other eligible goal. If it is the only
  eligible goal it is still tried, with confidence lowered by 0.15 and an assumption saying so.
- A channel marked **unreachable** is not planned again. The message planner falls through to WhatsApp or in-app.
- Every learning applied is cited in the decision's `evidence` as `learning:<kind>:<goal|channel>@<at>`.
- Inconclusive outcomes are recorded but change nothing, because they carry no attributable signal.

Goal learnings are written for holdout shadow goals too, so goal choice stays the same procedure in both arms.
Channel learnings only shape actions, and holdout viewers never get actions.

In one replay day no judged outcome is knowable yet: every goal window ends after the day. So the feedback acts across
days. `python -m src.run_replay --prior-state <earlier run>/viewer_state` carries learnings into the next day's
replay. Facts are re-resolved from the pack; only learnings are carried.

Raw events are not copied into the state file. They can be re-derived from the pack and the replay feed, and the
state keeps a summary.

### Latency

The README asks for measured processing time. Here:

```
decided_in_ms = queueing in the virtual worker pool + measured wall-clock compute + simulated dependency latency
```

- The simulated dependencies are the user store (4–25 ms) and the model (120–400 ms).
- `published_at = deliver_at + decided_in_ms`, and a test checks this for every decision.
- The simulator shows the home page 3–40 s after the app opens, so the real target is under 3 s, not under 60 s.
  All 933 pages met it. The p95 for the whole run is about 390 ms, and the worst case (store degraded) is about
  1.2 s.

**Bursts.** The latency report finds two kinds of burst separately, so one can't be mistaken for the other. Each
is the busiest 10-minute window of its kind, compared with the median live 10-minute rate:

- **Live traffic peak**: fresh app opens. On the practice day this is 15:00 UTC (20:30 IST), with 162 triggers, about
  11× the median. That is the brief's "traffic triples at the evening peak", measured against a quiet-hours median.
  p95 was about 400 ms.
- **Offline backlog**: triggers buffered on phones for more than `STALE_AFTER_S` (600 s). On the practice day this is
  10:08 IST, with 224 triggers. These are abstained as stale before any store or model call, so they cost about
  20 ms each and do not slow down live viewers.

### Scaling: bursts, 10M viewers, 40 dialects

This replay is a single process. Nothing in the design ties it to one process: one viewer's agent touches only that
viewer's state, plus shared read-only data (catalogue, goal rules, popularity).

- **1,000 opens in one minute.** Shard triggers by `user_id` across a partitioned queue, for example Kafka keyed by
  viewer. Ordering and idempotency then stay per viewer with no global lock. Work is shed in priority order, which
  the harness already does for one step:
  1. The optional model call goes first (the rule choice stands in).
  2. Then the messages. These are scheduled for the next evening anyway, so they can be deferred.
  3. The home page is never shed, because it is the only action whose value expires within 3 to 40 seconds.

  Stale buffered triggers are filtered before any I/O.
- **10M viewers.** Viewer state moves from JSON files to a key-value store with compare-and-swap on a per-viewer
  version, so two workers can never both publish for the same viewer. Popularity and eligibility features are
  precomputed per dialect each night. The live path reads one state record and a cached catalogue slice. A goal rule
  correction is applied as a targeted job over the open goals with that `goal_id`, an index lookup, not a
  re-scan of every viewer, which is the same behaviour the replay shows.
- **40 dialects.** Nothing is keyed to `d1`–`d6`. The valid dialects come from the catalogue. Two parts grow with the
  dialect count:
  1. A per-dialect "displayable content" check: a row needs at least 3 titles available in the dialect being shown,
     and some long-tail dialects will often fail it. The agent then abstains or falls back to a hero-only page. It
     never substitutes another dialect.
  2. Human-readable dialect names and template approvals per dialect.

  Measurement should stratify by dialect, because small dialects will be underpowered on their own.

**Never automated.** Some changes stay with humans: goal success definitions and rule corrections, new message
templates and copy, consent and quiet-hours policy, pricing, and the decision to roll out or roll back after an
impact read. The agent applies these. It never authors them.

### Failure recovery

| Failure | Behaviour |
|---|---|
| Model timeout / 503 / garbage / hallucinated eligibility | Rule choice, `fallback_used: true`, circuit breaker on 503 |
| User data store degraded (p95 8 s, 20% timeouts) | 800 ms read timeout, then cached state. Confidence −0.2. Push and WhatsApp **fail closed**, because consent cannot be re-verified. The home page still ships. |
| Traffic spike | Worker-pool queueing is measured. The optional model call is shed above 10 s of queue. |
| Title withdrawn | Every live page that contains it is re-published without it at the withdrawal time. Pending messages naming it are cancelled. The verifier blocks it from then on. |
| Rule corrected mid-day | Version bump, open goals re-pointed, judge applies the rule in force |
| Purchase arrives after a decision | Goal closed (achieved or obsolete), pending messages cancelled |
| Budget exceeded | `BudgetExceeded`, then abstain with `budget_exceeded` |

### Trust boundaries

| Source | Trust |
|---|---|
| `received_at`, the catalogue's structured fields, `arms.csv`, config | Trusted |
| Phone clocks (`occurred_at`, `sent_at`) | Not trusted for time. Used only for their difference. |
| Free text: titles, descriptions, search queries, deeplinks | **Data, never instruction.** Each is scanned with injection patterns. Flagged titles (T0002, T0522) are quarantined from every page and message, and logged in `data_audit.json`. Deeplinks are parsed with a strict regex and used only as a conflict signal. Title text goes into fixed copy slots only after sanitising. |
| Model output | Advisory only, inside the eligible set. Never evidence. |
| Personal data | Everything runs locally. The mock model sends nothing anywhere, as messaging policy §7 requires. |

### Measurement (`outcome_judge.py`, `impact_reporter.py`)

**Shadow goals.** Holdout viewers get a shadow goal from the identical rules at the identical moment, and no action.
Goal assignment is therefore pre-treatment and identically distributed in both arms. Comparing goal success between
the arms as randomized is an unbiased intention-to-treat estimate.

**Statistics:**

- Newcombe hybrid-score 95% CIs and a two-sided z-test.
- A minimum detectable effect is stated.
- A goal-agnostic ITT (any play, completion, purchase, play on 3+ days, plays per user) over every triggered user
  needs no goal logic at all.
- Results from extra simulator seeds are reported next to the headline.

**Biased comparisons, labelled.** The "served vs everyone else" comparison is reproduced on purpose and marked as
biased, which is the mistake in the pilot report. The pilot is re-analysed as ITT, CACE, per-goal results, and a
direct standardisation of the served group's goal mix.

## Known limitations

These are things we scoped out on purpose, or know to be imperfect. Each one says why.

### Measurement

- **The effect is small and noisy.** About 700 viewers per arm have a goal. The minimum detectable effect is about
  5 pp. Across four simulator seeds, the primary uplift ranged from +0.9 to +4.0 pp, and only one seed's interval
  (`seed-b`) excluded zero. We report it as "small, positive, uncertain". The per-goal cells are underpowered and have no
  multiplicity correction; they are descriptive.
- **Shadow goals and a real model.** Holdout viewers' shadow goals go through the same advisor as agent viewers', so
  goal assignment follows one procedure in both arms. With a real, non-deterministic model, the arms are comparable
  only in distribution, not user by user. The goal-agnostic ITT metrics in the impact report don't depend on goal
  logic at all.
- **One G07 threshold was set after a practice run.** The first run let "sampled episode 1 a week ago" count as an
  unfinished series. That made G07 60% of all goals and sent 306 resume pushes. We tightened it to require investment
  (reached episode 2, or completed an episode). The product argument stands on its own: a single sampled episode is a
  bounce. But the change was made after seeing outcomes, so treat the practice-seed numbers as tuned. The evaluators'
  unseen day and seed are the honest test.
- **Only 30 days of history.** "Never played", "never completed" and "never paid" mean never *in the pack*. Those
  assumptions are written into each decision.

### Agent behaviour

- **Unknown app dialect.** 185 triggers carry `d7`, `None` or `"NA"`.
  - `d7` and `"NA"`: the agent abstains. The simulator sets the viewer's dialect to that string, so no page and no
    message title can ever match.
  - `None`: the agent falls back to the last app setting or the profile, but only for a message, since no page can
    match a session without a dialect. In practice this produced 1 extra push. Most of these viewers have no goal
    that needs a message, and 19 more `None` triggers abstain as `app_dialect_missing_no_displayable_page`.
  - A `"NA"` viewer with a consistent valid history is probably a telemetry bug. We still abstain, because the
    platform shows pages for the reported value.
- **Two scheduled model faults never fire.** They are on offline-buffered triggers, which are abstained before any
  model call. Both are logged with `model_fault.exercised: false`. The timeout (on a holdout viewer), the malformed
  output and the U-01991 unsupported claim are exercised in the replay. All three fault kinds are also unit-tested.
- **Scheduled messages can be cancelled only until the replay ends.** Messages are scheduled for 19:00 IST the next
  day. Live events during the replay day cancel them (purchase, opt-out, dialect change, withdrawal). After the replay
  window, the simulator has no cancel API, so there is no re-check at send time. In production, the verifier would
  run again at `send_at`.
- **Per-viewer learning is simple, and acts across days only.** Two rules: a recently failed goal is demoted, and an
  unreachable push channel is skipped. Within one replay day no judged outcome is knowable yet, because every goal
  window ends after the day, so the sample run shows learnings recorded but none applied. The rules are unit-tested,
  and `--prior-state` carries learnings into a later day. Re-running the *same* day with `--prior-state` correctly
  applies nothing: every learning would be from the future.
- **Fixed goal priority, no learning across viewers.** The priority order is a written product judgement, not
  learned. There is no bandit or uplift model; that would be over-engineering for one replay day with this much
  noise.
- **Simple ranking.** Popularity is distinct players over 30 days, with no recency decay and no collaborative
  filtering. This is deliberately not a recommender project. The simulator also picks the played title independently
  of page content, so ranking quality is hard to measure here at all.
- **WhatsApp `dialect_name`** is filled with the catalogue code (`d5`). The pack has no human-readable dialect names,
  and the template forbids free text.
- **`wa_trial_ending_v1` is never used.** None of the 4 trial viewers has a `plan_ends_at`, so "your trial is ending
  soon" cannot be backed by evidence.
- **`wa_new_episode_v2` is never used.** Episodes have no release dates, so "Naya episode aa gaya" cannot be shown to
  be true.
- **In-app messages** are used only when there is no channel consent. The simulator queues them and they have no
  effect.
- **Consent is strict.** Any historical `notification_opt_out` blocks that channel for good, because the schema has
  no opt-in event. This is safe but may under-message.

### Engineering

- **Latency is modelled, not real.** Compute time is real wall-clock time, in-process. The user store and model
  latencies are simulated deterministically (seeded by trigger id), and queueing uses a virtual 4-worker pool. The
  numbers are honest for this design, but they are not a load test.
- **The state store is JSON files**, not a transactional database. That is enough for a single-process replay. A
  production version would need per-viewer locking or compare-and-swap.
- **Injection detection is pattern-based** and could miss a paraphrased attack. The main defence does not depend on
  detection: free text is never interpreted as instruction. Detection only drives quarantine and logging.
- **The degraded store has no "cache that differs from the store".** Both are the same process, so the stale-cache
  path only changes behaviour by failing consent-gated channels closed and lowering confidence. It does not hide
  recent live events.

## AI collaboration

### How AI was used

This submission was built with an AI coding assistant (Claude, in Claude Code), with a human directing it and
reviewing the work. The AI:

- audited the pack
- read the simulator source to learn its exact contract
- drafted the modules, tests and documents
- ran the pipeline

The human set the direction: a deterministic core, honesty over uplift, NO_ACTION as a first-class decision. The
human also owned every judgement call recorded here.

### Verification workflow

1. **Audit before code.** Throwaway scripts counted every trap before any agent code existed: duplicate ids, stale
   and skewed triggers, invalid dialects, profile duplicates, missing profiles, injections, the pilot numbers. Those
   counts are re-derived by `data_loader.py` and written to `data_audit.json`, so the code and the audit can be
   compared.
2. **Read the simulator as the specification.** Its source showed what actually matters:
   - a page must land within about 3 s to be seen on the triggering visit
   - "stale" means `sent_at − occurred_at > 600 s`
   - pages only show in the app's dialect
   - quiet-hour and over-cap messages cause opt-outs
   - in-app messages do nothing
3. **No hand-typed numbers.** Every figure in `impact_report.md` and `final_report.md` is computed from the run's
   outputs by `impact_reporter.py`.
4. **Gates.** `pytest` (35 tests). The simulator must report `policy_problem_count == 0`, with no dropped rows and no
   rejected pages. The headline is shown next to three extra seeds, so a lucky seed cannot carry the result.

### Where we rejected or corrected AI or brief suggestions

**1. "One goal has no measurable success event."** The brief we started from said exactly one goal was
unmeasurable. The audit found two:

- G10 has `success.event: null`.
- G11's `tv_app_open` is not an event anywhere in the schema, so it can never be observed.

Selecting G11 would have produced goals that can only ever be "failed". Both are excluded, and the reason is written
down for each.

**2. Staleness rule.** The suggested rule was that a trigger is stale when `received_at − occurred_at` is large.
That treats phone clock skew as staleness. Measured on the replay triggers, it would have abstained on **23 fresh
triggers** from phones with wrong clocks, and acted on **2 stale ones** from phones whose clocks run behind. We use
`sent_at − occurred_at` instead, because skew shifts both phone timestamps equally and cancels out. It matches the
simulator's own definition.

**3. Over-messaging in the first G07 draft.** The first full run treated "played episode 1 of a series a week ago"
as an unfinished series. That made G07 60% of all goals and queued **306 resume pushes**. Every one was
policy-compliant, but most were not proportionate. We rejected that version: a resume goal now requires evidence
of investment (episode 2+ or a completed episode). We also say plainly under [Known limitations](#known-limitations) that this was
decided after a practice run.

**4. Bug caught by a test, in AI-written re-planning code.** When T0001 was withdrawn, the replacement page for one
viewer (U-01487) was built from that viewer's *latest* trigger. That trigger's dialect was `None`, so the agent
abstained and **left the old page live with the withdrawn title on it**. The withdrawal test failed. The replacement
is now built for the dialect of the page it replaces.

**5. Faults forced on purpose: rejected, then a review found a better design.** We rejected calling the model on
every trigger just to make all five faults fire. That would mean model calls on stale triggers, where there is no
decision to make.

A later review question pointed out a real problem: the first version skipped the model for holdout viewers. With a
real model, holdout shadow goals would then be chosen differently from agent goals, which biases the comparison.
Holdout viewers now go through the same advisor. That also exercises the timeout fault, which sits on a holdout
trigger. The two faults on stale triggers are still not exercised, and every fault trigger now carries an explicit
`model_fault` record.

**5b. Dialect fallback, checked against the simulator.** We first abstained on all 185 unknown-dialect triggers.
Reading `simulate_outcomes.py` showed the distinction. `"NA"` and `d7` become the viewer's dialect string, so nothing
can match. `None` keeps the earlier dialect or falls back to the profile, so a message can still be judged correct.
`None` now falls back for messages only, and pages are never published, because none can be shown.

**6. Verifier independence.** The first draft of the frequency-cap check read the planner's own state-store ledger.
A verifier that trusts the planner's bookkeeping is not independent. It now uses its own approval ledger plus
`message_delivered` events from the raw event log. Consent and holdout are re-derived from raw sources in the same
way.

**7. Mislabelled traffic peak, found in a pre-submission audit.** Checking the brief line by line against the
outputs showed that the latency report called the busiest single *minute* the "traffic peak". That minute was the
offline-buffered backlog at 10:08 IST: 221 of 240 triggers were stale, cheap abstentions. The real evening surge
(20:30 IST, 162 live opens) had no section of its own. Latency was within budget in both windows, so this was a
reporting error, not a failure.

The report now finds the busiest 10-minute window separately for live triggers and for stale ones, and states each
against the median live rate. A test checks that the two cannot be confused. The regenerated `actions.jsonl` was
diffed against the previous one and had no non-timing changes.

### What the AI was not allowed to decide

- It could not change what counts as success to improve the numbers. The only change made after a run (item 3)
  made the agent send *fewer* messages, and it is disclosed.
- It could not treat model output as evidence.
- It could not send anything to an external service. The pack is treated as personal data (policy §7), and the model
  is a local mock.
