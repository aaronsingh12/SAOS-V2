import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TABLES } from '../src/health/tables.js';
import { AGENTS, SEVERITIES } from '../src/health/rules.js';
import { classifyFailure } from '../src/health/extract.js';

/*
 * Health Assist — the client contract.
 *
 * There is no DOM harness here, for the reason §13 gives: the failures this
 * class of code actually has are field-name mismatches and unrecognised status
 * words, and a fixture written from the same wrong assumption as the component
 * would not catch either. So the page source is checked against the vocabulary
 * the server can really emit.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(__dirname, '../../client/src');
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

const PAGE = read('pages/HealthAssist.jsx');
const CSS = read('styles.css');
const SIDEBAR = read('components/Sidebar.jsx');
const APP = read('App.jsx');

/* ── It is reachable ───────────────────────────────────────────────────── */

test('Health Assist is in the left navigation and has an icon that exists', () => {
  assert.match(SIDEBAR, /\['\/health', 'Health Assist', 'health'\]/, 'the nav entry is gone');
  // An icon name with no entry in `I` renders an empty <svg> rather than failing.
  assert.match(SIDEBAR, /\n {2}health: <>/, 'the health icon is not defined');
});

test('the route is mounted and gated on an instance being bound', () => {
  assert.match(APP, /import HealthAssist from '\.\/pages\/HealthAssist\.jsx'/);
  assert.match(
    APP,
    /<Route path="\/health" element=\{<RequiresInstance what="Health Assist"><HealthAssist \/><\/RequiresInstance>\} \/>/,
    'the page is not behind RequiresInstance — it would mount and fire requests with nothing connected (trap #31)',
  );
});

/* ── It reads what the server actually sends ───────────────────────────── */

test('every coverage status the server can emit has a label on the page', () => {
  /*
   * An unlabelled status renders as a raw code like `invalid_query` next to
   * ones that read as English, which is exactly how a reader concludes the
   * page is broken rather than that the table was refused.
   */
  const emitted = new Set([
    'complete', 'limited', 'truncated', 'not_requested',
    ...['unauthorized', 'forbidden', 'unavailable', 'invalid_query', 'rate_limited', 'upstream_error'],
  ]);
  for (const status of emitted) {
    assert.match(PAGE, new RegExp(`\\b${status}\\b`), `the page has no label for coverage status "${status}"`);
  }
});

test('classifyFailure cannot produce a status the page has never heard of', () => {
  const produced = new Set([401, 403, 404, 400, 429, 500, 502, 503].map((s) => classifyFailure({ status: s })));
  for (const status of produced) {
    assert.match(PAGE, new RegExp(`\\b${status}\\b`), `classifyFailure emits "${status}" and the page does not know it`);
  }
});

test('the severity words come from the SERVER, not from the page', () => {
  /*
   * ARCHITECTURE §17.7 — the UI has no vocabulary of its own. "Major" is the
   * label for HIGH, and a private copy in the page would drift the first time a
   * rule changed severity. The page may hold a pre-load FALLBACK, but it must
   * prefer what meta serves.
   */
  assert.match(PAGE, /meta\?\.severities/, 'the page never reads the served severity vocabulary');
  assert.match(PAGE, /SEVERITY_FALLBACK/, 'there is no labelled fallback — an unlabelled copy is the drift risk');
  // Every severity the rules can rank must be nameable.
  for (const s of SEVERITIES) {
    assert.match(PAGE, new RegExp(`'${s.key}'`), `the page cannot name severity ${s.key}`);
  }
});

test('every severity tone the server names has a colour in the stylesheet', () => {
  // A tone with no rule falls through to the default and reads as a lower
  // severity than the ones beside it.
  for (const s of SEVERITIES) {
    assert.match(CSS, new RegExp(`\\.tone-${s.tone}\\b`), `styles.css has no .tone-${s.tone}`);
  }
});

test('the page reads manifest fields by the names the server writes', () => {
  // Each of these is produced in health/index.js. A rename on either side that
  // is not made on both shows as a blank panel, not as an error.
  for (const field of [
    'cmdb_quality_score', 'score_withheld_because', 'score_definition',
    'visible_cis', 'visible_relationships', 'findings_stored',
    'skipped_checks', 'severity_counts', 'coverage',
  ]) {
    assert.match(PAGE, new RegExp(field), `the page never reads manifest.${field}`);
  }
});

