import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVENESS,
  blankLiterals,
  lintEs3ReservedWords,
  validateScriptSyntax,
  mintSentinel,
  wrapWithSentinel,
  classifyExecution,
  runConfirmedScript,
} from '../src/servicenow/script-liveness.js';

import {
  assertSysId,
  assertIdentifier,
  buildImpersonationBody,
  IMPERSONATION_MARKER,
} from '../src/servicenow/impersonation.js';

/**
 * B1 — the foundational primitive.
 *
 * Everything provable without an instance is proved here. The live EXECUTED
 * proof (identity switch, has_admin drop, 200-vs-6 enforcement, revert) is
 * reported separately; what this file guards is that the generated script can
 * never silently regress into the shapes Phase 0 measured as dangerous.
 */

/* Query-resolved during Phase 0; used here only as well-formed fixtures. */
const ADMIN = '6816f79cc0a8016401c5a33be04be441';
const TARGET = '555a640583fe0f10b939cc65eeaad3a2';

/* ------------------------------------------------------------------ *
 * NET 1 — pre-dispatch validation
 * ------------------------------------------------------------------ */

test('the ES3 lint catches the exact script that died silently on the instance', () => {
  const findings = lintEs3ReservedWords('var out = { case: 1 }; out.probe = 1;');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].word, 'case');
  assert.equal(findings[0].kind, 'object-key');
  assert.match(findings[0].message, /stored active and never run/);
});

test('new Function ALONE would have passed that script — which is why the lint exists', () => {
  const body = 'var out = { case: 1 };';
  // The check the build pack specified, on its own, does not fire:
  assert.doesNotThrow(() => new Function(body)); // eslint-disable-line no-new-func
  // The shipped validator does:
  const v = validateScriptSyntax(body);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'es3-reserved');
});

test('validateScriptSyntax still catches ordinary syntax errors', () => {
  for (const bad of ['var o = { ;', 'var s = "unterminated;', 'function (']) {
    const v = validateScriptSyntax(bad);
    assert.equal(v.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.equal(v.reason, 'syntax');
    assert.match(v.errors[0].message, /SyntaxError/);
  }
});

test('an empty body is refused rather than dispatched as a no-op', () => {
  const v = validateScriptSyntax('   \n  ');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'empty');
});

test('every ES3 reserved word is caught as an unquoted key, not just `case`', () => {
  for (const word of ['default', 'delete', 'in', 'class', 'function', 'new', 'this', 'typeof']) {
    const findings = lintEs3ReservedWords(`var o = { ${word}: 1 };`);
    assert.equal(findings.length, 1, `${word} should be flagged`);
    assert.equal(findings[0].word, word);
  }
});

test('a reserved word as a dotted accessor is flagged, with bracket notation named', () => {
  const findings = lintEs3ReservedWords('var v = payload.default;');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'member');
  assert.match(findings[0].message, /\["default"\]/);
});

test('quoted keys and non-reserved keys pass clean', () => {
  assert.deepEqual(lintEs3ReservedWords("var o = { 'case': 1, result: 2, sys_id: 3 };"), []);
  assert.equal(validateScriptSyntax("var o = { 'case': 1 }; o['case'];").ok, true);
});

test('the linter does not flag reserved words that appear inside strings or comments', () => {
  // A generated script legitimately carries this text in a JSON payload or a
  // diagnostic message. Flagging it would make the validator unshippable.
  const src = [
    'var msg = "beware of { case: 1 } in generated source";',
    "var other = 'o.default is fine inside a string';",
    '// { case: 1 } in a line comment',
    '/* o.default in a block comment */',
    'var ok = { result: 1 };',
  ].join('\n');
  assert.deepEqual(lintEs3ReservedWords(src), []);
  assert.equal(validateScriptSyntax(src).ok, true);
});

test('a switch statement is legal ES3 and must not be refused', () => {
  const src = 'switch (mode) { default: result = 1; }';
  assert.deepEqual(lintEs3ReservedWords(src), [], 'switch/default is a keyword use, not a property name');
  assert.equal(validateScriptSyntax(src).ok, true);
});

test('blankLiterals preserves offsets and newlines so reported lines stay truthful', () => {
  const src = 'var a = "xx";\nvar b = { case: 1 };';
  const blanked = blankLiterals(src);
  assert.equal(blanked.length, src.length);
  assert.equal(blanked.split('\n').length, src.split('\n').length);
  assert.equal(lintEs3ReservedWords(src)[0].line, 2);
});

