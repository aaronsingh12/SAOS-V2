import { jsLiteral } from './execution-harness.js';
import { runConfirmedScript, LIVENESS } from './script-liveness.js';

/**
 * Phase 2 — the atomic role-elevation lifecycle.
 *
 * WHAT PHASE 0 PROVED, and what every line here is shaped by
 * (docs/role-elevation-phase0-ledger.md, dev442675 / Australia):
 *
 *  1. The mechanism is real. `GlideSecurityManager.get()` resolves to
 *     `com.glide.sys.security.ContextualSecurityManager` and
 *     `enableElevatedRole` / `disableElevatedRole` move `gs.hasRole()`
 *     false -> true -> false across one execution (0.3).
 *
 *  2. ATOMIC IS THE ONLY SCOPE. There is no session to hold an elevated role:
 *     NHA has no cookie jar and no ck token, and `runServerScript` dispatches a
 *     one-shot `sysauto_script` onto a POOLED scheduler worker. 0.4 left a
 *     worker deliberately elevated and re-entered the SAME worker with the role
 *     absent. So elevate, act, read back and de-elevate happen in one execution
 *     or they do not share state at all. There is no persistent-session design
 *     to fall back to, and none is offered here.
 *
 *  3. NEITHER RETURN VALUE IS A SIGNAL. `enableElevatedRole` returns
 *     `undefined`; `disableElevatedRole` returns the string `"true"`. They are
 *     asymmetric and neither reports failure, so nothing here branches on them.
 *     Every transition is asserted with `gs.hasRole()`, which was accurate on
 *     all ~15 probe executions.
 *
 *  4. `getRoles()` MUST BE COMPARED EXACTLY. The admin role set on this
 *     instance already contains `agent_security_admin` and
 *     `ais_high_security_admin`, both of which contain the substring
 *     `security_admin`. A substring check reports the role as present before
 *     any elevation has happened — it produced a false "elevation survived"
 *     reading in Phase 0's own 0.4 sweep. `rolesExactSource` below is the
 *     corrected comparison, and a test enforces that `.indexOf(` never appears
 *     in a generated elevation body.
 *
 *  5. Elevation is NOT what makes a plain `GlideRecord` write land (0.5). It
 *     flips `GlideRecordSecure`'s capability predicates. That distinction is
 *     the caller's to report honestly; this module only runs the lifecycle.
 *
 * The de-elevation is kept even though the execution boundary already performs
 * it. It costs one call, it documents intent at the point of use, and it means
 * the remainder of a long execution runs unelevated rather than trailing a
 * privilege nobody asked for.
 *
 * NOT WIRED TO `elevated_approval`. That flag is human approval for
 * IMPERSONATING AN ADMIN (server/src/agent/impersonation-ops.js) and shares
 * only a word with this feature. Role elevation has its own path throughout.
 */

/** Sentinel marker for the elevation path. Distinct from the impersonation one. */
export const ELEVATION_MARKER = 'NHA_ELEV::';

/**
 * Role names, including scoped ones (`sn_sow.sow_user`), plus the dot.
 *
 * Validated rather than trusted because the role name is embedded in generated
 * source. It goes through `jsLiteral` everywhere, so this is defence in depth
 * rather than the only guard — but a role name that cannot be spelled is a
 * caller bug worth naming at the boundary instead of debugging in a job.
 */
const ROLE_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/i;

export function assertRoleName(value, what = 'role') {
  const v = String(value ?? '');
  if (!ROLE_RE.test(v)) {
    throw new Error(
      `${what} must be a role name matching [a-z0-9_]+ with an optional single scope prefix, got ${JSON.stringify(value)}. `
      + 'Role names are discovered live from sys_user_role (Phase 1.1), never composed by hand.'
    );
  }
  return v;
}

/**
 * ES3 source for an EXACT membership test against `getRoles()`.
 *
 * `getRoles()` renders a Java collection as `[role_a, role_b, ...]`. The naive
 * `String(getRoles()).indexOf(role) >= 0` is what Phase 0 D-3 measured as a
 * false positive. This splits on the separator the platform actually emits and
 * compares whole strings.
 *
 * Exported so a test can assert the shape without an instance, and so the
 * reason it is not a one-liner stays attached to it.
 */
