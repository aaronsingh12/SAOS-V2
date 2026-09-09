import { table } from './client.js';
import { getSchema, getTableHierarchy } from './schema.js';
import { validateEncodedQuery, stripEndMarker } from './conditions.js';
import { chatOnce } from '../agent/providers/index.js';

/**
 * ACL analyzer — read and explain. Authoring lives in acl-authoring.js (B-3, revised).
 *
 * Writing ACLs from here is deliberately out of scope. An ACL is the one
 * artifact class where a confidently wrong write is a security incident rather
 * than a bug, and the SDK route (`sys_security_acl` as managed source, reviewed
 * and installed like any other artifact) is the only defensible way to author
 * one. This file reads what is there and says what it means.
 *
 * ── B-3 REVERSAL, RECORDED (feat/role-elevation, demo mode) ───────────────
 *
 * The paragraph above said "never author", full stop. That is no longer true,
 * and leaving it to be discovered as a contradiction would be worse than the
 * reversal itself. `acl-authoring.js` DOES author `sys_security_acl` rows, live,
 * from composed request context.
 *
 * What is unchanged: the SDK route remains the PRODUCTION path. It is
 * source-controlled, reviewable as a diff, and captured cleanly into an update
 * set like any other managed artifact. Authoring at request time displaces none
 * of that.
 *
 * What forced the change: the demo has to show role elevation doing real work,
 * and that requires authoring at request time on a running instance. Phase 0
 * probe 0.5 further showed that a plain `GlideRecord` insert here persists with
 * NO elevation, so authoring through the SDK — or through the plain API — would
 * have made the elevation lifecycle decorative. Authoring through
 * `GlideRecordSecure` is what makes elevation load-bearing and therefore
 * demonstrable.
 *
 * What is deferred: pre-production re-evaluates routing entirely. The sentence
 * this block replaces was right about the stakes, and the stakes have not
 * changed — only the scope in which we accept them has (a throwaway demo PDI,
 * with governance explicitly deferred to the hardening pass).
 *
 * See docs/role-elevation-phase0-ledger.md §10 item 7, which flagged this
 * contradiction before any authoring code was written.
 *
 * Three platform behaviours make a naive reader wrong here, and all three were
 * measured on dev442675 before this was written:
 *
 *   1. `sys_security_acl.operation` is a REFERENCE, and its sys_ids are
 *      inconsistent by design: the core operations have literal short sys_ids
 *      ("read", "write", "create", "delete", "execute"), while extended ones
 *      have ordinary 32-hex sys_ids ("report_view" is
 *      0997ab83733303005978e4b9cdf6a7b9). Reading the raw value gives a report
 *      that is half readable and half opaque, and looks like a data problem
 *      rather than a reading error. Same for `type`, where "record" is its own
 *      sys_id.
 *
 *   2. `nameSTARTSWITHincident` also matches `incident_task` — a different
 *      table, 43 of whose ACLs would land in an incident report. The only safe
 *      filter is exact name OR the name plus a dot.
 *
 *   3. ACLs are inherited. `incident` is governed by its own rows AND by every
 *      `task` row, so a report that reads one table is missing most of the
 *      answer. The hierarchy is walked, and each row says which table defined
 *      it.
 */

const ACL_TABLE = 'sys_security_acl';
const ACL_ROLE_TABLE = 'sys_security_acl_role';

/**
 * Requested fields. `decision_type` and `security_attribute` are recent
 * additions and are absent on older releases — and `sysparm_fields` DROPS an
 * unknown name without complaint (trap #4), so what came back is compared with
 * what was asked for and the difference is reported, not swallowed.
 */
const WANTED_FIELDS = [
  'sys_id', 'name', 'operation', 'type', 'active', 'admin_overrides', 'advanced',
  'condition', 'script', 'description', 'decision_type', 'security_attribute',
  'sys_created_by', 'sys_updated_on', 'sys_policy', 'sys_scope',
];

