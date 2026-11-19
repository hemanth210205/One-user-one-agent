/* One User, One Agent: front end. No framework and no build step. Every string from the API is rendered with
   textContent (via h()), never parsed as HTML, so catalogue text with injected instructions stays inert. */
(function () {
'use strict';

/* ================================ helpers ================================ */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(9)) { if (c == null || c === false) continue; e.append(c instanceof Node ? c : document.createTextNode(String(c))); }
  return e;
}
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (v == null) continue; if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const c of kids.flat(9)) if (c) e.append(c);
  return e;
}
const $ = id => document.getElementById(id);
const fmt = n => n == null ? '–' : Number(n).toLocaleString('en-US');
const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '–';
const pp = x => (x >= 0 ? '+' : '') + (x * 100).toFixed(1);
const ci = r => r ? `${pp(r.diff)} pp [${pp(r.ci[0])}, ${pp(r.ci[1])}]` : '–';
const ms = v => v == null ? '–' : (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function ist(iso, withDate = true) {
  if (!iso) return '–';
  const d = new Date(new Date(iso).getTime() + 330 * 60000), p = x => String(x).padStart(2, '0');
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const t = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return withDate ? `${p(d.getUTCDate())} ${M[d.getUTCMonth()]} ${t} IST` : t;
}
function age(sec) { if (sec == null) return ''; if (sec < 120) return Math.round(sec) + 's'; if (sec < 7200) return Math.round(sec / 60) + ' min'; if (sec < 172800) return (sec / 3600).toFixed(1) + ' h'; return (sec / 86400).toFixed(1) + ' days'; }

const tip = $('tip');
function showTip(ev, nodes) { tip.replaceChildren(...nodes); tip.style.opacity = 1; const r = tip.getBoundingClientRect(); let x = ev.clientX + 14, y = ev.clientY + 14; if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14; if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14; tip.style.left = x + 'px'; tip.style.top = y + 'px'; }
function hideTip() { tip.style.opacity = 0; }
const trow = (k, v) => h('div', { class: 'r' }, h('span', { class: 'muted' }, k), h('b', { class: 'num' }, v));
function hover(el, fn) { el.addEventListener('mousemove', e => showTip(e, fn())); el.addEventListener('mouseleave', hideTip); return el; }

/* storage that may be unavailable (private mode, blocked site data) */
const store = {
  get(k, sess) { try { return (sess ? sessionStorage : localStorage).getItem(k); } catch (e) { return null; } },
  set(k, v, sess) { try { (sess ? sessionStorage : localStorage).setItem(k, v); } catch (e) {} },
  del(k, sess) { try { (sess ? sessionStorage : localStorage).removeItem(k); } catch (e) {} },
};

/* ================================ api ================================ */
let CODE = store.get('oua-code', true) || '';
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Accept': 'application/json' }, opts.body ? { 'Content-Type': 'application/json' } : {}, CODE ? { 'X-Access-Code': CODE } : {});
  const r = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  if (!r.ok) { const err = new Error((data && data.detail) || r.statusText); err.status = r.status; throw err; }
  return data;
}

/* ================================ labels ================================ */
const REASON = {
  holdout_user: ['Randomised holdout', 'shadow goal only, by design never an action'],
  stale_offline_buffered_trigger: ['App open buffered offline', 'older than 10 min: that visit is already over'],
  personalised_page_already_live: ['A fresh page is already live', 'republishing would add nothing'],
  app_dialect_unresolved: ['App reports an unknown dialect', 'd7 / NA: no title could ever match'],
  duplicate_event_id: ['Duplicate delivery', 'this trigger was already handled'],
  app_dialect_missing_no_displayable_page: ['App sent no dialect', 'no page can be shown this session'],
  no_eligible_goal: ['No measurable goal fits', 'not enough evidence to commit to one'],
  budget_exceeded: ['Call budget exceeded', 'fell back to no action'],
  no_valid_intervention: ['No valid intervention', 'nothing passed the planner'],
};
const reasonLabel = r => REASON[r] || (r && r.startsWith('verifier_veto') ? ['Verifier veto', r.slice(14)] : [r, '']);
const ACTION = { home_page: 'Home page', push: 'Push notification', whatsapp: 'WhatsApp template', in_app_message: 'In-app message' };
const CHECK = { idempotency: 'Not a duplicate trigger', freshness: 'Trigger fresh enough to act on', dialect_resolved: 'Dialect resolved', holdout: 'Viewer is not in the holdout',
  latency: 'Within latency budget', budget: 'Within model / tool call budget', schema: 'Action matches its schema', dialect: 'Content in the dialect shown',
  row_bounds: 'Rows have 3+ titles, within platform max', title_dialect: 'Every title exists in that dialect', availability: 'Titles available for the whole TTL',
  not_withdrawn: 'No withdrawn title', injection_quarantine: 'No quarantined title', consent: 'Channel consent', quiet_hours: 'Outside quiet hours (22:00–08:00)',
  frequency_cap: 'At most one message per day', pricing_honesty: 'Pricing claims are true', forbidden_phrases: 'No forbidden phrases', copy_not_instruction: 'Copy is not an instruction',
  deeplink_format: 'Deep link well-formed', content_slug_dedup: 'No title twice (language variants)', send_after_publish: 'Send time after publish', copy_length: 'Copy length limits',
  hero: 'Hero slot valid', row_types: 'Row types allowed', no_continue_watching: 'No reserved row types', content_non_empty: 'Page not empty' };
const MODEL = { ok: 'Model answered, validated', not_needed_goal_continuing: 'Not needed: goal continuing', not_called: 'Not called (decided earlier)',
  circuit_open: 'Circuit open after outage', unavailable: 'Provider down (HTTP 503)', unsupported_claim: 'Unsupported claim rejected', timeout: 'Timed out', malformed_output: 'Malformed output rejected', skipped_load_shedding: 'Skipped: load shedding' };

/* ================================ app state ================================ */
let OV = null, HEALTH = null;
const cleanups = [];          // per-page timers / listeners
const redraws = [];           // width-dependent charts on this page
function resetPage() { while (cleanups.length) cleanups.pop()(); redraws.length = 0; hideTip(); }
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => redraws.forEach(f => f()), 120); });

/* theme */
$('theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const nxt = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', nxt); store.set('oua-theme', nxt);
  redraws.forEach(f => f());
});

/* ================================ shared blocks ================================ */
function page(...kids) { const p = h('div', { class: 'page fadein' }, kids); return p; }
function header(eyebrow, title, intro) { return [h('div', { class: 'eyebrow' }, eyebrow), h('h1', {}, title), intro ? h('p', { class: 'lede' }, intro) : null]; }
function section(title, intro, ...kids) { return h('section', { class: 'block' }, h('h2', {}, title), intro ? h('p', { class: 'intro' }, intro) : null, kids); }
function tiles(rows) { return h('div', { class: 'tiles' }, rows.map(([v, l]) => h('div', { class: 'tile' }, h('div', { class: 'v num' }, v), h('div', { class: 'l' }, l)))); }

