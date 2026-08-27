import crypto from 'node:crypto';
import { table } from './client.js';
import { jsLiteral, utcStamp } from './execution-harness.js';
import { validateScriptSyntax } from './script-liveness.js';
import { assertRoleName } from './role-elevation.js';
import { assertSysId, assertIdentifier } from './role-model.js';

/**
 * The elevation SHIM — an atomic elevated write, no result-capture sink.
 *
 * WI-3 RETROFIT (was WI-1). WI-1 returned its verdict through a
 * `sys_user_preference` sink row keyed by a nonce (the harness result-capture).
 * That sink is GONE here. The shim now leaves exactly one thing behind: the
 * TARGET RECORD, tagged with the correlation nonce on write. NHA learns the
 * outcome by reading that record back over its ordinary REST path — un-elevated
 * is fine, `sys_security_acl` is REST-readable (Gate 0 A4/H6) — and comparing
 * requested vs actual field values.
 *
 * WHY THIS IS HONEST WITHOUT THE SINK. A gated write CANNOT land un-elevated
 * (WI-1: un-elevated `GlideRecordSecure.insert()` returns `"null"`, no persist).
 * So a target record present on a gated table, carrying this run's nonce, is
 * itself proof that elevation occurred — no self-report needed, and none is
 * trusted. Absence reports FAILED; it is never painted green.
 *
 * ACCEPTED TRADE-OFF (WI-3, explicit). Without the sink, a FAILED write reports
 * "did not land" (true) with no shim-internal reason. That is acceptable:
 * eligibility failures are caught up front by the WI-2 gate, and NHA must never
 * fabricate a reason or paint green on absence. Pre-dispatch we still run the
 * ES3 liveness linter (`validateScriptSyntax`) so the known silent-non-execution
 * class is caught before the job is created — cheap insurance, no sink required.
 *
 * CARRY-FORWARD INVARIANTS, all still enforced and each still tested:
 *   - the gated write is `GlideRecordSecure` ONLY (a plain GlideRecord insert on
 *     the gated table persists un-elevated — WI-1 B1a — and is banned here);
 *   - `gs.hasRole` is asserted true immediately before the write; false aborts;
 *   - success = target READ-BACK, never `insert()`/`canCreate()` (both lie);
 *   - de-elevate in `finally`, on every path;
 *   - the shim NEVER deletes `sys_update_xml` — provenance, recorded not swept.
 *
 * NOT MODEL-CALLABLE. Invoked only by the gated pipeline (elevation-shim-
 * client.js) after classifier + eligibility + approval, and by tests. Absent
 * from server/src/agent/tools.js. No role name is hardcoded — `security_admin`
 * is discovered live and handed in as `role`.
 */

/** How far back run_start is set so the scheduler claims the job immediately. */
const JOB_START_BACKDATE_MS = 60_000;
const DEFAULT_POLL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The field the nonce is tagged into on the target record, and read back by. */
export const NONCE_FIELD = 'description';
/** The throwaway probe target: an inactive ACL on a nonexistent table. */
export const PROBE_ACL_NAME = 'x_nha_wi3_probe';

