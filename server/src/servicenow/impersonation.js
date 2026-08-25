import { jsLiteral } from './execution-harness.js';
import { runConfirmedScript, LIVENESS } from './script-liveness.js';

/**
 * M1 — transactional harness impersonation.
 *
 * WHAT PHASE 0 PROVED, and what every line here is shaped by
 * (docs/impersonation-phase0-ledger.md, dev442675 / Australia):
 *
 *  1. The harness session is ALREADY `system` impersonating `admin`. That single
 *     fact voids every guardrail the instance appears to offer.
 *  2. `isImpersonating()` is a CONSTANT `true` — before, during and after. It is
 *     never branched on here. `canImpersonate()` returned `true` for an inactive
 *     user AND for a GUID matching zero `sys_user` rows: it is not a gate, and
 *     it is not called. `gs.getUserID()` is the only identity signal, so every
 *     switch is asserted against it.
 *  3. The mechanism itself is sound: the switch lands, `gs.hasRole('admin')`
 *     genuinely drops to false (a real ACL-context change, not a label), and
 *     `impersonate()` returns the prior sys_id as documented.
 *  4. Crash safety is the EXECUTION BOUNDARY, proven by a deliberate no-`finally`
 *     leak that came back `admin` on the same pooled worker. The `finally` below
 *     is belt-and-suspenders for the rest of the current execution, not the net.
 *  5. NOTHING THROWS ON DENIAL — not a read, not a write, not a cross-scope
 *     block. So capability booleans are read BEFORE acting; there is no
 *     exception to catch and no falsy return to test.
 *  6. `getRowCount()` LIES on a secure query: it returned 0 where 6 rows were
 *     genuinely readable, and the unfiltered count before iterating. It produced
 *     a clean false "ACLs make no difference" pass during Phase 0 itself.
 *     Everything here counts by iteration, and a test enforces that.
 *
 * One bounded execution per logical op (ground truth #9: the harness timeout can
 * kill a script before its `finally` runs).
 */

/** Sentinel marker for the impersonation path, per the build pack's contract. */
export const IMPERSONATION_MARKER = 'NHA_IMP::';

export const OP_MODES = ['preflight', 'read'];

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const IDENTIFIER_RE = /^[a-z0-9_]+$/i;

/**
 * A sys_id is the one value spliced into an identity assertion, so it is
 * validated rather than trusted. Hard Rule 1 says every sys_id is
 * query-resolved at run time; this is the check that a caller actually did.
 */
export function assertSysId(value, what = 'sys_id') {
  const v = String(value ?? '');
  if (!SYS_ID_RE.test(v)) {
    throw new Error(
      `${what} must be a 32-character hex sys_id resolved live from the instance, got ${JSON.stringify(value)}. `
      + 'Never pass a literal or a re-spliced id.'
    );
  }
  return v.toLowerCase();
}

export function assertIdentifier(value, what = 'table') {
  const v = String(value ?? '');
  if (!IDENTIFIER_RE.test(v)) {
    throw new Error(`${what} must match [a-z0-9_]+, got ${JSON.stringify(value)}.`);
  }
  return v;
}

/**
 * The OP-specific operation, slotted into the wrapper.
 *
 * `compareUnsecured` additionally runs the SAME query through a plain
 * `GlideRecord`. That is a diagnostic, not a product read path: it is what
 * proves `GlideRecordSecure` is enforcing (Phase 0 measured 200 plain vs 6
 * secure for a role-less user). It is off by default so no ordinary call ever
 * pulls rows the target cannot see.
 */
function buildOpSource(op) {
  const table = assertIdentifier(op.table, 'op.table');
  const mode = op.mode ?? 'read';
  if (!OP_MODES.includes(mode)) {
    throw new Error(`op.mode must be one of ${OP_MODES.join(', ')}, got ${JSON.stringify(op.mode)}.`);
  }
  const fields = (op.fields ?? []).map((f) => assertIdentifier(f, 'op.fields[]'));
  const limit = Number.isInteger(op.limit) && op.limit > 0 ? op.limit : 200;
  const maxRows = Number.isInteger(op.maxRows) && op.maxRows >= 0 ? op.maxRows : 20;

  const preflight = [
    `      var probe = new GlideRecordSecure(${jsLiteral(table)});`,
    '      out.preflight = { canRead: probe.canRead(), canCreate: probe.canCreate(),',
    '                        canWrite: probe.canWrite(), canDelete: probe.canDelete() };',
  ].join('\n');

  if (mode === 'preflight') return preflight;

  const collect = fields.length
    ? [
      '          var row = {};',
      `          var wanted = ${jsLiteral(fields)};`,
      '          for (var fi = 0; fi < wanted.length; fi++) { row[wanted[fi]] = String(gr.getValue(wanted[fi])); }',
      '          row.sys_id = gr.getUniqueValue();',
      '          rows.push(row);',
    ].join('\n')
    : '          rows.push({ sys_id: gr.getUniqueValue() });';

  return [
    preflight,
    '',
    `      var gr = new GlideRecordSecure(${jsLiteral(table)});`,
    op.query ? `      gr.addEncodedQuery(${jsLiteral(String(op.query))});` : '',
    `      gr.setLimit(${limit});`,
    '      gr.query();',
    // COUNT BY ITERATION. getRowCount() on a secure query is measured to lie.
    '      var n = 0; var rows = [];',
    '      while (gr.next()) {',
    '        n++;',
    `        if (rows.length < ${maxRows}) {`,
    collect,
    '        }',
    '      }',
    "      out.result = { visibleRows: n, rows: rows, countedBy: 'iteration' };",
    op.compareUnsecured ? [
      '',
      '      // Diagnostic only: proves GlideRecordSecure is enforcing. Plain',
      '      // GlideRecord ignores the impersonated identity entirely.',
      `      var raw = new GlideRecord(${jsLiteral(table)});`,
      op.query ? `      raw.addEncodedQuery(${jsLiteral(String(op.query))});` : '',
      `      raw.setLimit(${limit});`,
      '      raw.query();',
      '      var rn = 0; while (raw.next()) { rn++; }',
      '      out.result.unsecuredRows = rn;',
    ].join('\n') : '',
  ].filter(Boolean).join('\n');
}