function hbars(rows, total) {
  const max = Math.max(...rows.map(r => r.n), 1);
  return h('div', { class: 'hbars' }, rows.map(r => hover(h('div', { class: 'hb' },
    h('div', {}, r.label, r.sub ? h('small', {}, r.sub) : null),
    h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${Math.max(1.5, 100 * r.n / max)}%` })),
    h('div', { class: 'val num' }, fmt(r.n))),
    () => [h('b', {}, r.label), trow('count', fmt(r.n)), trow('share', pct(r.n, total)), r.code ? h('div', { class: 'muted mono', style: 'margin-top:4px' }, r.code) : null])));
}

function dayChart() {
  const wrap = h('div', { class: 'chart' }), list = h('div', { class: 'evlist' });
  const draw = () => {
    const T = OV.timeline, bins = T.bins || []; if (!bins.length) return;
    const W = Math.max(300, wrap.clientWidth), H = 280, m = { l: 36, r: 8, t: 34, b: 26 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const N = bins.length, bw = pw / N, maxY = Math.max(...bins.map(b => b.fresh + b.stale), 1);
    const step = maxY > 150 ? 50 : maxY > 60 ? 20 : 10, top = Math.ceil(maxY / step) * step;
    const x = min => m.l + min / (24 * 60) * pw, y = v => m.t + ph - v / top * ph;
    const g = s('svg', { width: W, height: H, role: 'img', 'aria-label': 'Triggers per 10 minutes across the replay day' });
    for (let v = 0; v <= top; v += step) { g.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: v ? 'var(--grid)' : 'var(--axis)' })); g.append(s('text', { class: 'tick', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', text: v })); }
    for (let hh = 0; hh <= 24; hh += 3) g.append(s('text', { class: 'tick', x: x(hh * 60), y: H - 8, 'text-anchor': hh === 0 ? 'start' : hh === 24 ? 'end' : 'middle', text: String(hh).padStart(2, '0') + ':00' }));
    const evs = T.events || []; let lastX = -99, lane = 0;
    evs.forEach((e, i) => {
      const x0 = x(e.start), x1 = e.end != null ? Math.max(x(e.end), x0 + 3) : null;
      if (x1 != null) g.append(s('rect', { x: x0, y: m.t, width: x1 - x0, height: ph, fill: 'var(--band)' }));
      else g.append(s('line', { x1: x0, x2: x0, y1: m.t, y2: m.t + ph, stroke: 'var(--axis)', 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }));
      const cx = x1 != null ? (x0 + x1) / 2 : x0; lane = (cx - lastX < 24) ? (lane + 1) % 2 : 0; lastX = cx;
      const cy = lane ? m.t - 6 : m.t - 20;
      const b = s('g', {}, s('circle', { cx, cy, r: 9, fill: 'var(--ink)' }), s('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', fill: 'var(--page)', 'font-size': 11, 'font-weight': 600, text: i + 1 }));
      b.addEventListener('mousemove', ev => showTip(ev, [h('b', {}, `${i + 1}. ${e.label}`), h('div', { class: 'muted' }, ist(e.at)), h('div', { style: 'margin-top:4px' }, e.detail)]));
      b.addEventListener('mouseleave', hideTip); g.append(b);
    });
    const gap = bw > 4 ? 1 : 0.5;
    bins.forEach((b, i) => {
      const bx = m.l + i * bw + gap / 2, w = Math.max(1, bw - gap);
      if (b.fresh) g.append(s('rect', { x: bx, y: y(b.fresh), width: w, height: Math.max(.5, y(0) - y(b.fresh)), fill: 'var(--s1)', rx: Math.min(1.5, w / 2) }));
      if (b.stale) { const y0 = y(b.fresh) - (b.fresh ? 2 : 0); g.append(s('rect', { x: bx, y: y0 - (y(0) - y(b.stale)), width: w, height: Math.max(.5, y(0) - y(b.stale)), fill: 'var(--s2)', rx: Math.min(1.5, w / 2) })); }
    });
    const hl = s('rect', { x: 0, y: m.t, width: bw, height: ph, fill: 'var(--ink)', opacity: 0, 'pointer-events': 'none' }); g.append(hl);
    const hit = s('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
    hit.addEventListener('mousemove', ev => {
      const r = g.getBoundingClientRect(), i = Math.min(N - 1, Math.max(0, Math.floor((ev.clientX - r.left - m.l) / bw))), b = bins[i];
      hl.setAttribute('x', m.l + i * bw); hl.setAttribute('opacity', .07);
      const t0 = i * T.bin_min, f = v => String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
      showTip(ev, [h('b', {}, `${f(t0)}–${f(t0 + T.bin_min)} IST`), trow('Live triggers', fmt(b.fresh)), trow('Stale (abstained)', fmt(b.stale)), trow('Published', fmt(b.published))]);
    });
    hit.addEventListener('mouseleave', () => { hl.setAttribute('opacity', 0); hideTip(); });
    g.append(hit);
    wrap.replaceChildren(g);
    list.replaceChildren(...evs.map((e, i) => h('div', { class: 'ev' }, h('span', { class: 'badge' }, i + 1), h('div', {}, h('b', {}, e.label), ' · ', h('span', { class: 'muted' }, ist(e.at, false)), h('div', { class: 'muted small' }, e.detail)))));
  };
  redraws.push(draw); requestAnimationFrame(draw);
  return [h('div', { class: 'card' }, h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--s1)' }), 'Live triggers'), h('span', {}, h('i', { style: 'background:var(--s2)' }), 'Stale offline-buffered (abstained)'), h('span', {}, h('i', { style: 'background:var(--band);border:1px solid var(--axis)' }), 'Surprise window')), wrap), list];
}

/* ================================ 00 overview ================================ */
function stagesData() {
  const S = OV.summary, oc = S.outcomes || {}, R = (OV.impact || {}).replay || {}, prim = (R.primary || {}).result, L = OV.latency || {};
  const judged = (oc.succeeded || 0) + (oc.failed || 0) + (oc.inconclusive || 0);
  const learn = Object.values(S.learnings || {}).reduce((a, n) => a + n, 0);
  return [
    { t: 'Understand', v: fmt(S.conflicts_logged), l: 'decisions resolved a source conflict, every fact cited with freshness', r: '#/viewers' },
    { t: 'Choose a goal', v: fmt(S.goals_committed), l: 'goals committed; unmeasurable goals excluded', r: '#/restraint' },
    { t: 'Decide', v: fmt(S.abstained), l: 'times the right call was to do nothing', r: '#/restraint' },
    { t: 'Verify', v: fmt(OV.checks.passed.length), l: `distinct independent checks; ${fmt(S.policy_problems)} policy problems in the simulator`, r: '#/verify' },
    { t: 'Act on time', v: ms((L.all_decisions || {}).p95_ms), l: 'p95 decision time, budget 60 s', r: '#/reliability' },
    { t: 'Close the loop', v: fmt(judged), l: `goals judged from attributable signals; ${fmt(learn)} learnings stored`, r: '#/viewers' },
    { t: 'Prove impact', v: prim ? pp(prim.diff) + ' pp' : '–', l: 'goal success vs randomised holdout', r: '#/impact' },
  ];
}
function orbit() {
  const st = stagesData(), n = st.length, R = 150, C = 200;
  const ang = i => (-90 + i * 360 / n) * Math.PI / 180;
  const nodes = st.map((x, i) => {
    const px = C + R * Math.cos(ang(i)), py = C + R * Math.sin(ang(i));
    const lx = C + (R + 34) * Math.cos(ang(i)), ly = C + (R + 34) * Math.sin(ang(i));
    const anchor = Math.abs(lx - C) < 12 ? 'middle' : lx > C ? 'start' : 'end';
    const g = s('g', { class: 'node', style: 'cursor:pointer', tabindex: 0, role: 'link', 'aria-label': x.t },
      s('circle', { cx: px, cy: py, r: 15 }),
      s('text', { class: 'n', x: px, y: py + 3.5, 'text-anchor': 'middle', text: '0' + (i + 1) }),
      s('text', { x: anchor === 'middle' ? lx : lx + (anchor === 'start' ? -6 : 6), y: ly + (ly > C ? 10 : 0), 'text-anchor': anchor, text: x.t }));
    g.addEventListener('click', () => { location.hash = x.r; });
    g.addEventListener('mouseenter', () => { stop(); show(i); });
    g.addEventListener('mouseleave', start);
    return g;
  });
  const pulse = s('circle', { r: 5, fill: 'var(--s2)', cx: C, cy: C - R });
  const svg = s('svg', { viewBox: '-70 -10 540 420', role: 'img', 'aria-label': 'The agent loop: seven stages with this run\'s numbers' },
    s('circle', { cx: C, cy: C, r: R, fill: 'none', stroke: 'var(--grid)', 'stroke-width': 2 }),
    s('circle', { cx: C, cy: C, r: R, fill: 'none', stroke: 'var(--brand)', 'stroke-width': 2, 'stroke-dasharray': '2 10', opacity: .5 }),
    nodes, pulse);
  const cv = h('div', { class: 'cv num' }), cl = h('div', { class: 'cl' }), ct = h('div', { class: 'ct' });
  const core = h('div', { class: 'core' }, ct, cv, cl);
  let cur = 0, timer = null, raf = null, a0 = 0;
  function show(i) {
    cur = i; nodes.forEach((g, j) => g.classList.toggle('on', j === i));
    ct.textContent = '0' + (i + 1) + ' · ' + st[i].t; cv.textContent = st[i].v; cl.textContent = st[i].l;
  }
  function animatePulse(target) {
    if (reduce) { pulse.setAttribute('cx', C + R * Math.cos(target)); pulse.setAttribute('cy', C + R * Math.sin(target)); return; }
    const from = a0, to = target < from ? target + 2 * Math.PI : target, t0 = performance.now();
    cancelAnimationFrame(raf);
    const step = now => { const k = Math.min(1, (now - t0) / 900), e = 1 - Math.pow(1 - k, 3), a = from + (to - from) * e;
      pulse.setAttribute('cx', C + R * Math.cos(a)); pulse.setAttribute('cy', C + R * Math.sin(a));
      if (k < 1) raf = requestAnimationFrame(step); else a0 = to % (2 * Math.PI); };
    raf = requestAnimationFrame(step);
  }
  function tick() { const i = (cur + 1) % n; show(i); animatePulse(ang(i)); }
  function start() { if (!reduce && !timer) timer = setInterval(tick, 2600); }
  function stop() { clearInterval(timer); timer = null; }
  a0 = ang(0); show(0); start();
  cleanups.push(() => { stop(); cancelAnimationFrame(raf); });
  return h('div', { class: 'orbit' }, svg, core);
}
function renderOverview() {
  const S = OV.summary, L = OV.latency || {}, R = (OV.impact || {}).replay || {}, prim = (R.primary || {}).result;
  const stories = OV.stories || [];
  return page(
    h('div', { class: 'hero' },
      h('div', {},
        h('div', { class: 'eyebrow' }, `Replay day ${OV.timeline.day || ''} · ${fmt(S.viewers)} viewers · ${fmt(S.triggers)} app opens`),
        h('h1', {}, 'One viewer. One agent. ', h('em', {}, 'Every decision on the record.')),
        h('p', { class: 'lede' }, 'A lifecycle agent for a regional-dialect streaming platform. On each app open it has seconds to pick one measurable goal, act only on evidence it can cite, get past an independent verifier — or deliberately do nothing. Then it proves, against a randomised holdout, whether any of it helped.'),
        h('div', { class: 'cta' }, h('a', { class: 'btn primary', href: '#/lab' }, 'Run the agent live →'), stories[0] ? h('a', { class: 'btn', href: `#/viewers/${stories[0].viewer}/${stories[0].decision || ''}` }, 'Walk one viewer') : null, h('a', { class: 'btn', href: '#/impact' }, 'See the impact'))),
      orbit()),
    h('div', { style: 'margin-top:34px' }, tiles([
      [fmt(S.triggers), 'app opens replayed'], [fmt(S.published), 'decisions published'], [fmt(S.abstained), 'deliberate no-actions, each with a reason'],
      [fmt(S.policy_problems), 'policy problems found by the simulator'], [ms((L.all_decisions || {}).p95_ms), 'p95 decision time (budget 60 s)'],
      [prim ? pp(prim.diff) + ' pp' : '–', 'goal success vs holdout' + (prim ? ` [${pp(prim.ci[0])}, ${pp(prim.ci[1])}]` : '')]])),
    section('Twelve moments worth inspecting', 'Each is a real viewer from this run, found automatically: one per surprise in the brief. Open any to see what the agent knew, decided and observed.',
      h('div', { class: 'tape' }, h('div', { class: 'hd' }, h('span', {}, 'moment'), h('span', {}, 'viewer · decision')),
        h('div', { class: 'rows' }, stories.map(st => h('a', { class: 'tr', href: `#/viewers/${st.viewer}/${st.decision || ''}` },
          h('b', { class: 'c1', style: 'grid-column:span 2' }, st.title), h('span', { class: 'c3 muted small' }, st.blurb), h('span', { class: 'c4 mono small muted', style: 'text-align:right' }, st.viewer + (st.decision ? ' · ' + st.decision : ''))))))),
    section('The day, as the agent saw it', 'Triggers per 10 minutes (IST). Stale offline-buffered app opens are kept apart from live traffic, so the morning backlog is never mistaken for the evening peak. Shaded windows are the injected surprises.', dayChart()),
    footer());
}

/* ================================ 01 restraint ================================ */
function renderRestraint() {
  const S = OV.summary;
  const ab = OV.abstain.map(([code, n]) => { const [label, sub] = reasonLabel(code); return { code, n, label, sub }; });
  const hold = ab.find(r => r.code === 'holdout_user'), judgement = ab.filter(r => r.code !== 'holdout_user'), jn = judgement.reduce((a, r) => a + r.n, 0);
  const acts = Object.entries(S.actions || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ code: k, n, label: ACTION[k] || k }));
  const R = (OV.impact || {}).replay || {}, pg = R.per_goal || {};
  const goals = Object.entries(pg).map(([k, v]) => ({ code: k, n: v.counts.agent.n, label: k })).sort((a, b) => b.n - a.n);
  const ex = OV.audit.goals_excluded || {};
  return page(header('01 · Decide & abstain', 'Doing nothing is a decision.', `${fmt(S.abstained)} of ${fmt(S.decisions)} decisions published nothing. ${hold ? fmt(hold.n) + ' were holdout viewers, who by design only get a shadow goal. ' : ''}The other ${fmt(jn)} were judgement calls, each recorded with a reason someone can check.`),
    h('div', { class: 'grid2 block' },
      h('div', { class: 'card' }, h('h3', {}, 'Why the agent chose not to act'), hbars(judgement, jn)),
      h('div', { class: 'card' }, h('h3', {}, 'What it did when it acted'), hbars(acts, acts.reduce((a, r) => a + r.n, 0)),
        h('p', { class: 'small muted', style: 'margin-top:14px' }, 'A home page is the default: it costs the viewer nothing. A message is planned only when the goal needs the viewer back on a later day — and only within consent, quiet hours (22:00–08:00) and one message per day.'))),
    section('One goal per viewer, chosen from evidence', 'Goals are eligible only when rules over cited facts say so; the model may pick among them but can never make a viewer eligible. Holdout viewers get the same goal from the same procedure, so the arms stay comparable.',
      h('div', { class: 'grid2' },
        h('div', { class: 'card' }, h('h3', {}, 'First committed goal, agent arm'), hbars(goals, goals.reduce((a, r) => a + r.n, 0))),
        h('div', { class: 'card' }, h('h3', {}, 'Goals the agent refuses to pursue'), h('p', { class: 'small muted', style: 'margin-top:0' }, 'A goal whose success can never be observed cannot be judged, so it is never selected.'),
          Object.entries(ex).map(([g, why]) => h('div', { class: 'msg' }, h('span', { class: 'chip crit' }, '✕ ' + g), ' ', why))))),
    footer());
}

