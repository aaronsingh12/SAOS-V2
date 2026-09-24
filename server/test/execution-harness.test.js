import test from 'node:test';
import assert from 'node:assert/strict';

import {
  jsLiteral,
  assertQualifiedName,
  buildSubflowScript,
  wrapScript,
  parseRuntimeOutputs,
  statusForHarnessTimeoutCause,
} from '../src/servicenow/execution-harness.js';

/**
 * The harness generates a server-side script and ships it to the instance.
 * Everything provable without an instance is proved here: the escaping that
 * keeps a generated script from being broken out of, the identifier check that
 * keeps a bad name from being concatenated in, and the output parser that has
 * to tell a subflow's declared outputs apart from the engine's bookkeeping.
 */

test('jsLiteral escapes the two separators that are legal in JSON and illegal in ES5', () => {
  const raw = { note: `line${String.fromCharCode(0x2028)}break${String.fromCharCode(0x2029)}para` };
  const literal = jsLiteral(raw);
  assert.ok(!literal.includes(String.fromCharCode(0x2028)), 'U+2028 must not survive into generated source');
  assert.ok(!literal.includes(String.fromCharCode(0x2029)), 'U+2029 must not survive into generated source');
  assert.ok(literal.includes('\\u2028') && literal.includes('\\u2029'));
  // And it is still the same value once the platform parses it.
  assert.deepEqual(JSON.parse(literal), raw);
});

test('jsLiteral produces a literal a quote cannot escape from', () => {
  const hostile = { message: `x'); gs.info('pwned` };
  const literal = jsLiteral(hostile);
  // eslint-disable-next-line no-new-func -- exercising exactly what the platform will do with it
  const roundTripped = new Function(`return ${literal};`)();
  assert.deepEqual(roundTripped, hostile);
});

