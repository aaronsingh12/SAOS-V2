import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * A3 — the STATIC complement to assertTiersAgree() / assertAppBinding().
 *
 * Those two catch an instance-local value at deploy time, which is late and
 * costs a round trip. This catches one at commit time, for free.
 *
 * It exists because the same bug class has now been found in SIX modules:
 * a hostname in a credential alias, a scope sys_id in now.config.json, a scope
 * sys_id keying the workspace registry and the applications map, an app-scope
 * literal namespacing the execution harness sink, and a real vendor prefix
 * pinned in a test that called itself "measured". Every one of them was a value
 * that is true on one instance and quietly wrong on the next.
 *
 * WHAT IS ALLOWED, and why each exception is narrow:
 *   - comments. Provenance is the point of this repo's documentation style, and
 *     a measurement that names the instance it was taken on is more honest than
 *     one that hides it. Only executable lines are scanned.
 *   - the ONE canonical scope name, read from the tracked identity template. It
 *     is project identity, not an instance-local value.
 *   - test files may hold obviously-synthetic ids (repeated-character or
 *     sequential placeholders); a real-looking sys_id in a test is exactly the
 *     thing that got copied into production code once already.
 */

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

const SCAN_DIRS = [
  path.join(SERVER_ROOT, 'src'),
  path.join(REPO_ROOT, 'client', 'src'),
];

/** The one legitimate scope literal: this project's canonical identity. */
function canonicalScope() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'fluent-workspace', 'now.config.template.json'), 'utf8')).scope;
  } catch {
    return null;
  }
}

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') sourceFiles(p, out); continue; }
    if (/\.(js|jsx|ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * Strip comments and skip anything that is not executable.
 *
 * Deliberately simple: it removes `//` tails, whole-line `*` continuations and
 * `/* … *\/` on one line. A false NEGATIVE here is a missed literal, which the
 * deploy-time guards still catch; a false POSITIVE would make the suite
 * unrunnable and get the scan deleted.
 */
function executableLines(text) {
  const out = [];
  let inBlock = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf('/*');
      if (start === -1) break;
      const end = line.indexOf('*/', start + 2);
      if (end === -1) { line = line.slice(0, start); inBlock = true; break; }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    line = line.replace(/\/\/.*$/, '');
    if (!line.trim()) return;
    out.push({ n: i + 1, line });
  });
  return out;
}

const rel = (p) => path.relative(REPO_ROOT, p).replace(/\\/g, '/');

/* ── the scans ────────────────────────────────────────────────────────────── */

test('no ServiceNow instance hostname is baked into executable source', () => {
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      for (const { n, line } of executableLines(fs.readFileSync(file, 'utf8'))) {
        if (/\b[a-z0-9-]+\.service-now\.com\b/i.test(line)) hits.push(`${rel(file)}:${n} ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(hits, [],
    'an instance hostname is hardcoded — the bound instance comes from the UI config, never from source');
});

test('no sys_id-shaped constant is baked into executable source', () => {
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      for (const { n, line } of executableLines(fs.readFileSync(file, 'utf8'))) {
        // Quoted 32-hex only: an unquoted one is a regex or a format string.
        const m = line.match(/['"`][0-9a-f]{32}['"`]/i);
        if (m) hits.push(`${rel(file)}:${n} ${m[0]}`);
      }
    }
  }
  assert.deepEqual(hits, [],
    'a sys_id is hardcoded — a sys_id is only meaningful on the instance that minted it');
});

test('the only scope literal in executable source is this project\'s canonical scope', () => {
  const canonical = canonicalScope();
  assert.ok(canonical, 'the tracked identity template must name the canonical scope');
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const file of sourceFiles(dir)) {
      for (const { n, line } of executableLines(fs.readFileSync(file, 'utf8'))) {
        for (const m of line.matchAll(/x_[0-9]{5,}_[a-z0-9_]+/gi)) {
          if (!m[0].startsWith(canonical)) hits.push(`${rel(file)}:${n} ${m[0]}`);
        }
      }
    }
  }
  assert.deepEqual(hits, [],
    `a scope literal other than the canonical ${canonical} appears in executable source`);
});

test('the scan actually reads files — a scan that matches nothing proves nothing', () => {
  // A green result is only meaningful if the scanner found source to scan.
  const total = SCAN_DIRS.reduce((n, d) => n + sourceFiles(d).length, 0);
  assert.ok(total > 40, `only ${total} source files scanned — the walker is not finding the tree`);
  // And it must be able to see a violation when one exists.
  const probe = executableLines('const h = "dev123456.service-now.com";\n// const c = "dev999999.service-now.com";');
  assert.equal(probe.length, 1);
  assert.match(probe[0].line, /dev123456/);
});