/* ================================ 02 verify ================================ */
function renderVerify() {
  const S = OV.summary, failed = Object.fromEntries(OV.checks.failed), inj = OV.audit.injections || [];
  const rows = OV.checks.passed.filter(([k]) => CHECK[k]);
  const ms_ = Object.entries(S.model_status || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ code: k, n, label: MODEL[k] || k }));
  const rc = (OV.audit.rule_corrections || [])[0];
  return page(header('02 · Verification', 'A second opinion with veto power.', 'Every planned action is re-checked by a component that does not share the planner\'s reasoning and can disagree with it. Generated text is never evidence and never approval.'),
    h('div', { class: 'block' }, tiles([[fmt(S.policy_problems), 'policy problems reported by the outcome simulator'], [fmt(S.holdout_actions), 'actions sent to holdout viewers'], [fmt(inj.length), 'catalogue injections quarantined'], [fmt(S.max_model_calls) + ' / 8', 'max model calls in one decision'], [fmt(S.max_tool_calls) + ' / 20', 'max tool calls in one decision']])),
    h('div', { class: 'grid2 block' },
      h('div', { class: 'card' }, h('h3', {}, 'Checks, and how often each stopped a decision'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'Check'), h('th', { class: 'r' }, 'Passed'), h('th', { class: 'r' }, 'Stopped')),
        rows.map(([k, n]) => h('tr', {}, h('td', {}, CHECK[k], h('div', { class: 'muted mono small' }, k)), h('td', { class: 'r num' }, fmt(n)), h('td', { class: 'r num' }, fmt(failed[k] || 0))))))),
      h('div', {},
        h('div', { class: 'card' }, h('h3', {}, 'Instructions hidden in the catalogue'), h('p', { class: 'small muted', style: 'margin-top:0' }, 'Catalogue text is data. These titles were detected, quarantined and never recommended. Shown here as plain text; nothing was executed.'),
          inj.length ? inj.map(x => h('div', { style: 'margin-top:12px' }, h('div', { class: 'small', style: 'margin-bottom:6px' }, h('span', { class: 'chip crit' }, '✕ quarantined'), ' ', h('b', { class: 'mono' }, x.title_id), ' · ', (x.patterns || []).join(', ')), h('div', { class: 'quote' }, x.excerpt || ''))) : h('div', { class: 'muted' }, 'No injections detected.')),
        h('div', { class: 'card', style: 'margin-top:16px' }, h('h3', {}, 'What the model was allowed to do'), h('p', { class: 'small muted', style: 'margin-top:0' }, 'One advisory call: choose among goals the rules already found eligible. Anything else falls back to the rule choice.'), hbars(ms_, ms_.reduce((a, r) => a + r.n, 0))))),
    rc ? section('A goal rule corrected mid-replay', 'Only open goals of that type are re-pointed and versioned. Nothing else is reprocessed.', h('div', { class: 'card' }, h('div', { class: 'kv' },
      h('div', {}, 'Goal'), h('div', { class: 'mono' }, rc.goal_id), h('div', {}, 'At'), h('div', {}, ist(rc.at)), h('div', {}, 'New success rule'), h('div', { class: 'mono small' }, JSON.stringify(rc.new_success)), h('div', {}, 'Rule version'), h('div', { class: 'mono' }, rc.rule_version)))) : null,
    footer());
}

