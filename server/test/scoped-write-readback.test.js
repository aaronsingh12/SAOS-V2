import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * ── THE M-1 CLASS, ENFORCED ──────────────────────────────────────────────────
 *
 * M-1 was not a one-off. Its shape:
 *
 *   A script dispatched through the execution harness runs in this
 *   APPLICATION'S SCOPE (a sysauto_script created over the Table API is born in
 *   the REST session's current application, and the scope cannot be overridden
 *   on the insert — trap #69). A scoped script writing to a table owned by
 *   `global` has its field writes DISCARDED IN SILENCE: `canWrite()` answers
 *   true, `setValue` is a no-op, `insert()` returns a real sys_id and
 *   `getLastErrorMessage()` is null. Every signal reports success and the row
 *   lands empty.
 *
 * MEASURED Application Access on the tables NHA writes this way:
 *
 *   sys_user_preference   create=true   update=FALSE   <- M-1's own sink
 *   sys_update_set        create=true   update=FALSE
 *   sys_security_acl      create=false  update=false
 *   sys_dictionary        create=false  update=false
 *
 * "create=true, update=false" is exactly the shape that produces a row with no
 * fields in it. So a sys_id proves nothing, and the only defence that works is
 * to READ THE WRITE BACK — preferably over a different transport from the one
 * that made it, so a fabricated id, a no-op insert, or a report belonging to
 * another execution all fail.
 *
 * This test is the sweep, kept executable. Every module that dispatches a
 * server-side script containing a write must appear in the registry below with
 * the read-back that guards it. A NEW one cannot be added without deciding —
 * and writing down — how its write is proven. That is the whole point: M-1
 * leaked 11 rows across sessions precisely because one infrastructure write had
 * no read-back and nobody had to say so.
 */

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(SERVER_ROOT, 'src');

/** Modules that dispatch a server-side script, and how each proves its writes. */
const REGISTRY = {
  'servicenow/execution-harness.js': {
    writes: 'sys_user_preference (global) — the harness return channel',
    readBack: 'in-script: the sink row is re-read by sys_id and its name COMPARED, and the result is reported '
      + 'as ok/blocked; a blocked sink falls back to syslog and surrenders the orphan id so cleanup can delete it. '
      + 'Node side then reads the row back BY SYS_ID before claiming it was cleaned up.',
    evidence: ['__sinkOk', "__v.get(__sinkId)", 'NFSINK'],
  },
  'servicenow/transport.js': {
    writes: 'sys_update_set (global) — the per-scope capture set',
    readBack: 'cross-transport: the set is re-read over the REST Table API from Node and every requested field '
      + '(name, application, parent) is compared, because a silently demoted `application` would refuse every row '
      + 'the sweep later added, at the 403 in trap #72.',
    evidence: ["table.query('sys_update_set'", 'dropped.length'],
  },
  'servicenow/elevation-shim.js': {
    writes: 'arbitrary target tables (ACL and role tables) under an elevated role',
    readBack: 'cross-transport: readTargetByNonce() re-reads over REST and assessOutcomeTier() compares requested '
      + 'against actual with a PROJECTION-SUPERSET guard, so a field that was asserted but not fetched downgrades '
      + 'the tier off EXECUTED rather than passing unverified.',
    evidence: ['readTargetByNonce', 'assessOutcomeTier'],
  },
  'servicenow/acl-authoring.js': {
    writes: 'sys_security_acl, sys_security_acl_role, sys_update_set/xml',
    readBack: 'cross-transport: verifyAclLive() re-reads the ACL over the REST Table API and compares every field '
      + 'in VERIFIED_FIELDS, with PLATFORM_COMPUTED naming the fields a business rule legitimately rewrites so a '
      + 'transform is never confused with a dropped write.',
    evidence: ['verifyAclLive', 'VERIFIED_FIELDS'],
  },
  'servicenow/impersonation.js': {
    writes: 'the caller-named target table, as the impersonated user via GlideRecordSecure',
    readBack: 'in-script only: the record is re-read as the target (readback_as_target) and its attribution re-read '
      + 'as admin after the revert. This is a WEAKER guard than the cross-transport ones above — it is the same '
      + 'execution reporting on itself — and it is named here rather than left implicit. The Node layer adds a '
      + 'REST read-back of the requested fields through the same diffWrite the direct path uses, so an '
      + 'impersonated write is held to the same standard as an ordinary one.',
    evidence: ['readback_as_target', 'out.attribution'],
    nodeSideReadBack: 'agent/impersonated-write.js',
  },
  'servicenow/script-liveness.js': {
    writes: 'nothing of its own — it is the generic dispatcher',
    readBack: 'not applicable: it owns liveness, not content. classifyExecution() proves the script RAN (via a '
      + 'sentinel that distinguishes "did not run" from "ran and said nothing"); proving what it WROTE belongs to '
      + 'the caller, and every caller that writes is registered above.',
    evidence: ['classifyExecution', 'sentinel'],
    dispatcherOnly: true,
  },
};