export function rolesExactSource(varName = '__rolesExact') {
  return [
    `  var ${varName} = function (roleName) {`,
    '    var listed = String(GlideSecurityManager.get().getRoles());',
    "    listed = listed.replace(/^\\[/, '').replace(/\\]$/, '');",
    "    var parts = listed.split(', ');",
    '    for (var ri = 0; ri < parts.length; ri++) {',
    '      if (parts[ri] === roleName) { return true; }',
    '    }',
    '    return false;',
    '  };',
  ].join('\n');
}

/**
 * ES3 source for the timeline recorder — Phase 3, in the one place that can
 * see the whole lifecycle.
 *
 * This is deliberately NOT a write to `tool_events`. That table is keyed to a
 * session and a tool call, and role elevation is neither yet: it is a
 * server-side mechanism with no tool in front of it. Emitting the events as
 * structured data on the result gives the caller exactly the rows it would
 * persist, at the moment a caller exists to persist them, without inventing a
 * fake session to hang them on. The seam is the shape of the record, not the
 * table it lands in.
 */
export function timelineSource(varName = '__stamp', sinkName = '__events') {
  return [
    `  var ${sinkName} = [];`,
    `  var ${varName} = function (eventName, data) {`,
    '    var entry = { event: eventName, at: new Date().getTime() };',
    '    if (data) { for (var ek in data) { if (data.hasOwnProperty(ek)) { entry[ek] = data[ek]; } } }',
    `    ${sinkName}.push(entry);`,
    '    return entry;',
    '  };',
  ].join('\n');
}

/**
 * The atomic wrapper: assert baseline, elevate, assert elevated, operate, read
 * back, de-elevate, assert de-elevated.
 *
 * `opSource` assigns onto the pre-declared `out` exactly as the impersonation
 * module's op sources do. It runs inside its own try/catch so that a failing
 * operation is REPORTED rather than thrown — and, critically, so that the
 * `finally` always de-elevates. An op that throws past the de-elevation would
 * leave the privilege standing for the rest of the execution.
 *
 * `requireElevation` exists for the Phase 4.2 control. Set false and the whole
 * lifecycle is skipped and the op runs bare — which is the only way to measure
 * what elevation actually bought, on the same code path, in the same shape.
 */
export function buildElevationBody({ role, opSource, requireElevation = true }) {
  const roleName = assertRoleName(role);
  if (typeof opSource !== 'string' || !opSource.trim()) {
    throw new Error('An opSource is required: an elevation that performs no operation proves nothing.');
  }

  const preamble = [
    `  var ROLE = ${jsLiteral(roleName)};`,
    rolesExactSource(),
    timelineSource(),
    '',
    '  out.elevation = { role: ROLE, session: String(gs.getSessionID()),',
    `                    requested: ${requireElevation ? 'true' : 'false'} };`,
    // Read BEFORE anything. Both signals, so the ledger's D-3 stays visible in
    // every result rather than being a footnote in a document.
    '  out.elevation.before = { has_role: gs.hasRole(ROLE), in_get_roles: __rolesExact(ROLE) };',
  ];

  if (!requireElevation) {
    /*
     * The control path. No enable, no disable — but the SAME assertions and the
     * same timeline, so a reader comparing the two results is comparing like
     * with like rather than two differently-shaped reports.
     */
    return [
      ...preamble,
      "  __stamp('CONTROL_START', { role: ROLE, has_role: out.elevation.before.has_role });",
      '  try {',
      opSource,
      "    out.phase = 'op_complete';",
      '  } catch (opError) {',
      '    out.opError = String(opError);',
      "    out.phase = 'op_failed';",
      '  }',
      "  __stamp('CONTROL_END', { role: ROLE });",
      '  out.elevation.after = { has_role: gs.hasRole(ROLE), in_get_roles: __rolesExact(ROLE) };',
      '  out.elevation.timeline = __events;',
    ].join('\n');
  }

  return [
    ...preamble,
    "  __stamp('ELEVATE_START', { role: ROLE, has_role_before: out.elevation.before.has_role });",
    '',
    // The return value is discarded ON PURPOSE (ground truth 3): it is
    // `undefined` and says nothing about success.
    '  GlideSecurityManager.get().enableElevatedRole(ROLE);',
    '  try {',
    '    out.elevation.during = { has_role: gs.hasRole(ROLE), in_get_roles: __rolesExact(ROLE) };',
    // A failed elevation must not run the operation. Phase 0 measured that a
    // denied write throws nothing and returns nothing falsy, so an op that ran
    // unelevated by accident would be indistinguishable from one that ran
    // elevated and did nothing.
    "    if (out.elevation.during.has_role !== true) { throw 'ELEVATION_ASSERT_FAILED:' + ROLE; }",
    "    __stamp('ELEVATED', { role: ROLE });",
    '',
    '    try {',
    opSource,
    "      out.phase = 'op_complete';",
    '    } catch (opError) {',
    '      out.opError = String(opError);',
    "      out.phase = 'op_failed';",
    '    }',
    '  } finally {',
    // Belt and suspenders: the execution boundary de-elevates anyway (0.4).
    // This makes the rest of THIS execution unelevated, and says so out loud.
    '    GlideSecurityManager.get().disableElevatedRole(ROLE);',
    '    out.elevation.after = { has_role: gs.hasRole(ROLE), in_get_roles: __rolesExact(ROLE) };',
    '    out.elevation.deelevated_ok = (out.elevation.after.has_role === false);',
    "    __stamp('ELEVATE_END', { role: ROLE, deelevated_ok: out.elevation.deelevated_ok });",
    '    out.elevation.timeline = __events;',
    '  }',
  ].join('\n');
}