/* ================================ 03 impact ================================ */
function renderImpact() {
  const imp = OV.impact || {}, R = imp.replay || {}, P = imp.pilot || {}, prim = (R.primary || {}).result, c = (R.primary || {}).counts || {};
  const seeds = imp.seed_sensitivity || [];
  const rows = [{ head: 'Replay · agent vs randomised holdout' }];
  if (seeds.length) seeds.forEach((x, i) => rows.push({ label: i === 0 ? `Primary goal success · seed ${x.seed}` : `Same actions · simulator seed ${x.seed}`, r: x.result, kind: 'honest' }));
  else if (prim) rows.push({ label: 'Primary goal success', r: prim, kind: 'honest' });
  if (R.secondary && R.secondary.play_on_3plus_days) rows.push({ label: 'Played on 3+ days (14-day, goal-agnostic)', r: R.secondary.play_on_3plus_days.result, kind: 'honest' });
  rows.push({ head: 'The trap · comparisons that select engaged viewers' });
  if (R.naive_exposed_vs_rest) rows.push({ label: 'Replay: saw a personalised page vs everyone else', r: R.naive_exposed_vs_rest.result, kind: 'biased' });
  if (P.naive) rows.push({ label: 'Pilot report: served vs everyone else', r: P.naive.result, kind: 'biased' });
  if (P.itt) rows.push({ label: 'Pilot re-analysed: randomised ITT', r: P.itt.result, kind: 'honest' });
  const vals = rows.filter(r => r.r).flatMap(r => [r.r.ci[0], r.r.ci[1]]);
  const dom = [Math.floor(Math.min(-.05, ...vals) * 20) / 20, Math.ceil(Math.max(.05, ...vals) * 20) / 20];
  function strip(r, kind, axis) {
    const wrap = h('div', { class: 'strip chart' });
    const draw = () => {
      const W = Math.max(160, wrap.clientWidth), H = axis ? 44 : 30, m = 8, x = v => m + (v - dom[0]) / (dom[1] - dom[0]) * (W - 2 * m);
      const g = s('svg', { width: W, height: H });
      for (let t = dom[0]; t <= dom[1] + 1e-9; t += .05) { g.append(s('line', { x1: x(t), x2: x(t), y1: 0, y2: 30, stroke: 'var(--grid)' })); if (axis) g.append(s('text', { class: 'tick', x: x(t), y: 42, 'text-anchor': 'middle', text: (t > 0 ? '+' : '') + Math.round(t * 100) + ' pp' })); }
      g.append(s('line', { x1: x(0), x2: x(0), y1: 0, y2: 30, stroke: 'var(--axis)', 'stroke-width': 1.5 }));
      if (r) { const col = kind === 'biased' ? 'var(--s2)' : 'var(--s1)';
        g.append(s('line', { x1: x(r.ci[0]), x2: x(r.ci[1]), y1: 15, y2: 15, stroke: col, 'stroke-width': 2, 'stroke-linecap': 'round' }));
        g.append(s('circle', { cx: x(r.diff), cy: 15, r: 5.5, fill: col, stroke: 'var(--surface)', 'stroke-width': 2 })); }
      wrap.replaceChildren(g);
    };
    redraws.push(draw); requestAnimationFrame(draw);
    return wrap;
  }
  const forest = h('div', { class: 'forest' }, rows.map(row => row.head ? h('div', { class: 'fr head' }, h('div', {}, row.head), h('div', {}), h('div', {})) :
    hover(h('div', { class: 'fr' }, h('div', { class: 'lab' }, row.label, row.kind === 'biased' ? h('span', { class: 'tag biased' }, 'biased') : null), strip(row.r, row.kind), h('div', { class: 'val num' }, ci(row.r))),
      () => [h('b', {}, row.label), trow('difference', pp(row.r.diff) + ' pp'), trow('95% CI', `${pp(row.r.ci[0])} to ${pp(row.r.ci[1])} pp`), row.r.p_value != null ? trow('p', row.r.p_value < .001 ? '< 0.001' : row.r.p_value.toFixed(3)) : null])),
    h('div', { class: 'fr' }, h('div', { class: 'small muted' }, 'Difference in success rate, 95% CI'), strip(null, null, true), h('div', {})));
  const g = R.per_goal || {}, sec = R.secondary || {};
  const NAMES = { any_play: 'Any play', any_completion: 'Any completed episode', paid_purchase: 'Paid purchase', play_on_3plus_days: 'Played on 3+ days' };
  const naive = P.naive;
  return page(header('03 · Impact', 'Did it help? Ask the holdout.', prim && c.agent ? `Primary metric: success of each viewer's first committed goal. Agent ${pct(c.agent.succeeded, c.agent.n)} (${c.agent.succeeded}/${c.agent.n}) vs holdout ${pct(c.holdout.succeeded, c.holdout.n)} (${c.holdout.succeeded}/${c.holdout.n}). The interval ${prim.ci[0] > 0 ? 'excludes' : 'touches or includes'} zero, and re-running the simulator with other seeds moves it — the honest reading is "small, positive, uncertain".` : ''),
    h('div', { class: 'card block' }, h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--s1)' }), 'Randomised comparison (intention-to-treat)'), h('span', {}, h('i', { style: 'background:var(--s2)' }), 'Selection-biased comparison, shown to explain why it misleads')), forest),
    naive && P.itt ? h('div', { class: 'callout' }, h('b', {}, 'Why the pilot report\'s headline is wrong. '), `It compared the ${fmt(naive.served[0])} served viewers (${pct(naive.served[1], naive.served[0])} success) with everyone else (${pct(naive.others[1], naive.others[0])}): ${ci(naive.result)}. Being served was not random — it depended on the agent choosing to act and the viewer coming back, so the served group was already more engaged. The randomised comparison of the same pilot is ${ci(P.itt.result)}.`) : null,
    h('div', { class: 'grid2 block' },
      h('div', { class: 'card' }, h('h3', {}, 'By goal (first committed goal)'), h('p', { class: 'small muted', style: 'margin-top:0' }, 'Small cells: descriptive, not separate claims.'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'Goal'), h('th', { class: 'r' }, 'Agent'), h('th', { class: 'r' }, 'Holdout'), h('th', { class: 'r' }, 'Difference')),
        Object.entries(g).map(([k, v]) => { const a = v.counts.agent, b = v.counts.holdout; return h('tr', {}, h('td', { class: 'mono' }, k), h('td', { class: 'r num' }, pct(a.succeeded, a.n), ' ', h('span', { class: 'muted small' }, `${a.succeeded}/${a.n}`)), h('td', { class: 'r num' }, b.n ? [pct(b.succeeded, b.n), ' ', h('span', { class: 'muted small' }, `${b.succeeded}/${b.n}`)] : '–'), h('td', { class: 'r num small' }, v.result && a.n && b.n ? ci(v.result) : 'n/a')); })))),
      h('div', { class: 'card' }, h('h3', {}, 'Goal-agnostic outcomes, 14 days'), h('p', { class: 'small muted', style: 'margin-top:0' }, 'All triggered viewers, independent of goal logic.'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'Metric'), h('th', { class: 'r' }, 'Agent'), h('th', { class: 'r' }, 'Holdout'), h('th', { class: 'r' }, 'Difference')),
        Object.entries(sec).map(([k, v]) => h('tr', {}, h('td', {}, NAMES[k] || k), h('td', { class: 'r num' }, pct(v.agent[0], v.agent[1])), h('td', { class: 'r num' }, pct(v.holdout[0], v.holdout[1])), h('td', { class: 'r num small' }, ci(v.result)))))))),
    footer());
}