test('a qualified name must carry its scope — the runner defaults an unqualified one to global', () => {
  assert.equal(assertQualifiedName('x_2002152_nwforge.notify_manager'), 'x_2002152_nwforge.notify_manager');
  for (const bad of ['notify_manager', '', null, 'scope.name.extra', "scope.name'); evil('", 'scope.na-me', 'scope. name']) {
    assert.throws(() => assertQualifiedName(bad), /not a valid <scope>\.<internal_name>/, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('buildSubflowScript refuses a name it would have to concatenate unsafely', () => {
  assert.throws(() => buildSubflowScript({ qualified: "x.y'); gs.info('", inputs: {} }), /not a valid/);
});

test('a hostile input value lands inside a JSON literal, not in the call', () => {
  const script = buildSubflowScript({
    qualified: 'x_2002152_nwforge.notify_manager',
    inputs: { message: `'}); gs.info('escaped'); ({a:'` },
  });
  assert.ok(script.includes(".subflow('x_2002152_nwforge.notify_manager')"));
  // The value survives only as JSON — the single quotes never become code.
  const inputs = script.match(/\.withInputs\((\{.*\})\)/)[1];
  assert.deepEqual(JSON.parse(inputs), { message: `'}); gs.info('escaped'); ({a:'` });
});

test('the wrapper reports a failure the body cannot swallow', () => {
  const script = wrapScript({ body: '  throw "boom";', sinkName: 'x.sink', token: 'tok' });
  const tryAt = script.indexOf('try {');
  const catchAt = script.indexOf('} catch (e)');
  const insertAt = script.indexOf('__sink.insert();');
  assert.ok(tryAt >= 0 && catchAt > tryAt, 'the body runs inside a try/catch');
  assert.ok(insertAt > catchAt, 'the sink insert sits AFTER the catch, so a thrown body still reports');
  assert.ok(script.includes("report.ok = false; report.error = String(e);"));
});

test('the sink name and token are embedded as literals, not concatenated', () => {
  const script = wrapScript({ body: '  var x = 1;', sinkName: `x.s'ink`, token: `to'ken` });
  assert.ok(script.includes(`__sink.name = "x.s'ink";`));
  assert.ok(script.includes(`{ token: "to'ken" };`));
});

test('parseRuntimeOutputs keeps the declared contract apart from engine bookkeeping', () => {
  // Shape measured off the instance: an errored run mixes __action_status__ and
  // __dont_treat_as_error__ into the same map as the real outputs.
  const raw = JSON.stringify({
    notified: { '@class': 'com.snc.process_flow.val.OutVal', value: false, displayValue: 'false', hasValue: true },
    managerEmail: { value: '', displayValue: '', hasValue: true },
    __action_status__: { value: 'ERROR', displayValue: 'ERROR', hasValue: true },
    __dont_treat_as_error__: { value: 'false', displayValue: 'false', hasValue: true },
  });
  const { outputs, extra, error } = parseRuntimeOutputs(raw, ['notified', 'managerEmail']);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(outputs).sort(), ['managerEmail', 'notified']);
  assert.deepEqual(outputs.notified, { value: false, display: 'false', hasValue: true });
  assert.deepEqual(Object.keys(extra).sort(), ['__action_status__', '__dont_treat_as_error__']);
});

test('parseRuntimeOutputs reports unreadable storage instead of returning empty outputs', () => {
  const bad = parseRuntimeOutputs('not json at all', ['notified']);
  assert.deepEqual(bad.outputs, {});
  assert.match(bad.error, /was not JSON/);

  const notObject = parseRuntimeOutputs('42', ['notified']);
  assert.match(notObject.error, /was not an object/);
});

test('a scheduled script timeout before start is classified as execution-path blocked', () => {
  assert.equal(statusForHarnessTimeoutCause('not-started'), 'EXECUTION_PATH_BLOCKED');
  assert.equal(statusForHarnessTimeoutCause('return-channel-blocked'), 'TIMEOUT');
  assert.equal(statusForHarnessTimeoutCause('no-report'), 'TIMEOUT');
});

test('with no declared contract every key is reported rather than dropped', () => {
  const { outputs, extra } = parseRuntimeOutputs(JSON.stringify({ a: { value: 1, displayValue: '1', hasValue: true } }), []);
  assert.deepEqual(Object.keys(outputs), ['a']);
  assert.deepEqual(extra, {});
});

test('a reference input is fetched as a GlideRecord — a sys_id string is refused by the runner', () => {
  const script = buildSubflowScript({
    qualified: 'x_2002152_nwforge.escalate_to_duty_manager',
    inputs: { task: 'f83bb6f583360750b939cc65eeaad3a8', message: 'P1 on vendor hold' },
    declaredInputs: [
      { name: 'task', type: 'reference', reference: 'task' },
      { name: 'message', type: 'string' },
    ],
  });
  assert.match(script, /var __in0 = new GlideRecord\("task"\);/);
  assert.match(script, /if \(!__in0\.get\("f83bb6f583360750b939cc65eeaad3a8"\)\)/);
  // The reference goes in by VARIABLE; the string input still goes in as JSON.
  assert.match(script, /\.withInputs\(\{ "task": __in0, "message": "P1 on vendor hold" \}\)/);
});

test('a missing referenced record fails in the script, naming the table and the id', () => {
  const script = buildSubflowScript({
    qualified: 'x.y', inputs: { task: 'nope' },
    declaredInputs: [{ name: 'task', type: 'reference', reference: 'task' }],
  });
  assert.match(script, /throw 'input task: no task record ' \+ "nope";/);
});

test('an empty reference is passed as an empty value, not as an invented record', () => {
  const script = buildSubflowScript({
    qualified: 'x.y', inputs: { task: '' },
    declaredInputs: [{ name: 'task', type: 'reference', reference: 'task' }],
  });
  assert.ok(!script.includes('GlideRecord'), 'nothing should be fetched for an empty reference');
  assert.match(script, /\.withInputs\(\{ "task": "" \}\)/);
});

test('a reference input with no declared table is refused before anything is created', () => {
  assert.throws(
    () => buildSubflowScript({
      qualified: 'x.y', inputs: { task: 'abc' },
      declaredInputs: [{ name: 'task', type: 'reference', reference: null }],
    }),
    /declares no reference table/
  );
  assert.throws(
    () => buildSubflowScript({
      qualified: 'x.y', inputs: { task: 'abc' },
      declaredInputs: [{ name: 'task', type: 'reference', reference: "task'); evil('" }],
    }),
    /declares no reference table/
  );
});

test('without a contract every input is passed as a literal — the old behaviour, unchanged', () => {
  const script = buildSubflowScript({ qualified: 'x.y', inputs: { a: '1', b: 2 } });
  assert.match(script, /\.withInputs\(\{ "a": "1", "b": 2 \}\)/);
});