/* ------------------------------------------------------------------ *
 * NET 2 — the sentinel
 * ------------------------------------------------------------------ */

test('the sentinel is echoed on EVERY path, including when the body throws first', () => {
  const sentinel = mintSentinel();
  const wrapped = wrapWithSentinel({ body: "  throw 'boom';", sentinel, marker: IMPERSONATION_MARKER });
  // The echo sits AFTER the catch, so no body can skip it.
  const catchAt = wrapped.indexOf('} catch (e)');
  const echoAt = wrapped.indexOf('gs.info(');
  const payloadAt = wrapped.indexOf('report.payload');
  assert.ok(catchAt > -1 && echoAt > catchAt, 'the gs.info echo must follow the catch');
  assert.ok(payloadAt > catchAt, 'the sink payload must follow the catch');
  assert.ok(wrapped.includes(sentinel));
});

test('a sentinel that is not a hex GUID is refused — it would need escaping', () => {
  assert.throws(() => wrapWithSentinel({ body: 'var x = 1;', sentinel: "'); gs.info('" }), /32-char hex/);
});

test('classifyExecution separates "did not run" from "ran and failed"', () => {
  const s = mintSentinel();

  assert.equal(classifyExecution({ run: null, sentinel: s }).liveness, LIVENESS.FAILED_SILENT_NONEXECUTION);
  assert.equal(
    classifyExecution({ run: { timedOut: true, report: null }, sentinel: s }).liveness,
    LIVENESS.FAILED_SILENT_NONEXECUTION,
  );
  // A report with no payload proves nothing about whether OUR script ran.
  assert.equal(
    classifyExecution({ run: { timedOut: false, report: { ok: true } }, sentinel: s }).liveness,
    LIVENESS.FAILED_SILENT_NONEXECUTION,
  );
  // A payload from a DIFFERENT execution must never be accepted as ours.
  const mismatch = classifyExecution({
    run: { timedOut: false, report: { ok: true, payload: { sentinel: mintSentinel() } } }, sentinel: s,
  });
  assert.equal(mismatch.liveness, LIVENESS.FAILED_SILENT_NONEXECUTION);
  assert.match(mismatch.detail, /Sentinel mismatch/);

  assert.equal(
    classifyExecution({ run: { timedOut: false, report: { ok: true, payload: { sentinel: s, error: 'IDENTITY_ASSERT_FAILED_TARGET:abc' } } }, sentinel: s }).liveness,
    LIVENESS.FAILED_WITH_ERROR,
  );
  const good = classifyExecution({
    run: { timedOut: false, report: { ok: true, payload: { sentinel: s, phase: 'op_complete', error: null } } }, sentinel: s,
  });
  assert.equal(good.liveness, LIVENESS.CONFIRMED);
  assert.equal(good.payload.phase, 'op_complete');
});

test('an invalid script is rejected pre-dispatch and never reaches the instance', async () => {
  const res = await runConfirmedScript({ body: '  var o = { case: 1 };', label: 'unit' });
  assert.equal(res.liveness, LIVENESS.REJECTED_PRE_DISPATCH);
  assert.equal(res.dispatched, false, 'nothing may be sent to the instance');
  assert.equal(res.run, null);
  assert.match(res.detail, /reserved word/);
});

/* ------------------------------------------------------------------ *
 * The impersonation wrapper
 * ------------------------------------------------------------------ */