/** A per-run correlation nonce. Hex only, so it never needs escaping in source. */
export function mintNonce() {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * The throwaway ACL the live proof authors: role-less, INACTIVE, on a
 * nonexistent table, its `description` carrying the nonce so NHA can read it
 * back. Built directly — a static inactive probe is the smallest gated write.
 */
export function buildProbeAclPayload({ nonce }) {
  if (!/^[0-9a-f]{32}$/.test(String(nonce || ''))) {
    throw new Error(`buildProbeAclPayload needs a 32-char hex nonce, got ${JSON.stringify(nonce)}.`);
  }
  return {
    name: PROBE_ACL_NAME,
    operation: 'read',
    type: 'record',
    active: 'false',
    admin_overrides: 'false',
    description: `NHA elevation-shim probe ${nonce} — throwaway, safe to delete`,
  };
}

/**
 * The elevated-write job body. ES3, standalone (no `out`, no sink). The proven
 * lifecycle, inlined: runner precondition -> reachability -> enable -> ASSERT
 * gs.hasRole -> GlideRecordSecure write -> finally disable.
 *
 * The `insert()` return is deliberately discarded: it lies (WI-1), and the truth
 * is the caller's target read-back. A body that cannot confirm elevation simply
 * does not write — it never falls back to a plain GlideRecord.
 */
export function buildElevatedWriteBody({ role, runnerUserSysId, table: tableName, operation = 'create', payload, sysId = null }) {
  const roleName = assertRoleName(role);
  const runner = assertSysId(runnerUserSysId, 'the runner user sys_id');
  const tbl = assertIdentifier(tableName, 'table');
  if (!payload || typeof payload !== 'object') throw new Error('An elevated write needs a payload object.');
  if (operation !== 'create' && operation !== 'update') {
    throw new Error(`buildElevatedWriteBody supports create and update only, got ${JSON.stringify(operation)} (delete/rollback is a separate WI).`);
  }
  const targetSysId = operation === 'update' ? assertSysId(sysId, 'the update target sys_id') : null;

  // The gated mutation — GlideRecordSecure ONLY, whichever operation. For update
  // the record is FETCHED by sys_id first; if it does not read back the write is
  // simply not attempted (never a plain-GlideRecord fallback). The write's return
  // (insert()/update()) is DISCARDED — it lies (WI-1); truth is the read-back.
  const writeLines = operation === 'create'
    ? [
      '        var w = new GlideRecordSecure(TARGET_TABLE);',
      '        w.initialize();',
      '        for (var k in REC) { if (REC.hasOwnProperty(k)) { w.setValue(k, REC[k]); } }',
      '        w.insert(); // return DISCARDED — truth is the target read-back',
    ]
    : [
      '        var w = new GlideRecordSecure(TARGET_TABLE);',
      '        if (w.get(SYS_ID)) {',
      '          for (var k in REC) { if (REC.hasOwnProperty(k)) { w.setValue(k, REC[k]); } }',
      '          w.update(); // return DISCARDED — truth is the read-back by sys_id',
      '        }',
    ];

  return [
    `var ROLE = ${jsLiteral(roleName)};`,
    `var RUNNER = ${jsLiteral(runner)};`,
    `var TARGET_TABLE = ${jsLiteral(tbl)};`,
    `var REC = ${jsLiteral(payload)};`,
    `var SYS_ID = ${jsLiteral(targetSysId)};`,
    'try {',
    '  // (a) runner precondition — server-side (Gate 0 H6: role record is 0 rows over REST).',
    "  var roleGr = new GlideRecord('sys_user_role');",
    "  roleGr.addQuery('name', ROLE);",
    '  roleGr.query();',
    '  var runnerHasRole = false;',
    '  if (roleGr.next()) {',
    '    var roleId = roleGr.getUniqueValue();',
    "    var hasGr = new GlideRecord('sys_user_has_role');",
    "    hasGr.addQuery('user', RUNNER);",
    "    hasGr.addQuery('role', roleId);",
    '    hasGr.query();',
    '    runnerHasRole = (hasGr.next() ? true : false);',
    '  }',
    '',
    '  // (b) reachability guard — re-assert Gate 0 A2.',
    "  var reachable = (typeof GlideSecurityManager === 'function') && (GlideSecurityManager.get() !== null);",
    '',
    '  if (runnerHasRole && reachable) {',
    '    GlideSecurityManager.get().enableElevatedRole(ROLE);',
    '    try {',
    '      // (c) ASSERT the true seam before writing. A denied write is silent,',
    '      // so an un-elevated write must never be attempted (WI-1).',
    '      if (gs.hasRole(ROLE) === true) {',
    '        // (d) the gated mutation. GlideRecordSecure ONLY.',
    ...writeLines,
    '      }',
    '    } finally {',
    '      // (g) de-elevate on every path.',
    '      GlideSecurityManager.get().disableElevatedRole(ROLE);',
    '    }',
    '  }',
    '} catch (e) {',
    '  // Swallowed on purpose: the job reports nothing, and a self-report would',
    '  // be the thing we refuse to trust. Truth is the caller reading the target.',
    '}',
  ].join('\n');
}

/**
 * Read the nonce-tagged target back over the ordinary REST path. This is the
 * ONLY success signal. Un-elevated is fine — the table is REST-readable (H6),
 * and a gated write cannot have landed un-elevated, so presence is proof.
 */
export async function readTargetByNonce({ table: tableName, nonce, name = null, nonceField = NONCE_FIELD, fields = null }) {
  const tbl = assertIdentifier(tableName, 'table');
  if (!/^[0-9a-f]{32}$/.test(String(nonce || ''))) throw new Error('readTargetByNonce needs a 32-char hex nonce.');
  const clauses = [`${nonceField}LIKE${nonce}`];
  if (name) clauses.push(`name=${name}`);
  const rows = await table.query(tbl, {
    query: clauses.join('^'),
    // The projection MUST cover every field we will compare, or an unfetched
    // field reads back empty and a clean write mis-tiers as COERCED.
    fields: fields || 'sys_id,name,operation,active,description,sys_created_by,sys_scope',
    limit: 5, display: 'false',
  }).catch(() => []);
  return rows;
}

/** The field projection a requested-vs-actual comparison needs: sys_id + every requested key. */
function fieldsForComparison(payload, nonceField) {
  const keys = new Set(['sys_id', nonceField, ...Object.keys(payload || {})]);
  return [...keys];
}

/**
 * Tier one outcome from the target read-back, comparing requested vs actual.
 *   EXECUTED — landed and every asserted field was VERIFIED to match.
 *   COERCED  — landed but a field differs, was platform-rewritten, or was
 *              asserted OUTSIDE the read-back projection (so not confirmable).
 *   FAILED   — not present.
 *
 * PROJECTION-SUPERSET GUARD (WI-4). EXECUTED is reachable only when the read-back
 * projection is a SUPERSET of every asserted field. An asserted field that was
 * not in the projection was not read, so it cannot be confirmed — treating it as
 * matched would be the M3/renderer-dishonesty class one layer down. Such a field
 * is surfaced as `unverified` and the tier is DOWNGRADED off EXECUTED. Only the
 * fields actually compared appear in `compared_fields`/`compared_detail`, so the
 * renderer's "confirmed" scope is exactly the verified scope.
 *
 * `comparedFields` is the projection actually fetched. Omitting it defaults to
 * "every requested field was projected" (back-compat) — callers that read a
 * partial projection MUST pass it so the guard can see the gap.
 * `platformOwned` names fields the platform rewrites (e.g. an ACL `description`
 * business rule) so their divergence reads as COERCED, never as a dropped write.
 */
export function assessOutcomeTier({ requested, actual, comparedFields = null, platformOwned = [] }) {
  const reqKeys = Object.keys(requested || {});
  if (!actual) {
    return { tier: 'FAILED', landed: false, sys_id: null, mismatches: [], coerced: [], unverified: reqKeys, compared_fields: [], compared_detail: [], detail: 'the target record is not present — the write did not land' };
  }
  const cell = (v) => (v && typeof v === 'object' ? (v.value ?? '') : (v ?? ''));
  const projection = comparedFields ? new Set(comparedFields) : new Set(reqKeys);
  const owned = new Set(platformOwned);
  const mismatches = [];
  const coerced = [];
  const unverified = [];        // asserted, but outside the projection — NOT confirmable
  const compared_fields = [];   // asserted AND projected — the verified scope
  const compared_detail = [];
  for (const f of reqKeys) {
    const want = String(requested[f] ?? '');
    if (!projection.has(f)) { unverified.push(f); continue; }
    const got = String(cell(actual[f]) ?? '');
    compared_fields.push(f);
    compared_detail.push({ field: f, requested: want, actual: got });
    if (want === got) continue;
    if (owned.has(f) && got !== '') coerced.push({ field: f, requested: want, actual: got });
    else mismatches.push({ field: f, requested: want, actual: got });
  }
  const base = { landed: true, sys_id: cell(actual.sys_id) || null, compared_fields, compared_detail, unverified };
  if (mismatches.length) {
    return { tier: 'COERCED', ...base, mismatches, coerced, detail: `landed, but ${mismatches.length} field(s) differ from what was requested` };
  }
  if (unverified.length) {
    // Landed, nothing seen to differ — but an asserted field was never read, so
    // this cannot be called EXECUTED. Loud, non-green.
    return { tier: 'COERCED', ...base, mismatches: [], coerced, detail: `landed, but ${unverified.length} asserted field(s) were outside the read-back projection and are NOT confirmed: ${unverified.join(', ')}` };
  }
  if (coerced.length) {
    return { tier: 'COERCED', ...base, mismatches: [], coerced, detail: `landed; ${coerced.length} platform-owned field(s) were rewritten` };
  }
  return { tier: 'EXECUTED', ...base, mismatches: [], coerced: [], detail: 'landed and every requested field matches' };
}

/**
 * Dispatch one elevated write and read the outcome off the TARGET record.
 *
 * Creates the one-shot `sysauto_script` job (the proven trigger path), reads the
 * target back over REST (by nonce for create; by sys_id, gated on a sys_mod_count
 * increment, for update), and cleans up the JOB only. It does NOT
 * create a `sys_user_preference` sink, does NOT delete `sys_update_xml` the write
 * leaves (provenance), and does NOT delete the target (forward write; the
 * acceptance test reverts through the elevated channel).
 */
export async function dispatchElevatedWrite({
  role, runnerUserSysId, table: tableName, operation = 'create', payload, nonce, sysId = null,
  name = null, platformOwned = [], nonceField = NONCE_FIELD,
  timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = DEFAULT_POLL_MS, emit = () => {},
} = {}) {
  const roleName = assertRoleName(role);
  const runner = assertSysId(runnerUserSysId, 'the runner user sys_id');
  const tbl = assertIdentifier(tableName, 'table');
  if (!/^[0-9a-f]{32}$/.test(String(nonce || ''))) throw new Error('dispatchElevatedWrite needs a 32-char hex nonce.');
  const targetSysId = operation === 'update' ? assertSysId(sysId, 'the update target sys_id') : null;

  const body = buildElevatedWriteBody({ role: roleName, runnerUserSysId: runner, table: tbl, operation, payload, sysId: targetSysId });

  // The known silent-non-execution class, caught before the job is created.
  const validation = validateScriptSyntax(body);
  if (!validation.ok) {
    return {
      dispatched: false, job: null, nonce,
      outcome: { tier: 'FAILED', landed: false, sys_id: null, mismatches: [], coerced: [], detail: `refused pre-dispatch: ${validation.errors.map((e) => e.message).join(' | ')}` },
      validation,
    };
  }

  // For an update, the "job ran" signal is a sys_mod_count INCREMENT (the field
  // value is a separate question — that is the tier). Captured before dispatch so
  // a coerced update reads back as COERCED rather than timing out as FAILED.
  let beforeMod = -1;
  if (operation === 'update') {
    const beforeRows = await table.query(tbl, { query: `sys_id=${targetSysId}`, fields: 'sys_mod_count', limit: 1, display: 'false' }).catch(() => []);
    beforeMod = Number(beforeRows[0]?.sys_mod_count ?? -1);
  }

  const jobId = crypto.randomUUID().replace(/-/g, '');
  let created = false;
  try {
    emit({ type: 'elev_job_creating', job: jobId, table: tbl, operation });
    await table.create('sysauto_script', {
      sys_id: jobId,
      name: `NHA elevated ${operation} — ${tbl}`.slice(0, 60),
      active: 'true',
      run_type: 'once',
      run_start: utcStamp(Date.now() - JOB_START_BACKDATE_MS),
      script: body,
    });
    created = true;
    emit({ type: 'elev_job_created', job: jobId });

    // The projection MUST be a superset of every asserted field (WI-4 guard).
    const projection = operation === 'update'
      ? [...new Set(['sys_id', 'sys_mod_count', ...Object.keys(payload)])]
      : fieldsForComparison(payload, nonceField);
    let actual = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      if (operation === 'update') {
        const rows = await table.query(tbl, { query: `sys_id=${targetSysId}`, fields: projection.join(','), limit: 1, display: 'false' }).catch(() => []);
        if (rows.length && Number(rows[0].sys_mod_count) > beforeMod) { actual = rows[0]; break; }
      } else {
        const rows = await readTargetByNonce({ table: tbl, nonce, name, nonceField, fields: projection.join(',') });
        if (rows.length) { actual = rows[0]; break; }
      }
      emit({ type: 'elev_waiting', remainingMs: Math.max(0, deadline - Date.now()) });
    }

    const outcome = assessOutcomeTier({ requested: payload, actual, comparedFields: projection, platformOwned });
    return { dispatched: true, job: jobId, nonce, operation, outcome, actual, validation };
  } finally {
    if (created) {
      await table.remove('sysauto_script', jobId).catch(() => {});
      const still = await table.get('sysauto_script', jobId, 'false').catch(() => null);
      emit({ type: 'elev_job_cleanup', job: jobId, deleted: still == null });
    }
  }
}
