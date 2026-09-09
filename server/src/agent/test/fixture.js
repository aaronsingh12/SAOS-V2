/**
 * PHASE 17 — THE DISPOSABLE RECORD, AND WHAT MAY BECOME ONE.
 *
 * ═══ THE ALLOWLIST IS THE WHOLE SAFETY ARGUMENT ═══
 *
 * A test writes to a real instance. Everything else in this phase — the
 * approval gate, the read-back, the ownership ledger, the cleanup — limits what
 * happens to a record once it exists. This list decides whether it exists at
 * all, and it is the only thing standing between "test my flow" and a fixture
 * on a table where creating a record starts a procurement, notifies a person,
 * or opens an approval somebody has to close.
 *
 * So it is a frozen literal. Not configuration, not a setting, not something a
 * request or a model can extend, and not derived from any property of a table —
 * "looks transient" is a judgement, and a judgement is exactly what must not be
 * automated here. A flow whose trigger table is not on this list is BLOCKED,
 * and BLOCKED is a useful answer.
 *
 * §47 names `incident`, and `incident` is the primary entry.
 *
 * ═══ WHY THERE IS A SECOND ENTRY, MEASURED BEFORE IT WAS ADDED ═══
 *
 * dev424910 has no flow that an incident can fire. Every active,
 * v2-readable record trigger on the instance was enumerated (25 of them) and
 * their tables are: sn_vsc_event, chg_mgt_worker, business_app_request,
 * sttrm_template, sc_request, kb_knowledge_base_request, ga_guidance_history,
 * sn_creatorstudio_*, ast_contract, change_request, sn_publications_publication,
 * ds_document_version, cmdb_data_management_task, alm_transfer_order(_line),
 * std_change_proposal. No `incident`. No `task`. And `flow_authoring` is
 * unavailable on this machine (no SDK), so one cannot be created either.
 *
 * An allowlist of exactly `incident` would therefore be a system that can never
 * run against the instance it ships on, and §49's own instruction for that case
 * is to use an existing real flow. `chg_mgt_worker` is that flow's table: a
 * transient Change Management WORKER record, created and consumed by the
 * platform's own change automation, carrying no approvals, no notifications and
 * no business meaning of its own — the instance holds ZERO of them at rest,
 * which is what a worker table looks like.
 *
 * This is a deliberate, narrow, stated widening of §47's letter in service of
 * its purpose. It is two named tables, not a rule that admits a third.
 */
import { BLOCKS } from './schemas.js';

/* ------------------------------------------------------------------ *
 * §47 — the allowlist
 * ------------------------------------------------------------------ */

export const DISPOSABLE_TABLES = Object.freeze({
  incident: Object.freeze({
    table: 'incident',
    why: '§47 names it. An incident created by a test carries no obligation to anyone until it is assigned.',
  }),
  chg_mgt_worker: Object.freeze({
    table: 'chg_mgt_worker',
    why: 'A transient Change Management worker record. Measured on dev424910: the table holds zero rows at rest, '
      + 'has no approval, notification or assignment surface, and exists to carry one unit of change automation.',
  }),
});

export const DISPOSABLE_LIST = Object.freeze(Object.keys(DISPOSABLE_TABLES));

export const isDisposable = (tableName) => Object.hasOwn(DISPOSABLE_TABLES, String(tableName ?? ''));

/* ------------------------------------------------------------------ *
 * §16 — the marker
 * ------------------------------------------------------------------ */

/**
 * The marker a fixture carries.
 *
 * §16 warns against a bare `NOWTEST`, and the reason is that two runs would
 * then be indistinguishable — which matters because a person looking at a
 * leftover record has to be able to say WHICH run left it. The task id is
 * already the durable name of this run everywhere else in the build, so it is
 * the marker too and no new identifier is minted.
 */
export const markerFor = (taskId) => `[NOWTEST:${String(taskId ?? '').trim()}]`;

/** Does this text carry a marker at all, and whose? */
export function readMarker(text) {
  const m = /\[NOWTEST:([^\]]{1,64})\]/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * Where a marker can go on this table.
 *
 * Preference order, all plain text fields a person reading the record would see
 * first. The chosen field must be one the flow does not write and the trigger
 * does not test — a marker in a field the flow overwrites is a marker that
 * disappears, and one in a field the trigger reads changes what is being
 * tested.
 */
const MARKER_CANDIDATES = Object.freeze([
  'short_description', 'description', 'message', 'comments', 'name', 'subject',
]);