/* ================================ 04 reliability ================================ */
function renderReliability() {
  const L = OV.latency || {}, a = L.all_decisions || {}, W = L.windows || {}, S = OV.summary;
  const NAME = k => k.startsWith('dependency_unavailable') ? 'Model provider down (HTTP 503)' : k.startsWith('dependency_degraded') ? 'Data store degraded' : k.startsWith('traffic_peak') ? 'Evening peak (live traffic)' : k.startsWith('offline_backlog') ? 'Offline backlog burst' : k;
  const hist = h('div', { class: 'chart' });
  const drawHist = () => {
    const rows = (OV.latency_hist || []).filter((b, i, arr) => b.n || i < arr.length - 1); if (!rows.length) return;
    const Wd = Math.max(280, hist.clientWidth), H = 230, m = { l: 44, r: 8, t: 12, b: 34 }, pw = Wd - m.l - m.r, ph = H - m.t - m.b;
    const max = Math.max(...rows.map(b => b.n), 1), step = max > 1000 ? 500 : max > 400 ? 200 : 100, top = Math.ceil(max / step) * step, bw = pw / rows.length, y = v => m.t + ph - v / top * ph;
    const g = s('svg', { width: Wd, height: H, role: 'img', 'aria-label': 'Histogram of decision times' });
    for (let v = 0; v <= top; v += step) { g.append(s('line', { x1: m.l, x2: Wd - m.r, y1: y(v), y2: y(v), stroke: v ? 'var(--grid)' : 'var(--axis)' })); g.append(s('text', { class: 'tick', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', text: fmt(v) })); }
    rows.forEach((b, i) => { const bx = m.l + i * bw + 2, w = Math.max(2, bw - 4), lab = b.hi == null ? `${b.lo}+` : `${b.lo}–${b.hi}`;
      const hit = s('rect', { x: m.l + i * bw, y: m.t, width: bw, height: ph, fill: 'transparent' });
      hit.addEventListener('mousemove', ev => showTip(ev, [h('b', {}, lab + ' ms'), trow('decisions', fmt(b.n))])); hit.addEventListener('mouseleave', hideTip);
      g.append(s('rect', { x: bx, y: y(b.n), width: w, height: Math.max(0, y(0) - y(b.n)), fill: 'var(--s1)', rx: Math.min(4, w / 2) }), s('text', { class: 'tick', x: m.l + i * bw + bw / 2, y: H - 16, 'text-anchor': 'middle', text: lab }), hit); });
    g.append(s('text', { class: 'tick', x: Wd - m.r, y: H - 2, 'text-anchor': 'end', text: 'milliseconds' }));
    hist.replaceChildren(g);
  };
  redraws.push(drawHist); requestAnimationFrame(drawHist);
  return page(header('04 · Reliability', 'On time, even when things break.', `p50 ${ms(a.p50_ms)}, p95 ${ms(a.p95_ms)}, slowest ${ms(a.max_ms)} against a 60-second budget — ${fmt(a.over_60s)} decisions over it. Duplicates are idempotent, a model outage falls back to rules, and a slow data store times out at 800 ms and fails closed.`),
    h('div', { class: 'block' }, tiles([[ms(a.p50_ms), 'median decision'], [ms(a.p95_ms), 'p95 decision'], [ms(a.max_ms), 'slowest decision'], [fmt(a.over_60s), 'over the 60 s budget'], [fmt(S.fallbacks), 'safe fallbacks to rules']])),
    h('div', { class: 'grid2 block' }, h('div', { class: 'card' }, h('h3', {}, 'Decision time, all decisions'), hist),
      h('div', { class: 'card' }, h('h3', {}, 'Under stress'), h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('tr', {}, h('th', {}, 'Window'), h('th', { class: 'r' }, 'n'), h('th', { class: 'r' }, 'p95'), h('th', { class: 'r' }, 'max'), h('th', { class: 'r' }, '> 60 s')),
        h('tr', {}, h('td', {}, 'All decisions'), h('td', { class: 'r num' }, fmt(a.n)), h('td', { class: 'r num' }, ms(a.p95_ms)), h('td', { class: 'r num' }, ms(a.max_ms)), h('td', { class: 'r num' }, fmt(a.over_60s))),
        Object.entries(W).map(([k, v]) => h('tr', {}, h('td', {}, NAME(k), h('div', { class: 'muted small mono' }, k)), h('td', { class: 'r num' }, fmt(v.n)), h('td', { class: 'r num' }, ms(v.p95_ms)), h('td', { class: 'r num' }, ms(v.max_ms)), h('td', { class: 'r num' }, fmt(v.over_60s)))))))),
    section('The day, with every surprise marked', null, dayChart()),
    h('p', { class: 'small muted', style: 'margin-top:16px' }, L.definition || ''),
    footer());
}

/* ================================ 05 viewers ================================ */
let VQ = { q: '', arm: '', status: '', reason: '', outcome: '', conflict: false, learned: false, offset: 0 };
function renderViewers() {
  const tbody = h('tbody'), info = h('span', {}), pager = h('div', { class: 'pager' });
  const reasons = OV.abstain.map(([c]) => c);
  const sel = (key, opts, label) => h('label', { class: 'f' }, label, h('select', { onchange: e => { VQ[key] = e.target.value; VQ.offset = 0; load(); } }, opts.map(([v, t]) => { const o = h('option', { value: v }, t); if (VQ[key] === v) o.selected = true; return o; })));
  const chk = (key, label) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', style: 'height:auto', checked: VQ[key] || null, onchange: e => { VQ[key] = e.target.checked; VQ.offset = 0; load(); } }), label);
  let qt;
  async function load() {
    const p = new URLSearchParams({ q: VQ.q, arm: VQ.arm, status: VQ.status, reason: VQ.reason, outcome: VQ.outcome, conflict: VQ.conflict, learned: VQ.learned, offset: VQ.offset, limit: 25 });
    let res; try { res = await api('/api/viewers?' + p); } catch (e) { tbody.replaceChildren(h('tr', {}, h('td', { colspan: 7 }, 'Could not load: ' + e.message))); return; }
    tbody.replaceChildren(...res.rows.map(r => h('tr', { class: 'link', onclick: () => { location.hash = '#/viewers/' + r.viewer_id; } },
      h('td', { class: 'mono' }, h('a', { href: '#/viewers/' + r.viewer_id }, r.viewer_id)), h('td', {}, h('span', { class: 'chip ' + r.arm }, r.arm)),
      h('td', { class: 'r num' }, `${r.published}/${r.decisions}`), h('td', { class: 'small' }, r.actions.map(a => ACTION[a] || a).join(', ') || '—'),
      h('td', { class: 'mono small' }, r.goal || '—'), h('td', {}, r.outcome ? h('span', { class: 'chip ' + ({ succeeded: 'good', failed: 'crit', inconclusive: 'warn' }[r.outcome]) }, r.outcome) : '—'),
      h('td', { class: 'small muted' }, r.reasons.map(x => reasonLabel(x)[0]).join(', ') || '—'))));
    info.textContent = res.total ? `${VQ.offset + 1}–${Math.min(res.total, VQ.offset + 25)} of ${fmt(res.total)}` : 'no viewers match';
    pager.replaceChildren(info, h('button', { class: 'ghost', disabled: VQ.offset === 0 || null, onclick: () => { VQ.offset = Math.max(0, VQ.offset - 25); load(); } }, '← Prev'), h('button', { class: 'ghost', disabled: VQ.offset + 25 >= res.total || null, onclick: () => { VQ.offset += 25; load(); } }, 'Next →'));
  }
  load();
  return page(header('05 · Viewers', 'Walk any viewer from app open to judged outcome.', 'Start from a story, or filter the whole run. Every viewer page has an "as of" slider: what the agent knew, decided and observed at any moment.'),
    h('div', { class: 'stories block' }, (OV.stories || []).map(st => h('a', { class: 'story', href: `#/viewers/${st.viewer}/${st.decision || ''}` }, h('b', {}, st.title), h('span', {}, st.blurb), h('div', { class: 'who' }, st.viewer + (st.decision ? ' · ' + st.decision : ''))))),
    h('div', { class: 'filters' },
      h('label', { class: 'f', style: 'flex:1;min-width:180px' }, 'Search', h('input', { type: 'search', placeholder: 'Viewer id, e.g. U-02344', value: VQ.q, oninput: e => { clearTimeout(qt); qt = setTimeout(() => { VQ.q = e.target.value; VQ.offset = 0; load(); }, 200); } })),
      sel('arm', [['', 'Any'], ['agent', 'Agent'], ['holdout', 'Holdout']], 'Arm'),
      sel('status', [['', 'Any'], ['published', 'Acted'], ['abstained', 'Never acted']], 'Acted?'),
      sel('reason', [['', 'Any'], ...reasons.map(r => [r, reasonLabel(r)[0]])], 'No-action reason'),
      sel('outcome', [['', 'Any'], ['succeeded', 'Succeeded'], ['failed', 'Failed'], ['inconclusive', 'Inconclusive']], 'Outcome'),
      chk('conflict', 'Dialect conflict'), chk('learned', 'Has learnings')),
    h('div', { class: 'card', style: 'padding:6px 12px' }, h('div', { class: 'scroll' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Viewer'), h('th', {}, 'Arm'), h('th', { class: 'r' }, 'Acted'), h('th', {}, 'Actions'), h('th', {}, 'Goal'), h('th', {}, 'Outcome'), h('th', {}, 'No-action reasons'))), tbody))),
    pager, footer());
}

/* decision rendering, shared by the viewer page and the live lab */
function titleChip(tid, titles) { const t = (titles || {})[tid]; return h('span', { class: 'tt', title: t ? `${tid} · ${t.dialect} · ${t.language} · ${(t.genres || []).join(', ')}` : tid }, t && t.title ? t.title : tid); }
function ul(items) { return h('ul', {}, items.map(x => h('li', {}, x))); }
function decisionBody(d, acts, cancelled, titles) {
  const kv = h('div', { class: 'kv' }), add = (k, ...v) => kv.append(h('div', {}, k), h('div', {}, ...v));
  if (d.no_action_reason) { const [l, sub] = reasonLabel(d.no_action_reason); add('Why nothing', h('b', {}, l), sub ? ` — ${sub}` : '', h('div', { class: 'mono small muted' }, d.no_action_reason)); }
  if (d.goal) add('Goal', h('b', { class: 'mono' }, d.goal.goal_id), ` ${d.goal.id} · ${d.goal.committed}${d.goal.shadow ? ' (shadow, holdout)' : ''}`, h('div', { class: 'small muted' }, `judged by ${d.goal.success_signal} before ${ist(d.goal.deadline)}`));
  if (d.dialect) add('Dialect', h('b', {}, d.dialect.used || 'unresolved'), ` from ${d.dialect.source}`, d.dialect.conflicts.length ? h('div', { class: 'small' }, h('span', { class: 'chip warn' }, '⚠ conflict'), ' ', d.dialect.conflicts.join(', '), ' — the app setting wins: it is what the viewer will actually see') : null);
  if (d.confidence != null) add('Confidence', h('span', { class: 'conf' }, h('i', { style: `width:${d.confidence * 100}%` })), h('b', { class: 'num' }, d.confidence.toFixed(2)), h('div', { class: 'small muted' }, d.confidence_reason || ''));
  add('Model', `${MODEL[d.model_status] || d.model_status}${d.fallback_used ? ' → deterministic rules' : ''} · ${d.model_calls} model / ${d.tool_calls} tool calls`);
  if (d.model_fault) add('Injected fault', h('span', { class: 'chip crit' }, '✕ ' + d.model_fault.scheduled), ' ', d.model_fault.handling);
  if (d.checks.failed.length) add('Checks failed', d.checks.failed.map(f => h('span', { class: 'chip crit', style: 'margin:0 4px 4px 0' }, '✕ ' + f)));
  const body = h('div', { class: 'body' }, kv);
  (acts || []).forEach(a => {
    if (a.type === 'home_page') body.append(h('div', { class: 'hp' }, h('div', { class: 'small muted' }, `Home page ${a.action_id || ''} · ${a.dialect} · live 2 h`), a.hero_title_id ? h('div', { class: 'hero-t' }, 'Hero: ', titleChip(a.hero_title_id, titles)) : null,
      (a.rows || []).map(r => h('div', { class: 'row' }, h('span', { class: 'rt' }, r.row_type + (r.genre ? ':' + r.genre : '')), r.title_ids.map(t => titleChip(t, titles))))));
    else body.append(h('div', { class: 'msg' }, h('div', { class: 'small muted' }, `${ACTION[a.type] || a.type} ${a.action_id || ''} · scheduled ${ist(a.send_at)}`),
      a.text ? h('div', {}, h('b', {}, a.text.title), h('div', {}, a.text.body)) : h('div', {}, `template ${a.template_id} · `, JSON.stringify(a.variables || {})), a.title_id ? h('div', { class: 'small muted', style: 'margin-top:4px' }, 'promotes ', titleChip(a.title_id, titles)) : null));
  });
  (cancelled || []).forEach(c => body.append(h('div', { class: 'msg' }, h('span', { class: 'chip crit' }, '✕ cancelled'), ` ${c.type} ${c.action_id} at ${ist(c.at)}: ${c.reason}`)));
  body.append(h('details', {}, h('summary', {}, `Evidence (${d.evidence.length}), assumptions (${d.assumptions.length}), checks (${d.checks.passed.length} passed)`),
    h('div', { class: 'small muted', style: 'margin-top:6px' }, 'Evidence'), ul(d.evidence),
    d.assumptions.length ? [h('div', { class: 'small muted' }, 'Assumptions'), ul(d.assumptions)] : null,
    h('div', { class: 'small muted' }, 'Checks passed'), h('div', { class: 'small mono' }, d.checks.passed.join(' · ')),
    d.notes.length ? [h('div', { class: 'small muted', style: 'margin-top:6px' }, 'Notes'), ul(d.notes)] : null),
    h('details', {}, h('summary', {}, 'Raw decision JSON'), h('pre', { class: 'raw' }, JSON.stringify(d, null, 1))));
  return body;
}
function decisionTop(d) {
  const pub = d.status === 'PUBLISHED';
  return h('div', { class: 'top' }, h('span', { class: 'when' }, ist(d.trigger.deliver_at)), h('span', { class: 'mono' }, d.decision_id),
    h('span', {}, `${d.trigger.event}${d.trigger.event_age_s ? ' · age ' + age(d.trigger.event_age_s) : ''}`),
    h('span', { class: 'chip ' + (pub ? 'pub' : 'abs') }, pub ? '● ' + d.action : '○ NO ACTION'), h('span', { class: 'num' }, ms(d.decided_in_ms)));
}

async function renderViewer(uid, focusId) {
  let v;
  try { v = await api('/api/viewers/' + encodeURIComponent(uid)); }
  catch (e) { return page(h('a', { href: '#/viewers' }, '← All viewers'), h('div', { class: 'empty block' }, e.status === 404 ? `No decisions for ${uid} in this run.` : 'Could not load: ' + e.message)); }
  const items = [];
  v.decisions.forEach(d => {
    const acts = v.actions.filter(a => a.decision_id === d.decision_id);
    const canc = (v.cancelled || []).filter(c => d.actions.some(x => x.action_id === c.action_id) && !acts.some(a => a.action_id === c.action_id));
    items.push({ t: d.trigger.deliver_at, id: d.decision_id, el: h('div', { class: 'item' + (d.status === 'PUBLISHED' ? ' pub' : '') }, decisionTop(d), decisionBody(d, acts, canc, v.titles)) });
  });
  (v.revisions || []).forEach(r => items.push({ t: r.at, el: h('div', { class: 'item k-revision' }, h('div', { class: 'top' }, h('span', { class: 'when' }, ist(r.at)), h('span', {}, r.kind.replace(/_/g, ' ')), h('span', { class: 'chip' }, 'revision')), h('div', { class: 'body small' }, r.detail)) }));
  v.outcomes.forEach(o => { const cls = { succeeded: 'good', failed: 'crit', inconclusive: 'warn' }[o.status], ic = { succeeded: '✓', failed: '✕', inconclusive: '?' }[o.status];
    items.push({ t: o.deadline, el: h('div', { class: 'item k-outcome' }, h('div', { class: 'top' }, h('span', { class: 'when' }, ist(o.deadline)), h('span', {}, 'outcome judged'), h('span', { class: 'chip ' + cls }, `${ic} ${o.status}`), o.shadow ? h('span', { class: 'chip holdout' }, 'shadow goal') : null),
      h('div', { class: 'body' }, h('div', { class: 'kv' }, h('div', {}, 'Goal'), h('div', {}, h('b', { class: 'mono' }, o.goal_id), ` ${o.goal} · from ${o.decision_id}`), h('div', {}, 'Window'), h('div', {}, `${ist(o.start)} → ${ist(o.deadline)}`),
        h('div', {}, 'Signal'), h('div', {}, `${o.success_signal} (rule ${o.rule_version}${o.revised ? ', corrected mid-replay' : ''})`), h('div', {}, 'Attributed by'), h('div', {}, o.evidence && o.evidence.length ? o.evidence.map(e => h('div', { class: 'mono small' }, 'event:' + e)) : (o.reason || '—'))))) }); });
  (v.learnings || []).forEach(x => items.push({ t: x.at, el: h('div', { class: 'item k-learning' }, h('div', { class: 'top' }, h('span', { class: 'when' }, ist(x.at)), h('span', {}, 'learned'), h('span', { class: 'chip good' }, '✓ ' + (x.kind || 'learning') + (x.shadow ? ' (shadow)' : ''))), h('div', { class: 'body small' }, x.learning + (x.evidence && x.evidence.length ? ' · ' + x.evidence.join(', ') : ''))) }));
  items.sort((a, b) => new Date(a.t) - new Date(b.t));
  const F = v.facts || {}, ws = F.watch_summary;
  const asof = h('span', {}), asofn = h('div', { class: 'small muted' });
  const range = h('input', { type: 'range', min: 0, max: Math.max(0, items.length - 1), value: items.length - 1, 'aria-label': 'Show the agent\'s view as of this moment' });
  const upd = () => { const k = +range.value; items.forEach((it, i) => it.el.classList.toggle('future', i > k)); asof.textContent = items[k] ? ist(items[k].t) : '–';
    const seen = items.slice(0, k + 1).map(i => i.el.className); asofn.textContent = `${seen.filter(c => c.includes('item') && !c.includes('k-')).length} decisions, ${seen.filter(c => c.includes('k-outcome')).length} outcomes, ${seen.filter(c => c.includes('k-learning')).length} learnings so far`; };
  range.addEventListener('input', upd); upd();
  const p = page(h('a', { href: '#/viewers', class: 'small' }, '← All viewers'),
    h('div', { class: 'vpanel', style: 'margin-top:14px' },
      h('div', { class: 'vside' },
        h('div', { class: 'card' }, h('div', { class: 'vhead' }, h('span', { class: 'id' }, uid), h('span', { class: 'chip ' + v.arm }, v.arm === 'agent' ? 'agent arm' : 'holdout arm')),
          h('div', { class: 'small muted' }, `profile: ${v.profile_source || 'none (consent fails closed)'}`),
          v.event_summary ? h('div', { class: 'small muted' }, `${fmt(v.event_summary.events_known)} events known`) : null,
          ws ? h('div', { class: 'small muted' }, `${ws.plays} plays · ${ws.completions} completions · ${ws.play_days_last_14} play days in last 14 · top genre ${ws.top_genre || '—'}`) : null,
          h('a', { class: 'btn', style: 'margin-top:12px;height:34px', href: '#/lab?viewer=' + uid }, 'Run this viewer live →')),
        h('div', { class: 'card scrub' }, h('div', { class: 'small' }, h('b', {}, 'As of '), asof), range, asofn),
        h('div', { class: 'card' }, h('h3', {}, 'What the agent knew (last resolution)'), h('table', { class: 'facts' }, Object.entries(F).filter(([k]) => k !== 'watch_summary').map(([k, f]) => h('tr', {}, h('td', {}, k.replace(/_/g, ' ')),
          h('td', {}, h('b', {}, f.value == null ? '—' : String(f.value).length > 24 ? String(f.value).slice(0, 19).replace('T', ' ') : String(f.value)), h('span', { class: 'src' }, `${f.source}${f.freshness_s != null ? ' · ' + age(f.freshness_s) + ' old' : ''}`),
            f.conflicts && f.conflicts.length ? h('span', { class: 'src', style: 'color:var(--crit)' }, 'conflicts: ' + f.conflicts.join(', ')) : null)))))),
      h('div', { class: 'tl' }, items.map(i => i.el))), footer());
  if (focusId) { const f = items.find(i => i.id === focusId); if (f) { f.el.classList.add('focus'); const det = f.el.querySelector('details'); if (det) det.open = true; setTimeout(() => f.el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }), 80); } }
  return p;
}

/* ================================ 06 live lab ================================ */
let LAB = null;   // unlock payload
let RUNTITLES = {};
const LABSTATE = { scenario: 'normal', viewer: '', at: '19:30', dialect: '', offline_hours: 6, burst_size: 300 };
function renderLock(msg) {
  const input = h('input', { type: 'password', placeholder: 'Access code', autocomplete: 'off', 'aria-label': 'Access code' }), err = h('div', { class: 'err' }, msg || '');
  const live = HEALTH && HEALTH.live;
  const form = h('form', { onsubmit: async e => { e.preventDefault(); CODE = input.value.trim(); err.textContent = 'checking…';
    try { LAB = await api('/api/live/unlock', { method: 'POST' }); store.set('oua-code', CODE, true); markLab(); route(); }
    catch (ex) { CODE = ''; err.textContent = ex.status === 401 ? 'That code was not accepted.' : ex.message; } } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Unlock'));
  return page(h('div', { class: 'lock' }, h('div', { class: 'eyebrow' }, '06 · Live lab'), h('h1', { style: 'font-size:36px' }, 'Run the real agent.'),
    h('p', { class: 'lede', style: 'margin:0 auto' }, 'Pick a viewer, fire an app open, inject a surprise from the brief, and watch the same decide() that produced the replay run on the server — idempotency, sources, goal, verifier and all.'),
    h('div', { class: 'card', style: 'margin-top:24px;text-align:left' },
      live && !live.enabled ? h('div', {}, h('b', {}, 'The live lab is not enabled on this server.'), h('p', { class: 'small muted' }, live.reason || '')) :
        [h('b', {}, 'Access code required'), h('p', { class: 'small muted', style: 'margin:4px 0 0' }, 'Running the agent uses the data pack, so it is gated. The results pages are public.'), form, err])));
}
function pipeline(d) {
  const STOP = { duplicate_event_id: 0, stale_offline_buffered_trigger: 0, app_dialect_unresolved: 1, app_dialect_missing_no_displayable_page: 3, no_eligible_goal: 2, personalised_page_already_live: 3, holdout_user: 4, budget_exceeded: 5, no_valid_intervention: 3 };
  const reason = d.no_action_reason, stopAt = reason ? (reason.startsWith('verifier_veto') ? 4 : (STOP[reason] ?? 5)) : null;
  const cells = [
    ['Trigger', `${d.trigger.event}${d.trigger.event_age_s ? ' · ' + age(d.trigger.event_age_s) + ' old' : ' · fresh'}`],
    ['Understand', d.dialect ? `dialect ${d.dialect.used || '?'} (${d.dialect.source})${d.dialect.conflicts.length ? ' · ' + d.dialect.conflicts.length + ' conflict(s)' : ''}` : 'stopped before facts'],
    ['Goal', d.goal ? `${d.goal.goal_id} ${d.goal.committed}` : 'none'],
    ['Decide', d.actions.length ? d.actions.map(a => ACTION[a.type] || a.type).join(' + ') : (reason ? reasonLabel(reason)[0] : 'nothing')],
    ['Verify', `${d.checks.passed.length} passed${d.checks.failed.length ? ' · ' + d.checks.failed.length + ' failed' : ''}`],
    [d.status === 'PUBLISHED' ? 'Published' : 'Abstained', `${ms(d.decided_in_ms)} · ${d.model_calls} model / ${d.tool_calls} tool`],
  ];
  const els = cells.map(([t, v], i) => h('div', { class: 'stage' }, h('div', { class: 'sn' }, '0' + (i + 1)), h('div', { class: 'st' }, t), h('div', { class: 'sv' }, v)));
  const last = stopAt == null ? 5 : stopAt;
  els.forEach((e, i) => { const lit = () => { if (i <= last || i === 5) e.classList.add('lit', (i === stopAt || (i === 5 && stopAt != null)) ? 'stop' : 'ok'); };
    if (reduce) lit(); else { const t = setTimeout(lit, 140 * i); cleanups.push(() => clearTimeout(t)); } });
  return h('div', { class: 'pipe' }, els);
}
function stepView(st) {
  if (!st.decision) return h('div', { class: 'card' }, h('div', { class: 'steplabel' }, st.label),
    st.event ? h('div', { class: 'small' }, `${st.event.event} · ${ist(st.event.received_at)} · `, h('span', { class: 'mono' }, JSON.stringify(st.event.properties))) : null,
    st.revisions.length ? st.revisions.map(r => h('div', { class: 'msg' }, h('span', { class: 'chip brand' }, r.kind.replace(/_/g, ' ')), ' ', r.detail)) : h('div', { class: 'small muted', style: 'margin-top:6px' }, 'State updated; no goal or queued action needed changing.'),
    st.active_goal ? h('div', { class: 'small muted', style: 'margin-top:6px' }, `active goal ${st.active_goal.goal_id}: ${st.active_goal.status}`) : null);
  const d = st.decision;
  return h('div', { class: 'card' }, h('div', { class: 'steplabel' }, st.label), pipeline(d), decisionTop(d), decisionBody(d, st.actions, [], RUNTITLES),
    st.revisions.length ? st.revisions.map(r => h('div', { class: 'msg' }, h('span', { class: 'chip brand' }, r.kind.replace(/_/g, ' ')), ' ', r.detail)) : null);
}
function burstView(b) {
  const wrap = h('div', { class: 'chart' });
  const draw = () => { const W = Math.max(280, wrap.clientWidth), H = 200, m = { l: 44, r: 8, t: 10, b: 26 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
    const max = Math.max(...b.series.map(x => x.ms), 1), step = max > 2000 ? 1000 : max > 800 ? 200 : 100, top = Math.ceil(max / step) * step;
    const x = i => m.l + (i + .5) / b.series.length * pw, y = v => m.t + ph - v / top * ph;
    const g = s('svg', { width: W, height: H, role: 'img', 'aria-label': 'Decision time for each app open in the burst' });
    for (let v = 0; v <= top; v += step) { g.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: v ? 'var(--grid)' : 'var(--axis)' })); g.append(s('text', { class: 'tick', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', text: v })); }
    b.series.forEach(p => g.append(s('circle', { cx: x(p.i), cy: y(p.ms), r: 2.6, fill: 'var(--s1)', opacity: .85 })));
    g.append(s('text', { class: 'tick', x: m.l, y: H - 6, text: 'first app open' }), s('text', { class: 'tick', x: W - m.r, y: H - 6, 'text-anchor': 'end', text: 'last (60 s later)' }));
    const hit = s('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
    hit.addEventListener('mousemove', ev => { const r = g.getBoundingClientRect(), i = Math.max(0, Math.min(b.series.length - 1, Math.floor((ev.clientX - r.left - m.l) / pw * b.series.length))), p = b.series[i];
      showTip(ev, [h('b', {}, `app open #${i + 1}`), trow('decided in', ms(p.ms)), trow('queued', ms(p.queue)), trow('status', p.status)]); });
    hit.addEventListener('mouseleave', hideTip); g.append(hit); wrap.replaceChildren(g); };
  redraws.push(draw); requestAnimationFrame(draw);
  const outs = Object.entries(b.outcomes).map(([k, n]) => ({ code: k, n, label: REASON[k] ? REASON[k][0] : (ACTION[k.toLowerCase()] || k) }));
  return h('div', { class: 'card' }, h('div', { class: 'steplabel' }, `${b.n} app opens in ${b.window_s} s · ${b.workers} workers`),
    tiles([[ms(b.p50_ms), 'p50'], [ms(b.p95_ms), 'p95'], [ms(b.max_ms), 'slowest'], [fmt(b.over_60s), 'over 60 s']]),
    h('div', { style: 'margin-top:14px' }, h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--s1)' }), 'decision time per app open (ms)')), wrap),
    h('div', { style: 'margin-top:14px' }, h('h3', {}, 'What the agent did'), hbars(outs, b.n)));
}
function renderLab(params) {
  if (!LAB) return renderLock();
  if (params.viewer) LABSTATE.viewer = params.viewer;
  if (!LABSTATE.viewer) LABSTATE.viewer = LAB.suggestions[0] || '';
  const out = h('div', { class: 'steps' }, h('div', { class: 'empty' }, 'Choose a scenario and press Run. The agent runs on the server in an isolated sandbox; nothing touches the published replay.'));
  const explain = h('p', { class: 'small muted', style: 'margin:0' });
  const vcard = h('div', { class: 'vcard' });
  const vin = h('input', { value: LABSTATE.viewer, 'aria-label': 'Viewer id', oninput: e => { LABSTATE.viewer = e.target.value.trim().toUpperCase(); loadCard(); } });
  const offRow = h('label', { class: 'f' }, 'Hours buffered offline', h('input', { type: 'number', min: .25, max: 96, step: .25, value: LABSTATE.offline_hours, oninput: e => LABSTATE.offline_hours = +e.target.value }));
  const burstRow = h('label', { class: 'f' }, 'App opens in the minute', h('input', { type: 'number', min: 10, max: 600, step: 10, value: LABSTATE.burst_size, oninput: e => LABSTATE.burst_size = +e.target.value }));
  const vRow = h('label', { class: 'f' }, 'Viewer', h('div', { class: 'viewerline' }, vin, h('button', { class: 'ghost', type: 'button', title: 'Find a viewer for whom this scenario shows its effect', onclick: suggest }, 'Suggest')), vcard);
  const runBtn = h('button', { class: 'btn primary', type: 'button', onclick: run }, '▶ Run the agent');
  const scenBtns = LAB.scenarios.map(sc => h('button', { type: 'button', class: sc.id === LABSTATE.scenario ? 'on' : '', onclick: () => { LABSTATE.scenario = sc.id; sync(); } }, sc.title));
  function sync() {
    scenBtns.forEach((b, i) => b.classList.toggle('on', LAB.scenarios[i].id === LABSTATE.scenario));
    const sc = LAB.scenarios.find(x => x.id === LABSTATE.scenario); explain.textContent = sc ? sc.explain : '';
    offRow.style.display = LABSTATE.scenario === 'offline' ? '' : 'none';
    burstRow.style.display = LABSTATE.scenario === 'burst' ? '' : 'none';
    vRow.style.display = LABSTATE.scenario === 'burst' ? 'none' : '';
  }
  let ct;
  function loadCard() { clearTimeout(ct); ct = setTimeout(async () => { if (!LABSTATE.viewer) { vcard.textContent = ''; return; }
    try { const c = await api('/api/live/viewer/' + encodeURIComponent(LABSTATE.viewer));
      vcard.textContent = `${c.arm || 'no arm'} arm · ${c.has_profile ? 'status ' + c.subscription_status + ' · prefers ' + c.preferred_dialect : 'no profile row yet'} · app last set to ${c.last_app_dialect || '—'} · push ${c.push_opt_in === 'true' ? 'on' : 'off'} · WhatsApp ${c.whatsapp_opt_in === 'true' ? 'on' : 'off'} · ${c.events_in_history} events`; }
    catch (e) { vcard.textContent = e.status === 404 ? 'Unknown viewer' : e.message; } }, 250); }
  async function suggest() { vcard.textContent = 'finding a viewer where this scenario shows its effect…';
    try { const r = await api(`/api/live/suggest/${LABSTATE.scenario}?at=${encodeURIComponent(LABSTATE.at)}`); if (r.viewer_id) { LABSTATE.viewer = r.viewer_id; vin.value = r.viewer_id; loadCard(); } else vcard.textContent = 'no viewer needed'; }
    catch (e) { vcard.textContent = e.message; } }
  async function run() {
    runBtn.disabled = true; runBtn.textContent = 'Running…';
    out.replaceChildren(h('div', { class: 'empty' }, 'The agent is deciding…'));
    try {
      const body = { viewer_id: LABSTATE.viewer, scenario: LABSTATE.scenario, at: LABSTATE.at, dialect: LABSTATE.dialect, offline_hours: LABSTATE.offline_hours, burst_size: LABSTATE.burst_size };
      const r = await api('/api/live/run', { method: 'POST', body });
      const steps = r.steps || []; RUNTITLES = r.titles || {};
      const why = h('div', { class: 'why' }, h('b', {}, r.title), r.explain, r.notes && r.notes.length ? ul(r.notes) : null,
        r.rule_change ? h('div', { class: 'small' }, `Rule ${r.rule_change.goal_id}: ${JSON.stringify((r.rule_change.from || {}).event)} → ${JSON.stringify(r.rule_change.to.event)} (${r.rule_change.rule_version})`) : null,
        h('div', { class: 'small muted', style: 'margin-top:6px' }, `Simulated time ${ist(r.at)} · server compute ${r.server_ms} ms`));
      const curl = h('details', {}, h('summary', {}, 'Reproduce with the API'), h('pre', { class: 'curl' }, `curl -X POST ${location.origin}/api/live/run \\\n  -H "Content-Type: application/json" -H "X-Access-Code: $LIVE_ACCESS_CODE" \\\n  -d '${JSON.stringify(body)}'`), h('details', {}, h('summary', {}, 'Raw response'), h('pre', { class: 'raw' }, JSON.stringify(r, null, 1))));
      let main;
      if (r.burst) main = [burstView(r.burst), ...steps.map(stepView)];
      else if (r.scenario === 'learned_failure' && steps.length === 2) main = [h('div', { class: 'compare' }, steps.map(stepView))];
      else main = steps.map(stepView);
      out.replaceChildren(why, ...main, h('div', { class: 'card' }, curl));
    } catch (e) {
      if (e.status === 401) { CODE = ''; store.del('oua-code', true); LAB = null; markLab(); route(); return; }
      out.replaceChildren(h('div', { class: 'empty' }, 'Run failed: ' + e.message));
    } finally { runBtn.disabled = false; runBtn.textContent = '▶ Run the agent'; }
  }
  sync(); loadCard();
  return page(header('06 · Live lab', 'Fire an app open. Watch the agent decide.', `Each run builds a fresh, isolated agent on the server and calls the same decide() that produced the replay. Simulated clock: ${LAB.day} (IST).`),
    h('div', { class: 'lab block' },
      h('div', { class: 'controls' },
        h('div', { class: 'card' }, h('h3', {}, 'Scenario'), h('div', { class: 'scen' }, scenBtns), h('div', { style: 'margin-top:10px' }, explain)),
        h('div', { class: 'card', style: 'display:grid;gap:12px' }, vRow,
          h('div', { class: 'fieldrow' }, h('label', { class: 'f' }, 'Time (IST)', h('input', { type: 'time', value: LABSTATE.at, step: 60, oninput: e => LABSTATE.at = e.target.value || '19:30' })),
            h('label', { class: 'f' }, 'App dialect', h('select', { onchange: e => LABSTATE.dialect = e.target.value }, h('option', { value: '' }, 'as last set'), LAB.dialects.map(d => { const o = h('option', { value: d }, d); if (LABSTATE.dialect === d) o.selected = true; return o; })))),
          offRow, burstRow, runBtn,
          h('button', { class: 'ghost', type: 'button', onclick: () => { CODE = ''; LAB = null; store.del('oua-code', true); markLab(); route(); } }, 'Lock the lab'))),
      out), footer());
}

/* ================================ 07 api ================================ */
function renderApi() {
  const o = location.origin;
  const eps = [
    ['GET', '/api/health', 'Liveness, counts, and whether the live lab is enabled.'],
    ['GET', '/api/overview', 'Run summary: abstention reasons, checks, the day timeline, latency, impact, stories.'],
    ['GET', '/api/viewers?q=&arm=&status=&reason=&outcome=&conflict=&learned=&offset=&limit=', 'Filterable index of every viewer with a decision.'],
    ['GET', '/api/viewers/{viewer_id}', 'Everything about one viewer: decisions (full JSON), actions, outcomes, learnings, revisions, facts with provenance.'],
    ['GET', '/api/decisions/{decision_id}', 'One decision in the brief\'s machine-readable format.'],
    ['POST', '/api/live/unlock', 'Gated (X-Access-Code). Scenarios, suggested viewers, dialects.'],
    ['GET', '/api/live/viewer/{viewer_id}', 'Gated. A viewer\'s profile summary for the lab.'],
    ['GET', '/api/live/suggest/{scenario}?at=HH:MM', 'Gated. A viewer for whom that scenario shows its effect.'],
    ['POST', '/api/live/run', 'Gated. Body {viewer_id, scenario, at, dialect, offline_hours, burst_size}. Runs the real agent in a sandbox.'],
  ];
  return page(header('07 · API', 'Everything on this site is an API call.', 'Read endpoints are public and cached; live endpoints need the X-Access-Code header and are rate-limited.'),
    h('div', { class: 'card block' }, eps.map(([m, p, d]) => h('div', { class: 'ep' }, h('span', { class: 'm' }, m), h('code', {}, p), h('span', {}), h('span', { class: 'small muted' }, d)))),
    h('div', { class: 'grid2 block' },
      h('div', { class: 'card' }, h('h3', {}, 'Try it'), h('pre', { class: 'curl' }, `curl ${o}/api/decisions/D-0001\n\ncurl "${o}/api/viewers?outcome=succeeded&arm=agent&limit=5"`)),
      h('div', { class: 'card' }, h('h3', {}, 'Interactive docs'), h('p', { class: 'small muted', style: 'margin-top:0' }, 'OpenAPI schema with request and response models, generated by FastAPI.'), h('a', { class: 'btn', href: '/api/docs', target: '_blank', rel: 'noopener' }, 'Open /api/docs ↗'))),
    footer());
}

function footer() { return h('footer', { class: 'foot' }, `Every number is read from the replay output (${OV ? OV.run_dir : 'sample_run'}/) through the API — nothing on this site is typed in by hand. Synthetic data from the assignment pack. `, h('a', { href: '#/api' }, 'API'), ' · ', h('a', { href: '/api/docs' }, 'OpenAPI docs')); }

/* ================================ router ================================ */
function markLab() { const a = document.querySelector('.menu a.lab'); if (a) a.classList.toggle('unlocked', !!LAB); $('lockicon').title = LAB ? 'unlocked' : 'locked'; }
async function route() {
  resetPage();
  const raw = location.hash.replace(/^#\/?/, '') || 'overview';
  const [path, qs] = raw.split('?'), parts = path.split('/').filter(Boolean), params = Object.fromEntries(new URLSearchParams(qs || ''));
  const key = parts[0] || 'overview';
  document.querySelectorAll('.menu a').forEach(a => a.classList.toggle('on', a.dataset.r === key));
  const main = $('main');
  let node;
  try {
    if (!OV) OV = await api('/api/overview');
    if (key === 'overview') node = renderOverview();
    else if (key === 'restraint') node = renderRestraint();
    else if (key === 'verify') node = renderVerify();
    else if (key === 'impact') node = renderImpact();
    else if (key === 'reliability') node = renderReliability();
    else if (key === 'viewers' && parts[1]) node = await renderViewer(parts[1].toUpperCase(), (parts[2] || '').toUpperCase() || null);
    else if (key === 'viewers') node = renderViewers();
    else if (key === 'lab') { if (!LAB && CODE) { try { LAB = await api('/api/live/unlock', { method: 'POST' }); } catch (e) { CODE = ''; store.del('oua-code', true); } markLab(); } node = renderLab(params); }
    else if (key === 'api') node = renderApi();
    else node = page(h('h1', {}, 'Not found'), h('a', { href: '#/overview' }, 'Back to the overview'));
  } catch (e) { node = page(h('h1', {}, 'Something went wrong'), h('p', { class: 'lede' }, e.message)); }
  main.replaceChildren(node);
  const focusScroll = key === 'viewers' && parts[2];
  if (!focusScroll) window.scrollTo(0, 0);
  main.focus({ preventScroll: true });
  document.title = (document.querySelector('.menu a.on') ? document.querySelector('.menu a.on').textContent.replace(/^\d+/, '').replace('●', '').trim() + ' · ' : '') + 'One User, One Agent';
}
addEventListener('hashchange', route);

(async function boot() {
  try { HEALTH = await api('/api/health'); $('status').classList.add('ok'); $('statustext').textContent = `${fmt(HEALTH.decisions)} decisions · lab ${HEALTH.live.enabled ? 'on' : 'off'}`; }
  catch (e) { $('status').classList.add('err'); $('statustext').textContent = 'API unreachable'; }
  markLab(); route();
})();
})();