const raw = (cell) => (cell && typeof cell === 'object' ? cell.value : cell);
const shown = (cell) => (cell && typeof cell === 'object' ? (cell.display_value ?? cell.value ?? '') : (cell ?? ''));
const isSysId = (v) => /^[0-9a-f]{32}$/i.test(String(v || ''));

/**
 * Resolve an operation/type cell to a name.
 *
 * display_value is right whenever the platform sends one; the lookup map is the
 * fallback for a raw read, and for the case where the reference is dangling and
 * the display comes back as the sys_id itself. If neither can name it, the
 * sys_id is returned with a flag rather than a guess.
 */
function nameOf(cell, lookup) {
  const value = raw(cell);
  const display = shown(cell);
  if (display && !isSysId(display)) return { name: display, resolved: true, sys_id: value };
  const mapped = lookup?.get(value);
  if (mapped) return { name: mapped, resolved: true, sys_id: value };
  return { name: value || '(none)', resolved: !isSysId(value), sys_id: value };
}

async function referenceNameMap(tableName) {
  try {
    const rows = await table.query(tableName, { fields: 'sys_id,name', limit: 500, display: 'false' });
    return new Map(rows.map((r) => [r.sys_id, r.name]));
  } catch {
    return new Map(); // a report without the map degrades to sys_ids, loudly
  }
}

/**
 * Split an ACL name into the table it governs and, for a field ACL, the field.
 * "incident" → record; "incident.*" → every field; "incident.state" → one.
 */
export function splitAclName(name) {
  const text = String(name || '');
  const dot = text.indexOf('.');
  if (dot < 0) return { table: text, field: null, scope: 'record' };
  return { table: text.slice(0, dot), field: text.slice(dot + 1), scope: 'field' };
}

/**
 * Names belonging to one table: the table itself and its dotted children, and
 * nothing else. Behaviour 2 above lives here.
 */