test('the page reads finding and remediation fields by the names the server returns', () => {
  for (const field of ['fingerprint', 'rule_id', 'target_ids', 'ai_summary', 'impact', 'evidence']) {
    assert.match(PAGE, new RegExp(`\\b${field}\\b`), `the page never reads finding.${field}`);
  }
  for (const field of [
    'headline', 'problem', 'decisionNote', 'aiActionLabel', 'manualSteps', 'verify', 'effort', 'prompt',
  ]) {
    assert.match(PAGE, new RegExp(`\\b${field}\\b`), `the page never reads remediation.${field}`);
  }
});

test('every domain the rules can emit is nameable by the page', () => {
  // The page renders manifest.domains, which is built from AGENTS, so this is
  // really asserting the server hands over the labels rather than the page
  // keeping a second copy that can drift.
  assert.match(PAGE, /manifest\?\.domains/, 'the page invented its own domain list');
  assert.ok(Object.keys(AGENTS).length >= 10);
});

/* ── It cannot write ───────────────────────────────────────────────────── */

test('the ITSM section (components/HealthItsm.jsx) reaches only Health Assist endpoints, and reads the manifest by the names the server writes', () => {
  const ITSM = read('components/HealthItsm.jsx');
  const calls = [...ITSM.matchAll(/api\.(?:get|post|patch|put|del)\(\s*[`']([^`'$]*)/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(calls.length >= 3, 'the scan found too few calls — the pattern is wrong, not the component');
  assert.deepEqual(calls.filter((c) => !c.startsWith('/health/itsm/parameters')), [], 'the ITSM section calls something other than its parameter endpoints');
  assert.match(PAGE, /from '..\/components\/HealthItsm\.jsx'/, 'the page no longer renders the ITSM section');
  /* the names it reads are the names the server writes */
  const INDEX = fs.readFileSync(path.resolve(__dirname, '../src/health/index.js'), 'utf8');
  const INTEGRATION = fs.readFileSync(path.resolve(__dirname, '../src/health/itsm/integration.js'), 'utf8');
  const LINKS = fs.readFileSync(path.resolve(__dirname, '../src/health/cross-domain/links.js'), 'utf8');
  for (const name of ['measure_history', 'rules: itsm.normalized.rules', 'aggregation: itsm.normalized.aggregation']) assert.ok(INDEX.includes(name), `index.js no longer writes ${name}`);
  assert.match(INDEX, /^\s+links,$/m, 'the manifest no longer carries links');
  for (const name of ['population_empty', 'undetermined', 'unresolved_parameters', 'dependencies', 'passes_determinate_when_empty', 'occurrences']) {
    assert.ok(INTEGRATION.includes(name), `integration.js no longer writes ${name}`);
    assert.ok(ITSM.includes(name.replace('population_empty', 'undetermined')), `HealthItsm.jsx does not read ${name}`);
  }
  for (const name of ['records_on_joined', 'source_only', 'target_only', 'rows_truncated', 'target_finding']) {
    assert.ok(LINKS.includes(name), `links.js no longer writes ${name}`);
    assert.ok(ITSM.includes(name), `HealthItsm.jsx does not read ${name}`);
  }
  /* no verdict for a report link, and nothing in the browser turns a non-evaluated rule into a pass */
  assert.match(ITSM, /if \(r\.status === 'evaluated'\) return OUTCOME\[r\.verdict\]/);
});

test('the page can only reach Health Assist endpoints — never the instance', () => {
  /*
   * THE PROPERTY THIS MODULE IS SOLD ON, restated against what it is really
   * about.
   *
   * This asserted "no api.patch anywhere", which was a fair proxy while the
   * page was purely a reader. The finding lifecycle broke it by adding one —
   * and that call writes to OUR database (a mute is a presentation decision),
   * not to ServiceNow.
   *
   * So the claim is now the accurate one: every call the page makes is under
   * `/health/`, which is a router that has no instance client at all. A path
   * outside that prefix is the thing that would matter, and it fails here.
   */
  const calls = [...PAGE.matchAll(/(?:api\.(?:get|post|patch|del)|sse)\(\s*[`']([^`'$]*)/g)]
    .map((m) => m[1])
    .filter(Boolean);
  assert.ok(calls.length > 0, 'the scan found no calls at all — the pattern is wrong, not the page');
  const escapees = calls.filter((c) => !c.startsWith('/health/'));
  assert.deepEqual(escapees, [], `the page calls outside /health/: ${escapees.join(', ')}`);

  /*
   * The page streams NOTHING itself any more. The run is watched by the
   * app-wide tracker, so leaving the page cannot lose it — the measured failure
   * was "already running" with nothing on screen. Remediation streams from the
   * drawer.
   */
  assert.equal(/\bsse\(/.test(PAGE), false, 'the page opened its own stream again — navigating away would lose the run');
  assert.match(PAGE, /from '..\/components\/healthRun\.js'/, 'the page no longer watches the run through the tracker');

  const TRACKER = read('components/healthRun.js');
  const trackerCalls = [...TRACKER.matchAll(/(?:api\.(?:get|post|patch|del)|sse)\(\s*[`']([^`'$]*)/g)].map((m) => m[1]);
  assert.ok(trackerCalls.length > 0, 'the scan found no tracker calls — the pattern is wrong');
  assert.deepEqual(trackerCalls.filter((c) => !c.startsWith('/health/runs')), [],
    'the run tracker calls something other than the run endpoints');
  const trackerStreams = [...TRACKER.matchAll(/sse\(\s*[`']([^`']+)[`']/g)].map((m) => m[1]).sort();
  assert.deepEqual(trackerStreams, ['/health/runs', '/health/runs/${runId}/stream'],
    'the tracker streams from somewhere other than the run endpoints');
});

test('leaving the page does not stop a check: Stop is an explicit request, and the run is found again', () => {
  const TRACKER = read('components/healthRun.js');
  assert.match(TRACKER, /api\.post\(`\/health\/runs\/\$\{state\.runId\}\/cancel`\)/, 'Stop is not an explicit cancel request');
  assert.equal(/AbortController/.test(TRACKER), false, 'the tracker aborts its own fetch — that would be the old cancel-by-leaving');
  assert.match(TRACKER, /api\.get\('\/health\/runs\/active'\)/, 'the tracker cannot find a run started before a reload');
  assert.match(read('App.jsx'), /discoverHealthRun\(\)/, 'the app does not pick a running check back up after a reload');
  assert.match(PAGE, /onClick=\{stopHealthRun\}/, 'the Stop button no longer calls the explicit cancel');
});

test('the lifecycle write goes to our own database, and can never delete a finding', () => {
  /*
   * Muting is PRESENTATION. A health tool that could make findings disappear
   * would be a tool for hiding problems, so the page may set a state and may
   * not remove a finding — and the muted ones stay in every count.
   */
  assert.match(PAGE, /\/health\/findings\/\$\{[^}]+\}\/state/, 'the page no longer sets a finding state');
  assert.equal(/api\.del\(\s*[`']\/health\/runs\/[^`']*\/findings/.test(PAGE), false,
    'the page can delete a finding');
  assert.match(PAGE, /still detected and still counted/i,
    'the page no longer tells the user a muted finding is still counted');
});

test('the server route surface offers no instance write either', () => {
  const ROUTE = fs.readFileSync(path.resolve(__dirname, '../src/routes/health.js'), 'utf8');
  // The one DELETE removes a stored RUN from our own database. It must not
  // reach the instance, so the router may not import the table client at all.
  assert.equal(/servicenow\/client\.js/.test(ROUTE), false, 'the health router talks to the instance directly');
  /*
   * This asserted a single `writes: false`, which became untrue the day
   * remediation shipped — an approved plan does change the instance. The
   * claim is now two facts, and both are asserted: detection never writes,
   * and a fix needs approval and goes through the plan executor.
   */
  assert.match(ROUTE, /detectionWrites: false/, 'the meta endpoint no longer states that detection does not write');
  assert.match(ROUTE, /requiresApproval: true, executesThrough: 'plan executor'/,
    'the meta endpoint no longer states how a fix reaches the instance');
  assert.equal(/writes: false,/.test(ROUTE), false, 'the old, now-false blanket claim is back');
});

test('only the two declared seams reach the instance, and only through the one client', () => {
  /*
   * This asserted that `extract.js` was the ONLY module in `health/` naming the
   * client, which was right while Health Assist was purely a reader.
   *
   * Remediation added a second legitimate read: a proposal needs the CURRENT
   * value of a field, and validation needs to re-read it afterwards. Those go
   * through `instance-read.js`, which is named here so the seam stays a closed
   * list of two rather than becoming "wherever it was convenient".
   *
   * The guarantee is unchanged and is asserted directly below: nothing in
   * `health/` WRITES to the instance.
   */
  const SRC = path.resolve(__dirname, '../src/health');
  const SEAMS = ['extract.js', 'instance-read.js'];

  const offenders = [];
  for (const name of fs.readdirSync(SRC)) {
    if (!name.endsWith('.js') || SEAMS.includes(name)) continue;
    const body = fs.readFileSync(path.join(SRC, name), 'utf8');
    if (/servicenow\/client\.js/.test(body)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `${offenders.join(', ')} reaches the instance outside the two declared seams`);

  for (const seam of SEAMS) {
    const body = fs.readFileSync(path.join(SRC, seam), 'utf8');
    assert.match(body, /from '\.\.\/servicenow\/[a-z-]+\.js'/,
      `${seam} no longer goes through the one client funnel (ARCHITECTURE §17.2)`);
    assert.equal(/fetch\(|axios|https?\.request/.test(body), false,
      `${seam} opened its own HTTP path instead of using the client`);
  }
});

test('NOTHING under health/ writes to the instance — every change goes through the executor', () => {
  /*
   * THE PROPERTY THE WHOLE REMEDIATION FLOW RESTS ON.
   *
   * Health Assist proposes. The plan executor applies. That split is what puts
   * the approval gate, the read-back and the audit trail on every change, and
   * it would be undone the moment any module here called `table.update`
   * directly — the write would land, and none of those three would have run.
   *
   * Asserted on the source rather than trusted, because the tempting shortcut
   * is one line long.
   */
  const SRC = path.resolve(__dirname, '../src/health');
  const offenders = [];
  for (const name of fs.readdirSync(SRC)) {
    if (!name.endsWith('.js')) continue;
    const body = fs.readFileSync(path.join(SRC, name), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    if (/\btable\.(create|update|remove)\s*\(/.test(body)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `${offenders.join(', ')} writes to the instance directly, bypassing the gate and the read-back`);

  // And the read seam exports reads only.
  const SEAM = fs.readFileSync(path.join(SRC, 'instance-read.js'), 'utf8');
  const exported = [...SEAM.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(exported.sort(), ['readRecord', 'resolveReference'],
    'the read-only seam grew an export that is not a read');
});

test('the rule pack is pure: no network, no database, no model', () => {
  const RULES = fs.readFileSync(path.resolve(__dirname, '../src/health/rules.js'), 'utf8');
  for (const forbidden of [/servicenow\//, /memory\/db/, /providers\//, /\bfetch\(/]) {
    assert.equal(forbidden.test(RULES), false, `rules.js imports or calls ${forbidden} — it must stay pure`);
  }
});

/* ── The allow-list is real ────────────────────────────────────────────── */

test('the meta endpoint derives its table list from the allow-list', () => {
  /*
   * This pinned the count at 15, which was a proxy for "the route does not keep
   * its own list" and broke the moment ITOM added ten tables. The real claim is
   * that the route ENUMERATES the allow-list rather than restating it — a
   * second list is what goes stale, not a growing first one.
   */
  const ROUTE = fs.readFileSync(path.resolve(__dirname, '../src/routes/health.js'), 'utf8');
  assert.match(ROUTE, /Object\.entries\(TABLES\)/, 'the route hardcodes a table list beside the allow-list');
  assert.ok(Object.keys(TABLES).length > 0);
  // The two the rule pack cannot run without must still be marked required.
  const required = Object.entries(TABLES).filter(([, s]) => s.required).map(([n]) => n);
  assert.deepEqual(required.sort(), ['cmdb_ci', 'cmdb_rel_ci']);
});


/* ── The agent handoff ─────────────────────────────────────────────────── */

test('handing a finding to the agent is NAVIGATION, never a send', () => {
  /*
   * Health Assist reads the instance and cannot write to it. Handing the agent
   * a prompt must not become a way around that: the page navigates, the Agent
   * page fetches the draft and PLACES it in the composer, and a human presses
   * send. Nothing here may post a chat turn.
   */
  assert.match(PAGE, /navigate\(`\/agent\?health=/, 'the page no longer hands over by navigating');
  assert.equal(/\/agent\/chat/.test(PAGE), false, 'the page talks to the chat endpoint directly');
  assert.equal(/autoSend|auto_send/.test(PAGE), false, 'the page tries to send the draft for the user');
});

test('the Agent page places the draft and clears the param', () => {
  const CHAT = read('pages/AgentChat.jsx');
  assert.match(CHAT, /params\.get\('health'\)/, 'AgentChat no longer accepts a health handoff');
  assert.match(CHAT, /findings\/\$\{fingerprint\}\/prompt/, 'the draft is not fetched from the authoritative endpoint');
  // `cur || draft.text` — never clobber something the user has already typed.
  assert.match(CHAT, /setInput\(\(cur\) => cur \|\| draft\.text\)/,
    'the draft overwrites what the user typed instead of deferring to it');
  assert.match(CHAT, /next\.delete\('health'\)/, 'the param is not cleared, so a refresh re-places the draft');
});

/* ── Honesty of the estimate ───────────────────────────────────────────── */

test('the time comparison is labelled an estimate wherever it appears', () => {
  /*
   * Nothing here was timed. A confident number would be the one invented thing
   * on a page whose whole point is that everything else is derived.
   */
  assert.match(PAGE, /Estimated, not measured/, 'the estimate is presented as a measurement');
  assert.match(PAGE, /effort\.basis/, 'the basis for the estimate is not shown');
  assert.match(PAGE, /effort\.disclaimer/, 'the disclaimer is not shown');
});

/* ── The CMDB / ITOM / ITSM / Platform switch ──────────────────────────── */

test('the switch reads its scopes from the server and keeps the choice in the URL', () => {
  /*
   * Served vocabulary, like every other word here. In the URL so a view
   * survives a refresh and can be shared: /health?scope=itom opens on ITOM.
   */
  assert.match(PAGE, /meta\?\.scopes/, 'the page coined its own scope list');
  assert.match(PAGE, /useSearchParams/, 'the scope is not kept in the URL');
  assert.match(PAGE, /params\.get\('scope'\)/);
  assert.match(PAGE, /qs\.set\('scope', scopeKey\)/, 'the findings list does not follow the scope');
  assert.match(PAGE, /if \(scope !== 'all'\) qs\.set\('scope', scope\)/, 'the export ignores the scope on screen');
});

test('every number on the page comes from the server summary for the scope, over all detected findings', () => {
  /*
   * REGRESSION. "1000 things found", "989 Moderate" and "0 Low" were all
   * counted from the stored 1,000 of 12,194 findings.
   */
  assert.match(PAGE, /manifest\?\.scopes\?\.\[scope\]/, 'the page does not read the per-scope summary');
  assert.match(PAGE, /findings_detected/, 'the headline count is not the detected count');
  assert.equal(/\{manifest\?\.findings_stored \?\? 0\}<\/b><span>things found/.test(PAGE), false,
    'the headline count is the STORED number again');
});

test('the All view shows each scope on its own and never averages them', () => {
  // CMDB and ITSM are record scores, ITOM a check score, Platform none. An
  // average of those would be a number that means nothing.
  assert.match(PAGE, /function ScopeTiles/);
  assert.equal(/reduce\([^)]*score[^)]*\)\s*\/\s*/.test(PAGE), false, 'something averages the scope scores');
  assert.match(PAGE, /rather than averaged/);
});

test('the All view shows whether to believe the CMDB score, not only the number', () => {
  /*
   * REGRESSION, dev424910 Sep 2026. The All view showed "77% Mostly healthy" for
   * CMDB with the trust gate open on seven blockers: the tile took its word from
   * the number alone, and the trust variants were wired to the CMDB tab only.
   */
  assert.match(PAGE, /const untrusted = Boolean\(sum\?\.gate && !sum\.gate\.trustworthy/, 'a scope tile words its score without the gate');
  assert.match(PAGE, /untrusted \? sum\.gate\.label/, 'an untrusted tile does not say why');
  const allBranch = PAGE.slice(PAGE.indexOf("{scope === 'all' ? ("), PAGE.indexOf('<div className="card hs-scorecard">'));
  assert.match(allBranch, /<TrustVariants composite=\{cmdbQ\.composite\} \/>/, 'the All view does not show the trust variants');
});

test('switching scope clears the area AND rule filters so a scope is never filtered to another scope’s', () => {
  /*
   * Both belong to one scope. A CMDB area or a CMDB rule carried into ITSM
   * filters the list to nothing, which reads as a clean ITSM estate.
   */
  assert.match(PAGE, /setFilter\(\(cur\) => \(\{ \.\.\.cur, domain: '', rule: '' \}\)\)/,
    'an area or rule filter from one scope survives into another and shows an empty list');
});

test('ITOM checks that could not be evaluated are shown as not counted, never as a pass', () => {
  assert.match(PAGE, /c\.result === 'not_applicable' && `not counted/);
});

test('the header no longer claims Health Assist cannot write', () => {
  /*
   * True until remediation shipped; false after. Both halves now come from meta.
   * Comments are stripped first: the page's own comment QUOTES the old claim to
   * explain why it was removed, and what matters is what the page renders.
   */
  const rendered = PAGE.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(/it has no tool that could/.test(rendered), false, 'the stale "no tool that could" claim is back');
  assert.equal(/read only<\/div>/i.test(rendered), false, 'the stale "read only" title is back');
  assert.match(PAGE, /meta\?\.note/);
});

test('every scope tone and switch class the page uses has a style', () => {
  for (const cls of ['hs-scope', 'hs-scope-btn', 'hs-tiles', 'hs-tile', 'hs-checks', 'hs-check']) {
    /* String.raw, because in an ordinary template literal `\b` is a BACKSPACE
       character — the first version of this test could never match anything. */
    assert.match(CSS, new RegExp(String.raw`\.${cls}\b`), `styles.css has no .${cls}`);
  }
});

test('the scorecard shows what is pulling the score down, and each driver filters to its findings', () => {
  assert.match(PAGE, /summary\?\.score_drivers/, 'the page does not render the score drivers');
  assert.match(PAGE, /applyFilter\(\{ rule: filter\.rule === d\.rule_id \? '' : d\.rule_id \}\)/,
    'a driver does not click through to its findings');
  assert.match(PAGE, /if \(next\.rule\) qs\.set\('rule', next\.rule\)/, 'the rule filter never reaches the server');
  assert.match(PAGE, /do not add up/, 'the page does not say driver shares overlap');
});

test('module scans: the page sends the ticked modules and reads each module from its own result', () => {
  /* Each module keeps its own latest result (15 Sep 2026). A page that still
     read one "latest run" would show an ITSM-only scan's empty CMDB as the CMDB. */
  assert.match(PAGE, /startHealthRun\(\{ modules: full \? 'all' : list, reuse \}\)/, 'the scan does not say which modules it covers');
  assert.match(PAGE, /Full System Scan/);
  assert.match(PAGE, /api\.get\('\/health\/modules'\)/, 'the page does not load each module\'s own result');
  assert.match(PAGE, /\/health\/modules\/findings\?/, 'the findings list does not come from each module\'s own run');
  assert.match(PAGE, /findings\.find\(\(x\) => x\.fingerprint === fingerprint\)\?\.run_id/, 'a finding is not opened from the run that produced it');
  assert.match(PAGE, /runId=\{detailRunId\}/, 'remediation is not bound to the finding\'s own run');
  assert.equal(/api\.get\('\/health\/runs\/latest'\)/.test(PAGE), false, 'the page still reads a single latest run');
  assert.match(PAGE, /\/health\/scan-state/, 'the scan-state configuration table is not shown');
});