/** Reads only — no write, so nothing to read back. Listed so the sweep is complete. */
const READ_ONLY = [
  'servicenow/dba-context.js',      // gs.getProperty for the DB engine
  'servicenow/dba-schema.js',       // GlideRecord('sys_index') query
  'servicenow/role-elevation.js',   // builds an elevated body; the write belongs to its caller
];

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') sourceFiles(p, out); continue; }
    if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/');

/** A module that builds a server-side script body containing a write. */
function dispatchesAWrite(text) {
  const buildsAScript = /runServerScript|runConfirmedScript|runElevated|sysauto_script/.test(text);
  // `.insert()` / `.update()` / `.deleteRecord()` inside a generated ES5 string.
  const hasWrite = /new GlideRecord(?:Secure)?\(/.test(text)
    && /\.insert\(\)|\.update\(\)|\.deleteRecord\(\)/.test(text);
  return buildsAScript && hasWrite;
}

test('every module that dispatches a server-side WRITE is registered with its read-back', () => {
  const found = [];
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    if (dispatchesAWrite(text)) found.push(rel(file));
  }
  assert.ok(found.length > 0, 'the scan found no scoped-script writers at all — the walker is not finding the tree');

  const unregistered = found.filter((f) => !REGISTRY[f]);
  assert.deepEqual(unregistered, [],
    'a module dispatches a server-side script that WRITES and is not in the M-1 registry. A scoped script writing '
    + 'to a global table has its fields discarded in silence, so a sys_id proves nothing. Add the module to '
    + 'REGISTRY in this test naming the read-back that proves its write, or route the write through the REST Table '
    + 'API on operator credentials instead.');
});

test('every registered module actually contains the read-back it claims', () => {
  // A registry entry is a claim like any other. It is checked against the source
  // rather than believed — transport.js carried a comment promising a read-back
  // that did not exist, which is precisely how M-1 survived.
  const missing = [];
  for (const [file, entry] of Object.entries(REGISTRY)) {
    const full = path.join(SRC, file);
    if (!fs.existsSync(full)) { missing.push(`${file}: registered but does not exist`); continue; }
    const text = fs.readFileSync(full, 'utf8');
    for (const token of entry.evidence) {
      if (!text.includes(token)) missing.push(`${file}: claims a read-back but "${token}" is absent`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the read-only dispatchers really are read-only', () => {
  const offenders = [];
  for (const file of READ_ONLY) {
    const full = path.join(SRC, file);
    if (!fs.existsSync(full)) { offenders.push(`${file}: listed read-only but does not exist`); continue; }
    if (dispatchesAWrite(fs.readFileSync(full, 'utf8'))) {
      offenders.push(`${file}: listed as read-only but now dispatches a script containing a write`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the harness cleanup verifies by SYS_ID, not by a name a discarded write never stored', () => {
  // The leak that hid the bug: cleanup queried `name=<sinkName>`, which a
  // blank-named orphan can never match, so it answered "deleted" without ever
  // looking at the row. A check that cannot fail is not a check.
  const text = fs.readFileSync(path.join(SRC, 'servicenow/execution-harness.js'), 'utf8');
  assert.match(text, /table\.get\('sys_user_preference', sinkId/,
    'the sink must be read back by sys_id');
  assert.match(text, /cleanup\.sinkDeleted = stillThere == null/,
    'sinkDeleted must depend on the sys_id read-back, not only on a name query');
});

test('transport does not trust the sys_id its scoped insert returned', () => {
  const text = fs.readFileSync(path.join(SRC, 'servicenow/transport.js'), 'utf8');
  const insertAt = text.indexOf('report.setId = us.insert();');
  const readAt = text.indexOf("table.query('sys_update_set'");
  assert.ok(insertAt >= 0, 'the scoped update-set insert is still here');
  assert.ok(readAt > insertAt, 'the read-back must follow the insert');
  assert.match(text, /application: scopeId/, 'the read-back must compare `application` — a silent demotion to global is the failure mode');
});