export function belongsToTable(aclName, tableName) {
  return aclName === tableName || aclName.startsWith(`${tableName}.`);
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

/**
 * `readAcls` and `readRoles` are injected so the offline suite can drive the
 * read-restricted path — which is not a hypothetical: `sys_security_acl` is
 * itself ACL-protected, and a non-admin sees an empty list rather than an
 * error. An empty list rendered as an empty report says "this table has no
 * ACLs", which is the most dangerous sentence this feature could produce.
 */
export async function aclReport(tableName, {
  includeInherited = true,
  readAcls = null,
  readRoles = null,
  // "Is ANY ACL visible on this connection?" — the probe that separates a real
  // absence from a refused read. Injectable so the offline suite can drive both.
  probeAnyAcl = null,
  // Operation/type name maps. Injectable for the same reason as everything else
  // here: without it the offline suite silently makes two live requests per
  // report and passes on the catch, which is a test that only looks offline.
  referenceNames = referenceNameMap,
  schemaFor = getSchema,
  hierarchyFor = getTableHierarchy,
} = {}) {
  const notes = [];
  let hierarchy = [tableName];
  try {
    hierarchy = includeInherited ? await hierarchyFor(tableName) : [tableName];
  } catch (err) {
    notes.push(`The inheritance chain for ${tableName} could not be read (${err.message}); only ${tableName}'s own ACLs are shown, so inherited rules are missing.`);
  }

  // Trap #4: ask the dictionary what actually exists before requesting fields.
  let available = null;
  try {
    available = new Set((await schemaFor(ACL_TABLE)).fields.map((f) => f.name));
  } catch { /* fall through: request everything and compare what returns */ }
  const requested = available ? WANTED_FIELDS.filter((f) => available.has(f)) : WANTED_FIELDS;
  const absent = WANTED_FIELDS.filter((f) => !requested.includes(f));
  if (absent.length) {
    notes.push(`This release has no ${absent.join(', ')} on ${ACL_TABLE}; those columns are omitted rather than requested and silently dropped (trap #4).`);
  }

  const fetchAcls = readAcls || (async (t) => table.query(ACL_TABLE, {
    query: `name=${t}^ORnameSTARTSWITH${t}.`,
    fields: requested.join(','),
    limit: 500,
  }));

  const rows = [];
  const failures = [];
  for (const t of hierarchy) {
    try {
      const got = await fetchAcls(t);
      for (const r of got) {
        const name = shown(r.name) || raw(r.name);
        // Belt and braces: the query is already exact, but a customised
        // STARTSWITH behaviour would show up here rather than in the report.
        if (!belongsToTable(name, t)) continue;
        rows.push({ row: r, definedOn: t });
      }
    } catch (err) {
      failures.push({ table: t, status: err.status || null, message: err.message });
    }
  }

  // The loud half. An empty result and a refused read look identical to a
  // caller that only counts rows, so they are separated here and both are
  // reported as "you are not seeing everything", never as "there is nothing".
  const restricted = failures.length > 0;
  let visibility = 'full';
  if (restricted) visibility = 'error';
  else if (rows.length === 0) {
    let anyAclVisible = null;
    const probe = probeAnyAcl || (async () => (await table.query(ACL_TABLE, { fields: 'sys_id', limit: 1, display: 'false' })).length > 0);
    try {
      anyAclVisible = await probe();
    } catch (err) {
      failures.push({ table: ACL_TABLE, status: err.status || null, message: err.message });
      visibility = 'error';
    }
    if (anyAclVisible === false) visibility = 'restricted';
    else if (anyAclVisible === true) visibility = 'empty';
  }

  if (visibility === 'error') {
    notes.push(
      `Reading ${ACL_TABLE} failed: ${failures.map((f) => `${f.table} — ${f.message}`).join('; ')}. ` +
      `This report is INCOMPLETE. The ACL tables are themselves ACL-protected, so a user without the ` +
      `security_admin elevation sees a refusal or an empty list rather than the rules that exist.`
    );
  } else if (visibility === 'restricted') {
    notes.push(
      `No ACL rows are visible AT ALL on this connection — not for ${tableName}, and not for any table. ` +
      `That is a visibility result, not a security result: ${ACL_TABLE} is itself ACL-protected and needs the ` +
      `security_admin role elevated. Do not read this as "${tableName} has no ACLs".`
    );
  } else if (visibility === 'empty') {
    notes.push(
      `Other tables' ACLs are readable on this connection, so the empty result for ${tableName} and its parents ` +
      `is a real absence rather than a permission problem.`
    );
  }

  const [opNames, typeNames] = await Promise.all([
    referenceNames('sys_security_operation'),
    referenceNames('sys_security_type'),
  ]);

  // Roles, in chunks: an IN list of 300 sys_ids is a URL nobody's proxy likes.
  const ids = rows.map(({ row }) => raw(row.sys_id));
  // Seeded with an empty list per ACL, so "no rows came back for this one"
  // reads as "no role required" and only a failed READ can produce null. The
  // two are opposite answers — one means anyone past the condition passes, the
  // other means we do not know — and letting them share `undefined` would have
  // shown an unreadable rule as an unrestricted one.
  const rolesByAcl = new Map(ids.map((id) => [id, []]));
  const fetchRoles = readRoles || (async (chunk) => table.query(ACL_ROLE_TABLE, {
    query: `sys_security_aclIN${chunk.join(',')}`,
    fields: 'sys_security_acl,sys_user_role',
    limit: 2000,
  }));
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    if (!chunk.length) continue;
    try {
      for (const r of await fetchRoles(chunk)) {
        const aclId = raw(r.sys_security_acl);
        if (!rolesByAcl.has(aclId)) rolesByAcl.set(aclId, []);
        rolesByAcl.get(aclId).push({ sys_id: raw(r.sys_user_role), name: shown(r.sys_user_role) || raw(r.sys_user_role) });
      }
    } catch (err) {
      notes.push(`Roles for ${chunk.length} ACL(s) could not be read (${err.message}); those rows show as "roles unknown" rather than as unrestricted.`);
      for (const id of chunk) if (!rolesByAcl.get(id)?.length) rolesByAcl.set(id, null);
    }
  }

  const acls = [];
  for (const { row, definedOn } of rows) {
    const sysId = raw(row.sys_id);
    const name = shown(row.name) || raw(row.name);
    const parts = splitAclName(name);
    const op = nameOf(row.operation, opNames);
    const type = nameOf(row.type, typeNames);
    const condition = stripEndMarker(raw(row.condition) || '');
    const script = raw(row.script) || '';
    const roles = rolesByAcl.get(sysId);

    acls.push({
      sys_id: sysId,
      name,
      definedOn,
      inherited: definedOn !== tableName,
      scope: parts.scope,
      // NOT `scope` — that one is the ACL name's own part (record / field).
      // This is the APPLICATION the rule belongs to, which is a different fact
      // and the one the badge shows.
      applicationScope: raw(row.sys_scope) || null,
      field: parts.field,
      operation: op.name,
      operationResolved: op.resolved,
      type: type.name,
      active: raw(row.active) === 'true',
      admin_overrides: raw(row.admin_overrides) === 'true',
      advanced: raw(row.advanced) === 'true',
      decision_type: raw(row.decision_type) || null,
      security_attribute: raw(row.security_attribute) ? shown(row.security_attribute) : null,
      condition,
      hasScript: script.trim().length > 0,
      scriptLength: script.length,
      description: shown(row.description) || '',
      roles: roles === null ? null : roles.map((r) => r.name).sort(),
      rolesUnknown: roles === null,
      // An ACL with no roles is satisfied by role membership alone — anyone who
      // gets past the condition and script passes it.
      noRoleRequired: roles !== null && roles.length === 0,
      updated: raw(row.sys_updated_on) || null,
    });
  }

  // Conditions that name a field the table does not have. Same trap as
  // everywhere else, and it bites harder here: the clause is dropped, so the
  // ACL is BROADER than it reads.
  for (const a of acls) {
    if (!a.condition) { a.conditionCheck = null; continue; }
    const target = splitAclName(a.name).table;
    const check = await validateEncodedQuery(target, a.condition, { schemaFor });
    a.conditionCheck = check.checked
      ? { ok: check.ok, unknown: check.unknown, unparsed: check.unparsed }
      : { ok: null, unknown: [], unparsed: [], unreadable: check.readError };
  }

  const recordAcls = acls.filter((a) => a.scope === 'record' && a.type === 'record');
  const fieldAcls = acls.filter((a) => a.scope === 'field' && a.type === 'record');
  const otherTypes = acls.filter((a) => a.type !== 'record');

  const operations = [...new Set(acls.map((a) => a.operation))].sort();
  const roleNames = [...new Set(acls.flatMap((a) => a.roles || []))].sort();

  // operation × role, over RECORD ACLs — the grid a reviewer actually reads.
  const matrix = {};
  for (const op of operations) {
    matrix[op] = {};
    const forOp = recordAcls.filter((a) => a.operation === op);
    for (const role of [...roleNames, '(no role required)']) {
      const hits = forOp.filter((a) => (role === '(no role required)' ? a.noRoleRequired : (a.roles || []).includes(role)));
      if (!hits.length) continue;
      matrix[op][role] = hits.map((a) => ({
        sys_id: a.sys_id, definedOn: a.definedOn, active: a.active,
        condition: a.condition, hasScript: a.hasScript, admin_overrides: a.admin_overrides,
      }));
    }
  }

  return {
    table: tableName,
    hierarchy,
    includeInherited,
    visibility,
    complete: visibility === 'full' || visibility === 'empty',
    failures,
    fields: { requested, absent },
    counts: {
      total: acls.length,
      record: recordAcls.length,
      field: fieldAcls.length,
      inactive: acls.filter((a) => !a.active).length,
      scriptGuarded: acls.filter((a) => a.hasScript).length,
      adminOverrides: acls.filter((a) => a.admin_overrides).length,
      noRoleRequired: acls.filter((a) => a.noRoleRequired).length,
      conditionsOnUnknownFields: acls.filter((a) => a.conditionCheck?.ok === false).length,
      otherTypes: otherTypes.length,
    },
    operations,
    roles: roleNames,
    matrix,
    recordAcls,
    fieldAcls,
    otherTypes,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * Two-role diff
 * ------------------------------------------------------------------ */

/**
 * Which ACL rows NAME each role, per operation.
 *
 * Stated precisely because the obvious misreading is expensive: this is a diff
 * of what the rules GRANT ON PAPER, not a simulation of the decision engine.
 * The platform evaluates every matching ACL at each level with the most
 * specific first, and a field ACL, a condition, a script or a security
 * attribute can all deny what a table-level row appears to allow. NowHelpAssist does
 * not run that engine, and a report that implied it did would be worse than no
 * report.
 */
export async function aclDiff(tableName, roleA, roleB, options = {}) {
  const report = options.report || (await aclReport(tableName, options));
  const a = String(roleA || '').trim();
  const b = String(roleB || '').trim();
  if (!a || !b) throw Object.assign(new Error('Two role names are required.'), { status: 400 });

  const grants = (acl, role) => (acl.roles || []).includes(role);
  const rows = [];
  for (const op of report.operations) {
    const forOp = report.recordAcls.filter((x) => x.operation === op);
    const inA = forOp.filter((x) => grants(x, a));
    const inB = forOp.filter((x) => grants(x, b));
    const open = forOp.filter((x) => x.noRoleRequired);
    if (!inA.length && !inB.length && !open.length) continue;
    rows.push({
      operation: op,
      [a]: inA.map(summarise),
      [b]: inB.map(summarise),
      noRoleRequired: open.map(summarise),
      difference:
        inA.length && !inB.length ? `only ${a}` :
        !inA.length && inB.length ? `only ${b}` :
        inA.length && inB.length ? 'both' : 'neither (open to any role)',
    });
  }

  const fieldRows = [];
  for (const acl of report.fieldAcls) {
    const inA = grants(acl, a);
    const inB = grants(acl, b);
    if (!inA && !inB) continue;
    fieldRows.push({
      field: acl.field, operation: acl.operation, sys_id: acl.sys_id,
      definedOn: acl.definedOn, active: acl.active,
      [a]: inA, [b]: inB,
      difference: inA && !inB ? `only ${a}` : !inA && inB ? `only ${b}` : 'both',
    });
  }

  const onlyA = rows.filter((r) => r.difference === `only ${a}`).map((r) => r.operation);
  const onlyB = rows.filter((r) => r.difference === `only ${b}`).map((r) => r.operation);

  /*
   * The reading this diff invites, and why it is wrong for `admin`.
   *
   * Measured on incident: 99 of 143 ACLs set admin_overrides, and `admin`
   * appears by name on almost none of them. A reader who stops at the grid
   * concludes admin has less access than itil, which is backwards — the flag
   * means the rule is skipped for admin entirely, so not being named IS the
   * grant. Said out loud rather than left as a footgun.
   */
  const overrides = report.recordAcls.filter((x) => x.admin_overrides).length;
  const roleNotes = [];
  for (const role of [a, b]) {
    if (role === 'admin' && overrides) {
      roleNotes.push(
        `${overrides} of ${report.recordAcls.length} record ACLs on ${tableName} set admin_overrides, which means ` +
        `they are SKIPPED for admin. So "admin" appearing on few or no rows here is not less access — it is the ` +
        `rules not applying. Do not read this grid as admin having narrower access than ${role === a ? b : a}.`
      );
    }
  }

  return {
    adminOverrides: overrides,
    roleNotes,
    table: tableName,
    roles: [a, b],
    visibility: report.visibility,
    complete: report.complete,
    operations: rows,
    fields: fieldRows,
    summary: {
      onlyA, onlyB,
      both: rows.filter((r) => r.difference === 'both').map((r) => r.operation),
      fieldDifferences: fieldRows.filter((r) => r.difference !== 'both').length,
    },
    caveat:
      'This compares which ACL rows NAME each role. It is not an evaluation of access: the platform runs every ' +
      'matching ACL at each level, most specific first, and a field ACL, a condition, a script or a security ' +
      'attribute can deny what a table-level row appears to allow. Read it as "what the rules say", not "what ' +
      'these users can do".',
    notes: report.notes,
  };
}

function summarise(a) {
  return {
    sys_id: a.sys_id, definedOn: a.definedOn, active: a.active,
    condition: a.condition, hasScript: a.hasScript,
    admin_overrides: a.admin_overrides, description: a.description,
  };
}

/* ------------------------------------------------------------------ *
 * Plain-language explanation — read-only, and labelled
 * ------------------------------------------------------------------ */

const EXPLAIN_SYSTEM = `You explain ServiceNow access control to a technical reader who can read the rules but wants the shape of them.

You are given a STRUCTURED ACL REPORT that was read off a live instance. Explain what it says. Rules:
- Describe only what is in the report. Never infer an ACL, a role, or a condition that is not listed.
- ServiceNow evaluates ALL matching ACLs at each level (table then field), most specific first, and every one must pass. Do not claim a role "can" do something — say which rules name it.
- Call out, if present: operations with no role required, inactive rules, script-guarded rules (the script is not shown to you, only its presence), admin_overrides, and any condition flagged as naming a field that does not exist.
- If the report says visibility is not full, say so first and plainly: the reader is not seeing every rule.
- Name any one role at most twice in the whole answer. Do not enumerate the role list; the reader already has it. Summarise groups of roles instead ("the sn_incident_* roles").
- No preamble, no "As an AI". 200-350 words. Plain prose with short paragraphs; a short list only where it genuinely helps.`;

/** Compact the report to what an explanation can actually use. */
export function explanationInput(report) {
  const acl = (a) => ({
    op: a.operation, on: a.definedOn, field: a.field || undefined,
    active: a.active, roles: a.roles ?? 'unknown',
    condition: a.condition || undefined,
    script: a.hasScript || undefined,
    admin_overrides: a.admin_overrides,
    conditionNamesUnknownFields: a.conditionCheck?.ok === false ? a.conditionCheck.unknown : undefined,
  });
  return {
    table: report.table,
    inheritanceChain: report.hierarchy,
    visibility: report.visibility,
    counts: report.counts,
    operations: report.operations,
    roles: report.roles,
    recordAcls: report.recordAcls.map(acl),
    fieldAcls: report.fieldAcls.slice(0, 60).map(acl),
    fieldAclsTruncated: Math.max(0, report.fieldAcls.length - 60),
    notes: report.notes,
  };
}

/* ------------------------------------------------------------------ *
 * B-guard — degenerate output
 *
 * MEASURED, not hypothetical. The first live run of this explanation against
 * `gpt-oss:120b-cloud` produced a correct opening and then collapsed into a
 * repetition loop: the four sn_incident_* role names cycled about sixty times
 * inside one sentence before the paragraph resumed. Nothing errored — HTTP
 * 200, plausible prose either side of it.
 *
 * That output is worse than no explanation. It is presented next to a report
 * that IS accurate, so the loop reads as a finding about the instance rather
 * than as the model breaking down. The same guard covers a truncated
 * generation that stalls on a phrase, which is the other shape this failure
 * takes when a reasoning model runs out of budget mid-answer.
 * ------------------------------------------------------------------ */

const REPEAT_RUNS = { 1: 5, 2: 4, 3: 4, 4: 3, 5: 3, 6: 3 };
const WINDOW = 40;
const WINDOW_MIN_DISTINCT = 7;

/**
 * Is this text stuck? Two independent signals, because the loop does not
 * always land on a clean period:
 *
 *   consecutive n-gram repetition — "a b c d a b c d a b c d ..."
 *   low lexical variety in a long window — the same handful of tokens
 *     recycled in a changing order, which the n-gram test can miss.
 */
export function detectDegenerateRepetition(text) {
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  if (tokens.length < 30) return { ok: true };

  for (const n of Object.keys(REPEAT_RUNS).map(Number)) {
    const need = REPEAT_RUNS[n];
    for (let i = 0; i + n * need <= tokens.length; i++) {
      const gram = tokens.slice(i, i + n).join(' ');
      let runs = 1;
      while (tokens.slice(i + runs * n, i + (runs + 1) * n).join(' ') === gram) runs++;
      if (runs >= need) {
        return {
          ok: false,
          kind: 'ngram-loop',
          reason: `the phrase "${gram}" repeats ${runs} times back to back`,
          fragment: gram,
          repeats: runs,
        };
      }
    }
  }

  for (let i = 0; i + WINDOW <= tokens.length; i += 10) {
    const window = tokens.slice(i, i + WINDOW);
    const distinct = new Set(window).size;
    if (distinct < WINDOW_MIN_DISTINCT) {
      return {
        ok: false,
        kind: 'low-variety',
        reason: `a ${WINDOW}-word stretch uses only ${distinct} distinct words`,
        fragment: window.slice(0, 12).join(' '),
        repeats: WINDOW - distinct,
      };
    }
  }
  return { ok: true };
}

/**
 * Send the structured report through the configured provider.
 *
 * Read-only in every sense: nothing is written to the instance, and the model
 * is given the report rather than the ability to fetch more. The result is
 * labelled at the API boundary so the UI cannot present it as a reading of the
 * instance — it is a reading of the report.
 *
 * One retry, and it carries EVIDENCE rather than re-asking the same question:
 * the repeated fragment is quoted back. That is the A5 rule applied here — a
 * byte-identical re-ask of a non-deterministic backend is a coin flip dressed
 * up as a correction, and this backend provably ignores `seed` (trap #12), so
 * the retry has to add something the model did not have.
 *
 * `generate` is injectable so the offline suite can drive both the rejection
 * and the recovery without a model.
 */
export async function explainAclReport(report, { decoding, generate = chatOnce } = {}) {
  if (!report) throw new Error('A report is required.');
  const payload = JSON.stringify(explanationInput(report), null, 1);
  const base = `STRUCTURED ACL REPORT for ${report.table}:\n${payload}`;

  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = attempt === 1 ? base : (
      `${base}\n\n--- YOUR PREVIOUS ANSWER WAS REJECTED ---\n` +
      `It collapsed into a repetition loop: ${attempts[0].reason}. That is a generation failure, not a finding, ` +
      `and printing it next to an accurate report would read as one. Write the explanation again WITHOUT ` +
      `enumerating roles — name any role at most twice, and summarise groups ("the sn_incident_* roles").`
    );
    const text = String(await generate({ system: EXPLAIN_SYSTEM, user, maxTokens: 1600, decoding: decoding || { temperature: 0 } }) || '').trim();

    if (!text) {
      throw Object.assign(
        new Error('The model returned an empty explanation. The structured report is unaffected — it was read off the instance, not generated.'),
        { status: 422 }
      );
    }
    const check = detectDegenerateRepetition(text);
    if (check.ok) {
      return {
        generatedBy: 'llm',
        label: 'AI-generated summary of the structured report above. The report is read off the instance; this paragraph is not.',
        table: report.table,
        visibility: report.visibility,
        attempts: attempt,
        retried: attempt > 1 ? attempts[0].reason : null,
        text,
      };
    }
    attempts.push({ ...check, excerpt: text.slice(0, 400) });
  }

  throw Object.assign(
    new Error(
      `The model's explanation was rejected twice: ${attempts.map((a) => a.reason).join('; ')}. This is a generation ` +
      `failure, not a finding about ${report.table} — the structured report beside it was read off the instance and ` +
      `is unaffected. Retry, or swap to a stronger model in Settings.`
    ),
    { status: 422, detail: { attempts } }
  );
}