test('a sys_id must be a live-resolved hex id, never a literal or a name', () => {
  for (const bad of ['admin', '', null, undefined, 'abc', `${ADMIN}extra`, "6816f79c'); gs.info('"]) {
    assert.throws(() => assertSysId(bad), /32-character hex sys_id/, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(assertSysId(ADMIN), ADMIN);
});

test('a table or field name that is not an identifier is refused', () => {
  for (const bad of ['inc ident', "x'); gs.info('", 'a-b', '']) {
    assert.throws(() => assertIdentifier(bad), /must match/);
  }
});

test('the wrapper refuses to impersonate the executor itself', () => {
  assert.throws(
    () => buildImpersonationBody({ adminSysId: ADMIN, targetSysId: ADMIN, op: { mode: 'read', table: 'incident' } }),
    /Refusing to impersonate the executor/,
  );
});

test('identity is asserted by getUserID, and the dead predicates are never consulted', () => {
  const body = buildImpersonationBody({
    adminSysId: ADMIN, targetSysId: TARGET, op: { mode: 'read', table: 'incident' },
  });
  // Asserted both ways round.
  assert.ok(body.includes('IDENTITY_ASSERT_FAILED_ADMIN'));
  assert.ok(body.includes('IDENTITY_ASSERT_FAILED_TARGET'));
  assert.equal((body.match(/gs\.getUserID\(\)/g) ?? []).length >= 4, true);

  // Phase 0 D-1/D-2: these are constants here. Reading them is reading a literal.
  // Checked against the CODE, not the comments — the wrapper documents in prose
  // why it does not call them, and that prose must not satisfy the assertion.
  const code = blankLiterals(body).replace(/\/\/.*$/gm, '');
  assert.ok(!/isImpersonating\s*\(/.test(code), 'isImpersonating() is a constant true — never branch on it');
  assert.ok(!/canImpersonate\s*\(/.test(code), 'canImpersonate() approved a non-existent user — never gate on it');
});

test('impersonated reads are counted by iteration — getRowCount is a measured liar', () => {
  const body = buildImpersonationBody({
    adminSysId: ADMIN, targetSysId: TARGET, op: { mode: 'read', table: 'sys_properties' },
  });
  assert.ok(body.includes('while (gr.next())'), 'must count by iteration');
  assert.ok(!body.includes('getRowCount'), 'getRowCount() on a secure query returned 0 where 6 rows were readable');
  assert.ok(body.includes("countedBy: 'iteration'"));
});

test('every impersonated read goes through GlideRecordSecure, and pre-flights first', () => {
  const body = buildImpersonationBody({
    adminSysId: ADMIN, targetSysId: TARGET, op: { mode: 'read', table: 'incident' },
  });
  assert.ok(body.includes('new GlideRecordSecure("incident")'));
  // Capability booleans are read BEFORE the op — nothing throws on denial.
  assert.ok(body.indexOf('canRead()') < body.indexOf('gr.query()'));
  for (const cap of ['canRead()', 'canCreate()', 'canWrite()', 'canDelete()']) assert.ok(body.includes(cap), cap);
});

test('the unsecured comparison is opt-in only, never on an ordinary read', () => {
  const plain = buildImpersonationBody({ adminSysId: ADMIN, targetSysId: TARGET, op: { mode: 'read', table: 'incident' } });
  assert.ok(!plain.includes('new GlideRecord("incident")'), 'a normal read must not pull rows the target cannot see');

  const diag = buildImpersonationBody({
    adminSysId: ADMIN, targetSysId: TARGET, op: { mode: 'read', table: 'incident', compareUnsecured: true },
  });
  assert.ok(diag.includes('new GlideRecord("incident")'));
  assert.ok(diag.includes('unsecuredRows'));
});

test('the revert is in a finally and its landing is asserted, not assumed', () => {
  const body = buildImpersonationBody({
    adminSysId: ADMIN, targetSysId: TARGET, op: { mode: 'read', table: 'incident' },
  });
  assert.ok(body.includes('} finally {'));
  assert.ok(body.includes('revert_ok'));
  // The op's own failure must not skip the revert, so it is caught inside.
  assert.ok(body.includes('catch (opError)'));
  assert.ok(body.includes("out.phase = 'op_failed'"));
});

test('a hostile query lands inside a literal, never in the call', () => {
  const body = buildImpersonationBody({
    adminSysId: ADMIN, targetSysId: TARGET,
    op: { mode: 'read', table: 'incident', query: "active=true'); gs.info('escaped" },
  });
  const literal = body.match(/addEncodedQuery\((".*?")\);/)[1];
  assert.equal(JSON.parse(literal), "active=true'); gs.info('escaped");
});

test('the wrapper it generates passes its own validator — both nets, on the real bytes', () => {
  for (const op of [
    { mode: 'read', table: 'incident' },
    { mode: 'read', table: 'sys_properties', query: 'nameSTARTSWITHglide', fields: ['name', 'value'], compareUnsecured: true },
    { mode: 'preflight', table: 'sys_user' },
  ]) {
    const body = buildImpersonationBody({ adminSysId: ADMIN, targetSysId: TARGET, op });
    const wrapped = wrapWithSentinel({ body, sentinel: mintSentinel(), marker: IMPERSONATION_MARKER });
    const v = validateScriptSyntax(wrapped);
    assert.equal(v.ok, true, `generated script must validate: ${JSON.stringify(v.errors)}`);
  }
});
