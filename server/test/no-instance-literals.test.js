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
 * Cut a `//` line comment WITHOUT cutting the `//` in a URL scheme.
 *
 * ── H-1, and why the naive version could not see the bug it existed for ──────
 *
 * This was `line.replace(/\/\/.*$/, '')`. `https://` contains `//`, so every
 * connection URL in the tree was truncated at its scheme before the hostname
 * regex ever ran:
 *
 *   const H = 'https://dev123456.service-now.com';   as the scanner saw it:
 *   const H = 'https:                                -> zero hostname matches
 *
 * The scan could therefore only ever catch a SCHEME-LESS hostname — and a
 * hardcoded connection string always has a scheme. It reported the tree clean
 * because it could not see, which is worse than not scanning: false assurance
 * about the exact bug class that caused the dev442675 incident. Its own
 * self-check missed this because the probe it planted was also scheme-less.
 *
 * So the cut is now made by a walk that knows two things the regex did not:
 *
 *   - a `//` inside a string literal is not a comment. That is what puts
 *     'https://host' in front of the regex intact.
 *   - a `//` immediately preceded by `:` is a scheme separator, not a comment,
 *     even unquoted (a template chunk, a concatenation).
 *
 * Still deliberately not a JS parser. A false NEGATIVE is a missed literal that
 * the deploy-time guards (assertTiersAgree / assertAppBinding) still catch; a
 * false POSITIVE would make the suite unrunnable and get the scan deleted.
 */
function stripLineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') {
      if (line[i - 1] === ':') continue;   // `https://…`, not a comment
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Strip comments and skip anything that is not executable.
 *
 * Removes `//` tails (see stripLineComment), whole-line `*` continuations and
 * `/* … *\/` on one line.
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
    line = stripLineComment(line);
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

/* ── the self-check ───────────────────────────────────────────────────────── */

/*
 * The three scans above, run over a string instead of the tree, so the probe
 * and the real scan cannot drift apart.
 */
const HOSTNAME_RE = /\b[a-z0-9-]+\.service-now\.com\b/i;
const SYSID_RE = /['"`][0-9a-f]{32}['"`]/i;

function scanText(text) {
  const hits = { hostname: [], sysId: [] };
  for (const { line } of executableLines(text)) {
    if (HOSTNAME_RE.test(line)) hits.hostname.push(line.trim());
    const m = line.match(SYSID_RE);
    if (m) hits.sysId.push(m[0]);
  }
  return hits;
}

test('the scan actually reads files — a scan that matches nothing proves nothing', () => {
  // A green result is only meaningful if the scanner found source to scan.
  const total = SCAN_DIRS.reduce((n, d) => n + sourceFiles(d).length, 0);
  assert.ok(total > 40, `only ${total} source files scanned — the walker is not finding the tree`);
});

test('the scan can see a planted violation in every shape one really takes (H-1)', () => {
  /*
   * The version of this probe that shipped with the bug planted only a BARE
   * hostname, which is the one shape `//`-stripping could not destroy — so the
   * self-check passed while the scan was blind to every real connection string.
   * The probe now plants all three shapes, and the schemed URL is the one that
   * matters: it is how a hardcoded instance is actually written.
   */
  const schemed = scanText(`const base = 'https://dev123456.service-now.com';`);
  assert.deepEqual(schemed.hostname, [`const base = 'https://dev123456.service-now.com';`],
    'a schemed connection URL must be caught — this is the shape H-1 was blind to');

  const bare = scanText(`const host = "dev123456.service-now.com";`);
  assert.equal(bare.hostname.length, 1, 'a scheme-less hostname must still be caught');

  const sysId = scanText(`const scopeId = 'deadbeefdeadbeefdeadbeefdeadbeef';`);
  assert.deepEqual(sysId.sysId, [`'deadbeefdeadbeefdeadbeefdeadbeef'`], 'a quoted sys_id must be caught');

  // Schemed URL and sys_id planted on the SAME line, as a real config object is.
  const both = scanText(`const cfg = { url: 'https://dev123456.service-now.com', scope: 'deadbeefdeadbeefdeadbeefdeadbeef' };`);
  assert.equal(both.hostname.length, 1);
  assert.equal(both.sysId.length, 1);
});

test('comments are still exempt — including comments that mention an instance', () => {
  // The exemption is the reason the scan is tolerated at all: this repo records
  // the instance a measurement was taken on. Breaking it would get the scan
  // deleted, so it is asserted rather than assumed.
  const line = scanText(`// measured on dev999999.service-now.com, sys_id 'deadbeefdeadbeefdeadbeefdeadbeef'`);
  assert.deepEqual(line.hostname, []);
  assert.deepEqual(line.sysId, []);

  const block = scanText(`/* measured on dev999999.service-now.com */`);
  assert.deepEqual(block.hostname, []);

  const trailing = scanText(`const x = 1;   // dev999999.service-now.com`);
  assert.deepEqual(trailing.hostname, []);

  // A comment AFTER live code on the same line must not hide the code.
  const mixed = scanText(`const u = 'https://dev123456.service-now.com';  // the bound instance`);
  assert.equal(mixed.hostname.length, 1);
});