/**
 * The transactional wrapper: assert admin, switch, assert target, pre-flight,
 * operate, revert.
 *
 * Note what is NOT here: any read of `isImpersonating()`, any call to
 * `canImpersonate()`, and any `getRowCount()`. All three are measured to be
 * untrustworthy in this execution context, and tests enforce their absence.
 */
export function buildImpersonationBody({ adminSysId, targetSysId, op }) {
  const admin = assertSysId(adminSysId, 'adminSysId');
  const target = assertSysId(targetSysId, 'targetSysId');
  if (admin === target) {
    throw new Error('Refusing to impersonate the executor: target and admin sys_id are the same record.');
  }
  if (!op || typeof op !== 'object') throw new Error('An op descriptor is required.');
  const opSource = buildOpSource(op);

  return [
    `  out.identity = { admin: ${jsLiteral(admin)}, requested: ${jsLiteral(target)} };`,
    '',
    '  // Unconditional reset to a KNOWN identity. isImpersonating() is a constant',
    '  // true in this context (Phase 0 D-1) — branching on it would be branching',
    '  // on a literal, so the reset is never conditional.',
    `  new GlideImpersonate().impersonate(${jsLiteral(admin)});`,
    `  if (gs.getUserID() !== ${jsLiteral(admin)}) { throw 'IDENTITY_ASSERT_FAILED_ADMIN:' + gs.getUserID(); }`,
    "  out.phase = 'admin_confirmed';",
    '',
    `  var original = String(new GlideImpersonate().impersonate(${jsLiteral(target)}));`,
    '  out.identity.original = original;',
    '  try {',
    `    if (gs.getUserID() !== ${jsLiteral(target)}) { throw 'IDENTITY_ASSERT_FAILED_TARGET:' + gs.getUserID(); }`,
    '    out.identity.effective = gs.getUserID();',
    '    out.identity.effective_name = gs.getUserName();',
    "    out.identity.has_admin = gs.hasRole('admin');",
    "    out.phase = 'target_confirmed';",
    '',
    '    try {',
    opSource,
    "      out.phase = 'op_complete';",
    '    } catch (opError) {',
    '      out.error = String(opError);',
    "      out.phase = 'op_failed';",
    '    }',
    '  } finally {',
    '    // Belt-and-suspenders. The execution boundary is the proven net (Phase 0 P0.10).',
    `    new GlideImpersonate().impersonate(${jsLiteral(admin)});`,
    '    out.identity.reverted_to = gs.getUserID();',
    `    out.identity.revert_ok = (gs.getUserID() === ${jsLiteral(admin)});`,
    '  }',
  ].join('\n');
}

/**
 * Run one impersonated operation. Returns a liveness verdict plus the payload —
 * never a bare result, because "no answer" and "an answer of nothing" are the
 * two outcomes this whole module exists to keep apart.
 */
export async function runImpersonated({ adminSysId, targetSysId, op, label, emit, timeoutMs } = {}) {
  const body = buildImpersonationBody({ adminSysId, targetSysId, op });
  return runConfirmedScript({
    body,
    label: label ?? `impersonate ${op?.mode ?? 'read'} ${op?.table ?? ''}`.trim(),
    marker: IMPERSONATION_MARKER,
    timeoutMs,
    emit,
  });
}

/**
 * The executor's own sys_id, read live off the harness session.
 *
 * ADMIN_SYS_ID is a PARAMETER, never a literal — this is the only sanctioned way
 * to obtain it. Also reports the ambient facts that make this context unusual,
 * so a caller can see them rather than rediscover them.
 */
export async function resolveHarnessIdentity({ emit } = {}) {
  const body = [
    '  out.identity = {',
    '    user: gs.getUserID(),',
    '    name: gs.getUserName(),',
    "    has_admin: gs.hasRole('admin'),",
    '    session: String(gs.getSessionID()),',
    '    impersonating_user_name: String(gs.getImpersonatingUserName()),',
    '    is_impersonating_reported: new GlideImpersonate().isImpersonating()',
    '  };',
  ].join('\n');
  const res = await runConfirmedScript({ body, label: 'resolve harness identity', marker: IMPERSONATION_MARKER, emit });
  if (res.liveness !== LIVENESS.CONFIRMED) {
    throw new Error(`Could not resolve the harness identity: ${res.liveness} — ${res.detail}`);
  }
  const id = res.payload.identity;
  if (!SYS_ID_RE.test(String(id?.user ?? ''))) {
    throw new Error(`The harness returned an unusable executor sys_id: ${JSON.stringify(id?.user)}`);
  }
  return { ...id, sentinel: res.sentinel };
}
