import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STARTUP_STAGES, READY_LABEL, currentStage, describeStartup,
} from '../../client/src/components/startupProgress.js';

/*
 * The startup screen's bar is a claim about what the application has done.
 * These hold it to the one rule that makes the screen worth having: it says
 * 100% when, and only when, the last real startup signal has landed.
 */

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/src');
const read = (rel) => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

const allDone = () => Object.fromEntries(STARTUP_STAGES.map((s) => [s.id, true]));

test('the stage weights account for the whole bar', () => {
  assert.equal(STARTUP_STAGES.reduce((n, s) => n + s.weight, 0), 100);
  assert.deepEqual(STARTUP_STAGES.map((s) => s.id), ['mount', 'assets', 'health', 'workspace']);
});

test('nothing done is the floor, and the label is the first stage', () => {
  const v = describeStartup({}, 1000, {});
  assert.equal(v.percent, 0);
  assert.equal(v.stage, 'mount');
  assert.equal(v.label, 'Initializing SAOS…');
  assert.equal(v.ready, false);
});

test('a waiting stage creeps toward its ceiling and slows, but never claims it', () => {
  const done = { mount: true, assets: true };
  const since = { health: 0 };
  const at = (t) => describeStartup(done, t, since).percent;
  assert.equal(at(0), 30, 'the base is the sum of what has landed');
  assert.ok(at(1000) > at(0));
  assert.ok(at(2000) > at(1000));
  assert.ok(at(2000) - at(1000) < at(1000) - at(0), 'the gain per second shrinks');
  // 40 * 0.9 = 36 is the most this stage may claim while it is outstanding.
  assert.ok(at(60_000) <= 66, `after a minute the bar claimed ${at(60_000)}%`);
  assert.equal(describeStartup(done, 60_000, since).label, 'Connecting to services…');
});

test('the bar never reaches 100 while any stage is outstanding', () => {
  for (const missing of STARTUP_STAGES) {
    const done = allDone();
    delete done[missing.id];
    const v = describeStartup(done, 10 ** 9, { [missing.id]: 0 });
    assert.ok(v.percent < 100, `${missing.id} outstanding, bar at ${v.percent}`);
    assert.equal(v.ready, false);
    assert.equal(v.stage, missing.id);
    assert.equal(v.label, missing.label);
  }
});

test('every stage done is exactly 100 and Ready', () => {
  const v = describeStartup(allDone(), 12_345, {});
  assert.deepEqual(v, { percent: 100, label: READY_LABEL, stage: null, ready: true });
  assert.equal(currentStage(allDone()), null);
});

test('a stage landing out of order raises the base without moving the label', () => {
  // Fonts still loading, but the health answer already came back.
  const before = describeStartup({ mount: true }, 500, { assets: 0 });
  const after = describeStartup({ mount: true, health: true }, 500, { assets: 0 });
  assert.equal(before.label, 'Loading assets…');
  assert.equal(after.label, 'Loading assets…');
  assert.ok(after.percent > before.percent);
});

test('a missing or bad clock entry reads as "just started", never as NaN', () => {
  const v = describeStartup({ mount: true }, 5000, { assets: undefined });
  assert.equal(v.percent, 12);
  assert.equal(describeStartup({ mount: true }, 5000, { assets: NaN }).percent, 12);
});

/* ── It is wired the way the screen promises ─────────────────────────────── */

test('the screen is mounted once in App, outside the routed content', () => {
  const app = read('App.jsx');
  assert.match(app, /import SAOSLoadingScreen from '\.\/components\/SAOSLoadingScreen\.jsx'/);
  assert.equal(app.match(/<SAOSLoadingScreen \/>/g)?.length, 1, 'mounted exactly once');
  assert.ok(app.indexOf('<SAOSLoadingScreen />') > app.indexOf('<Shell />'), 'it is a sibling after the shell, not a wrapper around it');
});

test('the screen watches the shared health poller rather than making its own request', () => {
  const screen = read('components/SAOSLoadingScreen.jsx');
  assert.match(screen, /useHealth\(\)/);
  assert.doesNotMatch(screen, /api\.get\(/, 'the screen must not add a request to startup');
  assert.doesNotMatch(screen, /Math\.random/, 'a random field twitches under StrictMode');
});