const TEXT_TYPES = new Set(['string', 'translated_text', 'translated_field', 'char', 'text']);

export function chooseMarkerField({ fields, avoid = [] } = {}) {
  if (!fields) {
    return { ok: false, reason: 'no_dictionary', note: 'The dictionary for this table could not be read, so no marker field could be chosen.' };
  }
  const blocked = new Set(avoid);
  for (const name of MARKER_CANDIDATES) {
    const f = fields.get(name);
    if (!f) continue;
    if (blocked.has(name)) continue;
    if (f.readOnly === true) continue;
    if (f.type && !TEXT_TYPES.has(String(f.type))) continue;
    const max = Number(f.maxLength);
    if (Number.isFinite(max) && max > 0 && max < 60) continue;
    return { ok: true, field: name, maxLength: Number.isFinite(max) && max > 0 ? max : null };
  }
  return {
    ok: false,
    reason: 'no_marker_field',
    note: `None of ${MARKER_CANDIDATES.join(', ')} is a writable text field on this table that the flow leaves alone, `
      + 'so a fixture could not be marked as test data.',
  };
}

/* ------------------------------------------------------------------ *
 * Building the record
 * ------------------------------------------------------------------ */

/**
 * Validate fields a CALLER asked the fixture to carry, beyond the trigger's own.
 *
 * WHY THIS EXISTS. §14 is right that a fixture is built from the trigger
 * condition and nothing else — an extra field is an extra chance to satisfy
 * some other flow's trigger. But a trigger condition is not always the flow's
 * whole precondition, and this instance shows it: "Change - Refresh Impacted
 * Services" fires on `type=refresh_services^source_table=change_request` and
 * then hands `source_record` to its second action, which throws when it is
 * empty. Tested from the trigger alone the flow always errors, which is a true
 * and useful finding and is also the only finding that flow can ever produce.
 *
 * So a caller may name additional fields, and every one of them is checked
 * against the instance before it is written:
 *
 *   - it must exist in the live dictionary, or the write would be dropped;
 *   - it must not be platform-computed, because writing a derived field is
 *     silently overwritten (the plan validator refuses it too, so this is the
 *     earlier of two refusals rather than the only one);
 *   - it must not be a field the FLOW writes, because a fixture that pre-writes
 *     the effect it is about to assert is §12's trivial assertion arriving
 *     through the back door.
 *
 * It is not a way to test against an existing record. The fixture is still
 * created, owned and deleted by this run.
 */
export function validateExtraFields({ extra = {}, fields = null, effects = { required: [], conditional: [] }, derivation = () => null, table }) {
  const accepted = {};
  const rejected = [];
  const written = new Set([
    ...(effects.required ?? []).filter((e) => e.field).map((e) => e.field),
    ...(effects.conditional ?? []).filter((e) => e.field).map((e) => e.field),
  ]);

  for (const [field, value] of Object.entries(extra ?? {})) {
    if (fields && !fields.has(field)) {
      rejected.push({ field, reason: `"${field}" is not a field on ${table} in the live dictionary. A write to it would be accepted and dropped.` });
      continue;
    }
    if (derivation(table, field, { hierarchy: [table] })) {
      rejected.push({ field, reason: `${field} is computed by the platform, so writing it is accepted and overwritten.` });
      continue;
    }
    if (written.has(field)) {
      rejected.push({ field, reason: `the flow itself writes ${field}, so a fixture that pre-sets it would make the test prove nothing about that field.` });
      continue;
    }
    accepted[field] = value;
  }
  return { accepted, rejected };
}

/**
 * The fixture payload, or the reason there is none.
 *
 * @param trigger       from `triggerOf`
 * @param satisfaction  from `satisfyCondition`
 * @param effects       from `requiredEffects` — used to keep both the marker and
 *                      any caller-supplied field out of a field the flow writes
 * @param fields        Map<name, dictionaryField>, or null
 * @param taskId        the run's durable name
 * @param extra         caller-supplied fields, validated above
 *
 * IT WRITES WHAT THE TRIGGER REQUIRES, PLUS THE MARKER, PLUS ONLY WHAT WAS
 * EXPLICITLY ASKED FOR AND ACCEPTED. §14 is explicit that a fixture comes from
 * the trigger's own condition rather than from a picture of what a "realistic"
 * record looks like: every field nobody asked for is a field that might satisfy
 * some other flow's trigger, and a test that fires two flows measures neither.
 */