/**
 * Run one operation inside the atomic elevation lifecycle.
 *
 * Returns the liveness verdict alongside the payload, never a bare result — "no
 * answer" and "an answer of nothing" are the two outcomes the whole
 * script-liveness layer exists to keep apart, and an elevation that silently
 * did not run is exactly the shape that would otherwise render as success.
 */
export async function runElevated({
  role, opSource, requireElevation = true, label, emit, timeoutMs,
} = {}) {
  const body = buildElevationBody({ role, opSource, requireElevation });
  return runConfirmedScript({
    body,
    label: label ?? `${requireElevation ? 'elevated' : 'control'} ${role}`,
    marker: ELEVATION_MARKER,
    timeoutMs,
    emit,
  });
}

/**
 * Read the elevation state of a fresh execution.
 *
 * Worth stating plainly, because the name invites the wrong reading: this can
 * only ever report the state of the execution IT starts. There is no ambient
 * elevation to inspect — 0.4 proved the role is gone by the time any later
 * execution begins. So a `false` here is a statement about a new worker, not
 * evidence that some earlier elevation was torn down.
 */
export async function getElevationStatus({ role, emit, timeoutMs } = {}) {
  const roleName = assertRoleName(role);
  const body = [
    `  var ROLE = ${jsLiteral(roleName)};`,
    rolesExactSource(),
    '  out.status = {',
    '    role: ROLE,',
    '    session: String(gs.getSessionID()),',
    '    has_role: gs.hasRole(ROLE),',
    '    in_get_roles: __rolesExact(ROLE),',
    '    scope: "per-execution; no ambient elevation exists between executions (Phase 0 probe 0.4)"',
    '  };',
  ].join('\n');
  const res = await runConfirmedScript({
    body, label: `elevation status ${roleName}`, marker: ELEVATION_MARKER, timeoutMs, emit,
  });
  if (res.liveness !== LIVENESS.CONFIRMED) {
    throw new Error(`Could not read the elevation status for ${roleName}: ${res.liveness} — ${res.detail}`);
  }
  return { ...res.payload.status, sentinel: res.sentinel };
}

/**
 * Did the lifecycle actually hold, end to end?
 *
 * Separated from the run so a caller cannot report "elevated" from the fact
 * that the script came back. All three transitions are checked, and the reason
 * names which one failed.
 */
export function assessElevation(payload) {
  const e = payload?.elevation;
  if (!e) return { held: false, reason: 'the execution reported no elevation block at all' };
  if (e.requested === false) {
    return { held: false, reason: 'this was the unelevated control; no elevation was requested', control: true };
  }
  if (e.before?.has_role !== false) {
    return { held: false, reason: `the baseline was not clean: hasRole(${e.role}) was already ${e.before?.has_role} before elevating` };
  }
  if (e.during?.has_role !== true) {
    return { held: false, reason: `enableElevatedRole did not take: hasRole(${e.role}) was ${e.during?.has_role} after enabling` };
  }
  if (e.deelevated_ok !== true) {
    return { held: false, reason: `de-elevation did not take: hasRole(${e.role}) was ${e.after?.has_role} after disabling` };
  }
  return { held: true, reason: null };
}