export function buildFixture({ trigger, satisfaction, effects = { required: [] }, fields = null, taskId, extra = {}, derivation = () => null }) {
  if (!isDisposable(trigger.table)) {
    return {
      ok: false,
      block: BLOCKS.FIXTURE_TABLE_NOT_DISPOSABLE,
      note: `This flow is triggered by records on "${trigger.table}". This build creates disposable test records on `
        + `${DISPOSABLE_LIST.join(' and ')} only, so no fixture was created and nothing was written. `
        + 'Creating a record on an arbitrary table to see what happens is not something a test may decide to do.',
    };
  }
  if (!satisfaction.ok) {
    return {
      ok: false,
      block: BLOCKS.TRIGGER_UNSUPPORTED,
      note: 'The trigger condition contains terms this build cannot turn into a record that certainly satisfies it.',
      unsupported: satisfaction.unsupported,
    };
  }

  const supplied = validateExtraFields({ extra, fields, effects, derivation, table: trigger.table });
  if (supplied.rejected.length) {
    return {
      ok: false,
      block: BLOCKS.FIXTURE_UNSATISFIABLE,
      note: `Field(s) named for this fixture cannot be written: `
        + supplied.rejected.map((r) => `${r.field} — ${r.reason}`).join(' '),
      rejected: supplied.rejected,
    };
  }

  /* The marker must survive the run and must not change what is tested. */
  const written = new Set([
    ...Object.keys(satisfaction.data ?? {}),
    ...Object.keys(supplied.accepted),
    ...(satisfaction.terms ?? []).map((t) => t.field),
    ...(effects.required ?? []).filter((e) => e.field).map((e) => e.field),
    ...(effects.conditional ?? []).filter((e) => e.field).map((e) => e.field),
  ]);
  const marker = chooseMarkerField({ fields, avoid: [...written] });
  if (!marker.ok) {
    return { ok: false, block: BLOCKS.NO_MARKER_FIELD, note: marker.note };
  }

  const stamp = markerFor(taskId);
  const label = `${stamp} NowForge flow test fixture — safe to delete`;
  const data = {
    ...satisfaction.data,
    ...supplied.accepted,
    [marker.field]: marker.maxLength ? label.slice(0, marker.maxLength) : label,
  };

  return {
    ok: true,
    table: trigger.table,
    data,
    marker: stamp,
    marker_field: marker.field,
    why_disposable: DISPOSABLE_TABLES[trigger.table].why,
    derived: satisfaction.derived ?? [],
    omitted: satisfaction.omitted ?? [],
    supplied: Object.keys(supplied.accepted),
  };
}

/* ------------------------------------------------------------------ *
 * §18 — ownership
 * ------------------------------------------------------------------ */

/**
 * The records this run created, and nothing else.
 *
 * §18 forbids cleaning up "everything matching the marker": another run's
 * leftovers are another run's business, and a marker query that matched
 * something unexpected would delete it. The ledger is a list of sys_ids this
 * run watched being created, and cleanup reads only from here.
 *
 * A sys_id is added the moment the create returns it — before verification,
 * before anything else can fail — because a record that exists and is not on
 * this list is a record nothing will ever clean up.
 */
export function ownership() {
  const owned = [];
  return {
    /** Record something this run created. Returns false if it was already known. */
    claim({ table, sys_id: sysId, marker = null }) {
      if (!/^[0-9a-f]{32}$/i.test(String(sysId ?? ''))) return false;
      const id = String(sysId).toLowerCase();
      if (owned.some((r) => r.sys_id === id && r.table === table)) return false;
      owned.push({ table, sys_id: id, marker, deleted: false, note: null });
      return true;
    },
    /** Everything claimed, in the order it was created. */
    all() { return owned.map((r) => ({ ...r })); },
    /** Still present as far as this run knows. */
    outstanding() { return owned.filter((r) => !r.deleted).map((r) => ({ ...r })); },
    /** Mark one deleted, or record why it was not. */
    settle({ sys_id: sysId, deleted, note = null }) {
      const id = String(sysId ?? '').toLowerCase();
      const row = owned.find((r) => r.sys_id === id);
      if (!row) return false;
      row.deleted = Boolean(deleted);
      row.note = note;
      return true;
    },
    get size() { return owned.length; },
  };
}

export const _internals = { MARKER_CANDIDATES, TEXT_TYPES };
