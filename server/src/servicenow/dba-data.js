import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { table } from './client.js';
import { getSettings } from '../config/store.js';
import { metaQuery, cacheClear } from './dba-metadata.js';
import { getSchema, referenceLookup, getDisplayField } from './schema.js';
import { diffWrite } from './write-verify.js';
import { preflight, classifyOperation, analyzeImpact } from './dba-impact.js';
import { getDbaContext } from './dba-context.js';
import { findTableSource, removeColumn } from './dba-source.js';
import { log } from '../logging.js';

/**
 * DBA Layer 4 — data operations, and the gate for irreversible schema changes.
 *
 * This is the only layer that can destroy something. Everything in it is built
 * around one rule that the earlier phases paid for twice:
 *
 *   A RESULT IS NEVER THE ANSWER. THE READ-BACK IS THE ANSWER.
 *
 * §36 established the first half — the Table API answers 2xx for a write whose
 * fields it silently discarded. §44 established the converse — `now-sdk install`
 * exited 1 on a deployment that had already succeeded. So every mutation here
 * reads the instance back afterwards, on BOTH paths, and the read-back decides
 * what is reported. A failure is never retried automatically, because retrying
 * a delete that actually succeeded is how one mistake becomes two.
 *
 * ── THE TIERS ────────────────────────────────────────────────────────────────
 *
 *   1  value change     preview -> confirm -> write -> read back -> audit
 *                       reversible: the old value can be set again
 *   2  record delete    preview -> confirm -> delete -> read back -> audit
 *                       recoverability is read LIVE and is three-state
 *   3  irreversible     REFUSED. No rollback context is created, on any engine.
 *      schema DDL       Proceeding needs a human escalation the agent cannot
 *                       grant itself, plus export + typed phrase + impact ack.
 */

/* ── tier 1: value changes ────────────────────────────────────────────────── */

const REFERENCE_TYPES = new Set(['reference', 'glide_list']);

/**
 * Resolve what a human typed into what the field actually stores.
 *
 * "change caller to John Smith" is two problems, and the second is the
 * dangerous one: `sys_user` has a display field (`name`) and a key field
 * (`user_name`) that are different columns, so a contains-match on the display
 * finds several people and none of them may be the one meant. `referenceLookup`
 * already ranks exact-key above exact-display above starts-with above contains
 * and reports `ambiguous` when the top hit is not exact — WI-4.
 *
 * This refuses on ambiguity rather than taking the top hit. A wrong lookup in a
 * report is a wrong sentence; in a write it is the wrong record, silently, and
 * nothing downstream can tell.
 */
export async function resolveFieldValue(tableName, field, value) {
  const schema = await getSchema(tableName);
  const def = schema.fields.find((f) => f.name === field);
  if (!def) {
    return {
      ok: false,
      reason: `"${field}" is not a column on ${tableName} or anything it extends. The Table API accepts writes to `
            + 'unknown fields and discards them silently (trap #3), so this is refused rather than sent.',
    };
  }

  if (!REFERENCE_TYPES.has(def.type) || !def.reference) {
    return { ok: true, field, type: def.type, resolved: value, raw: value, resolution: 'literal' };
  }

  // Already a sys_id: confirm it exists rather than trusting its shape.
  if (/^[0-9a-f]{32}$/i.test(String(value || ''))) {
    const rows = await metaQuery(def.reference, { query: `sys_id=${value}`, fields: 'sys_id', max: 1 });
    if (!rows.length) {
      return { ok: false, reason: `No ${def.reference} record has sys_id ${value}. A well-formed sys_id that matches nothing is trap #89 — it reads exactly like a researched one.` };
    }
    const display = await getDisplayField(def.reference);
    const full = await metaQuery(def.reference, { query: `sys_id=${value}`, fields: `sys_id,${display}`, max: 1 });
    return { ok: true, field, type: def.type, references: def.reference, resolved: value, display: full[0]?.[display] ?? null, resolution: 'sys_id' };
  }

  const hits = await referenceLookup(def.reference, String(value), 10);
  if (!hits.length) {
    return { ok: false, reason: `Nothing in ${def.reference} matches "${value}".`, references: def.reference };
  }
  if (hits.ambiguous) {
    return {
      ok: false,
      needsDisambiguation: true,
      references: def.reference,
      reason: `"${value}" does not identify a single ${def.reference} record. ${hits.length} candidate(s) matched and `
            + 'the best was not an exact match. Confirm which one is meant — do not guess.',
      candidates: hits.slice(0, 10).map((h) => ({ sys_id: h.sys_id, display: h.display, matchType: h.matchType, ...(h.key ? { [h.key]: h.keyValue } : {}) })),
    };
  }
  return {
    ok: true, field, type: def.type, references: def.reference,
    resolved: hits.resolved.sys_id, display: hits.resolved.display,
    resolution: `matched ${hits.resolved.matchType} in ${def.reference}`,
  };
}

/**
 * `dba.setFieldValue` — Tier 1.
 *
 * `confirm: false` (the default) returns a PREVIEW and writes nothing: the
 * resolved value, the current value, and what would change. Nothing here
 * decides on the user's behalf that a change is wanted.
 */
export async function setFieldValue({ table: tableName, sys_id, field, value, confirm = false, why = null } = {}, ctx = {}) {
  const resolution = await resolveFieldValue(tableName, field, value);
  if (!resolution.ok) return { ok: false, stage: 'resolve', table: tableName, sys_id, field, ...resolution };

  const before = await table.get(tableName, sys_id).catch(() => null);
  if (!before) return { ok: false, stage: 'read', reason: `No ${tableName} record with sys_id ${sys_id}.` };

  const cell = before[field];
  const currentValue = cell && typeof cell === 'object' ? cell.value : cell;
  const currentDisplay = cell && typeof cell === 'object' ? cell.display_value : cell;

  const preview = {
    table: tableName,
    sys_id,
    field,
    from: { value: currentValue ?? null, display: currentDisplay ?? null },
    to: { value: resolution.resolved, display: resolution.display ?? resolution.resolved },
    resolution: resolution.resolution,
    ...(resolution.references ? { references: resolution.references } : {}),
    noChange: String(currentValue ?? '') === String(resolution.resolved ?? ''),
    reversible: true,
    reversibleNote: `Tier 1. This is a value change: setting ${field} back to ${JSON.stringify(currentValue ?? null)} restores it. `
                  + 'Nothing is destroyed, and no recovery mechanism is involved.',
  };

  if (!confirm) return { ok: true, stage: 'preview', confirmed: false, preview, note: 'Nothing was written. Re-call with confirm: true to apply.' };
  if (preview.noChange) return { ok: true, stage: 'no-change', confirmed: true, preview, note: 'The field already holds that value; no write was sent.' };

  const requested = { [field]: resolution.resolved };
  const returned = await table.update(tableName, sys_id, requested).catch((err) => ({ __error: err }));
  const failed = returned && returned.__error;

  /*
   * READ BACK ON BOTH PATHS, and never retry.
   *
   * If the write threw, the record may still have changed — a timeout is the
   * client giving up on a request the server completed (§44). Re-sending would
   * be a second write against unknown state.
   */
  const after = await table.get(tableName, sys_id).catch(() => null);
  const schema = await getSchema(tableName);
  const fieldTypes = Object.fromEntries(schema.fields.map((f) => [f.name, f.type]));
  const verification = after
    ? diffWrite({ table: tableName, operation: 'update', requested, returned: after, before, fieldTypes, hierarchy: schema.hierarchy })
    : null;

  const stored = after?.[field];
  const storedValue = stored && typeof stored === 'object' ? stored.value : stored;
  const landed = String(storedValue ?? '') === String(resolution.resolved ?? '');

  return {
    ok: landed,
    stage: landed ? 'verified' : 'verification-failed',
    confirmed: true,
    preview,
    stored: { value: storedValue ?? null, display: (stored && typeof stored === 'object' ? stored.display_value : stored) ?? null },
    verification,
    ...(failed
      ? {
        writeReportedFailure: true,
        writeError: String(failed.message || failed).slice(0, 400),
        reconciliation: landed
          ? 'The write reported an error and the read-back shows the new value stored. The read-back is the '
            + 'authority. Do NOT retry — the change is already applied.'
          : 'The write reported an error and the read-back shows the value unchanged. Nothing was applied. Fix the '
            + 'cause before re-sending; do not retry blindly.',
      }
      : {}),
    audit: auditEntry({ tool: 'dba:set_field_value', tableName, sys_id, ctx, why, before: { [field]: currentValue ?? null }, after: { [field]: storedValue ?? null }, status: landed ? 'applied' : 'unverified' }),
  };
}

/* ── tier 2: record delete ────────────────────────────────────────────────── */

/**
 * What this instance can actually recover, in the words the user gets.
 *
 * Read live every time. The three-state verdict is the whole point: on the
 * bound instance Delete Recovery captures the row and `com.snc.undelete` is
 * INACTIVE, so the honest answer is neither "recoverable in 7 days" nor "gone
 * forever" — it is "captured, and not restorable until that plugin is on".
 */
export async function deleteRecoveryStatement() {
  const ctx = await getDbaContext({ probeEngine: true }).catch(() => null);
  if (!ctx) {
    return { state: 'unknown', headline: 'The instance context could not be read, so recoverability is unknown. Treat this delete as permanent.', windowDays: null };
  }
  const op = await classifyOperation('record_delete');
  return {
    state: ctx.recovery.state,
    recordDelete: ctx.recovery.recordDelete,
    headline: ctx.recovery.headline,
    reasons: ctx.recovery.reasons,
    dbEngine: ctx.dbEngine.value,
    windowDays: op.windowDays ?? null,
    windowSource: op.windowSource ?? null,
    plugins: {
      deleteRecovery: ctx.plugins.deleteRecovery.active,
      restoreDeletedRecords: ctx.plugins.restoreDeletedRecords.active,
    },
  };
}

/** `dba.deleteRecord` — Tier 2. Preview by default; read back either way. */
export async function deleteRecord({ table: tableName, sys_id, confirm = false, why = null } = {}, ctx = {}) {
  const before = await table.get(tableName, sys_id).catch(() => null);
  if (!before) return { ok: false, stage: 'read', reason: `No ${tableName} record with sys_id ${sys_id} — nothing to delete.` };

  const display = await getDisplayField(tableName).catch(() => 'sys_id');
  const cell = before[display];
  const label = (cell && typeof cell === 'object' ? cell.display_value : cell) ?? sys_id;
  const recovery = await deleteRecoveryStatement();

  const preview = {
    table: tableName,
    sys_id,
    display: label,
    fields: Object.fromEntries(Object.entries(before).slice(0, 25).map(([k, v]) => [k, v && typeof v === 'object' ? v.display_value : v])),
    recovery,
    tier: 2,
  };

  if (!confirm) {
    return { ok: true, stage: 'preview', confirmed: false, preview, note: `Nothing was deleted. ${recovery.headline} Re-call with confirm: true to delete.` };
  }

  const res = await table.remove(tableName, sys_id).catch((err) => ({ __error: err }));
  const failed = res && res.__error;

  // The read-back decides, on both paths, and there is no retry.
  const after = await table.get(tableName, sys_id).catch(() => null);
  const gone = after === null || after === undefined;

  return {
    ok: gone,
    stage: gone ? 'verified' : 'verification-failed',
    confirmed: true,
    preview,
    readBack: gone ? 'the record is absent from the instance' : 'THE RECORD IS STILL PRESENT — the delete did not take effect',
    recovery,
    ...(failed
      ? {
        deleteReportedFailure: true,
        deleteError: String(failed.message || failed).slice(0, 400),
        reconciliation: gone
          ? 'The delete reported an error and the record is gone. The read-back is the authority; do NOT retry.'
          : 'The delete reported an error and the record is still there. Nothing was removed. Do not retry blindly — '
            + 'read the error first.',
      }
      : {}),
    audit: auditEntry({ tool: 'dba:delete_record', tableName, sys_id, ctx, why, before: { [display]: label }, after: gone ? null : { [display]: label }, status: gone ? 'applied' : 'unverified' }),
  };
}

/* ── plain record CRUD ────────────────────────────────────────────────────── */

export async function readRecord({ table: tableName, sys_id, fields = null } = {}) {
  const row = await table.get(tableName, sys_id).catch(() => null);
  if (!row) return { ok: false, reason: `No ${tableName} record with sys_id ${sys_id}.` };
  if (!fields) return { ok: true, table: tableName, sys_id, record: row };
  const wanted = String(fields).split(',').map((f) => f.trim()).filter(Boolean);
  return { ok: true, table: tableName, sys_id, record: Object.fromEntries(wanted.map((f) => [f, row[f] ?? null])) };
}

/** `dba.createRecord` — additive, and still read back field by field. */
export async function createRecord({ table: tableName, values = {}, why = null } = {}, ctx = {}) {
  const schema = await getSchema(tableName);
  const known = new Set(schema.fields.map((f) => f.name));
  const unknown = Object.keys(values).filter((k) => !known.has(k));
  if (unknown.length) {
    return {
      ok: false, stage: 'validate',
      reason: `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a column' : 'are not columns'} on ${tableName}. `
            + 'The Table API accepts unknown fields and discards them silently (trap #3), so this is refused rather than sent.',
    };
  }
  const created = await table.create(tableName, values).catch((err) => ({ __error: err }));
  if (created?.__error) return { ok: false, stage: 'create', reason: String(created.__error.message || created.__error).slice(0, 400) };

  const sysId = created.sys_id?.value ?? created.sys_id;
  const after = await table.get(tableName, sysId).catch(() => null);
  const fieldTypes = Object.fromEntries(schema.fields.map((f) => [f.name, f.type]));
  const verification = after ? diffWrite({ table: tableName, operation: 'insert', requested: values, returned: after, fieldTypes, hierarchy: schema.hierarchy }) : null;

  return {
    ok: Boolean(after),
    stage: after ? 'verified' : 'verification-failed',
    table: tableName,
    sys_id: sysId,
    verification,
    audit: auditEntry({ tool: 'dba:create_record', tableName, sys_id: sysId, ctx, why, before: null, after: values, status: verification?.status ?? 'unverified' }),
  };
}

export async function updateRecord({ table: tableName, sys_id, values = {}, confirm = false, why = null } = {}, ctx = {}) {
  const entries = Object.entries(values);
  if (entries.length !== 1) {
    return {
      ok: false, stage: 'validate',
      reason: 'updateRecord applies one field at a time so that each change is previewed, verified and audited '
            + 'individually. Call it once per field, or use set_field_value.',
    };
  }
  const [field, value] = entries[0];
  return setFieldValue({ table: tableName, sys_id, field, value, confirm, why }, ctx);
}

/* ── tier 3: the irreversible gate ────────────────────────────────────────── */

/**
 * The operations that create NO rollback context, on any engine.
 *
 * Kept as its own list rather than derived, because this is the one place where
 * a missing entry means an irreversible operation slips into a lower tier.
 */
const TIER3 = new Set(['drop_table', 'drop_column', 'truncate_table', 'rename_table', 'rename_column', 'change_column_type', 'decrease_column_width', 'reparent_column']);

export function isIrreversible(operation) {
  return TIER3.has(String(operation || ''));
}

/** The phrase a human has to type, naming the exact target so it cannot be pasted from a previous one. */
export function confirmationPhraseFor(operation, target) {
  return `${String(operation).toUpperCase().replace(/_/g, ' ')} ${target} PERMANENTLY`;
}

/**
 * Is the escalation open?
 *
 * `settings.dba.allowIrreversible` is written only by the Settings route. No
 * entry in the agent tool catalogue can reach `saveSettings`, which is asserted
 * by a test rather than left as an intention — the guarantee here is the ABSENCE
 * of a capability, and an absence is exactly what nobody notices being restored.
 */
export function escalationOpen() {
  return getSettings().dba?.allowIrreversible === true;
}

/**
 * Export the object and its data before anything is destroyed.
 *
 * Bounded and honest: it captures the metadata rows plus up to `max` data rows
 * and says how many it took. An export that silently sampled would be worse
 * than none, because it would be produced precisely when someone is about to
 * rely on it.
 */
export async function snapshotBeforeDestruction({ operation, table: tableName, field = null, max = 5000 } = {}) {
  const at = new Date().toISOString();
  const parts = {};

  parts.tableRecord = await metaQuery('sys_db_object', { query: `name=${tableName}`, fields: 'sys_id,name,label,super_class,sys_scope,sys_update_name', max: 1 });
  parts.dictionary = await metaQuery('sys_dictionary', {
    query: field ? `name=${tableName}^element=${field}` : `name=${tableName}^elementISNOTEMPTY`,
    fields: 'sys_id,name,element,internal_type,column_label,max_length,mandatory,reference,default_value,sys_scope',
    max: 2000,
  });
  parts.choices = await metaQuery('sys_choice', {
    query: field ? `name=${tableName}^element=${field}` : `name=${tableName}`,
    fields: 'sys_id,name,element,label,value,inactive', max: 2000,
  }).catch(() => []);

  // The data itself. For a column drop only that column is at risk; for a table
  // drop or truncate, every row is.
  const dataFields = field ? `sys_id,${field}` : null;
  const rows = await metaQuery(tableName, { query: '', fields: dataFields, max }).catch(() => []);
  parts.data = { rowCount: rows.length, truncated: rows.truncated === true, rows: rows.slice(0, max) };

  const payload = JSON.stringify({ at, operation, table: tableName, field, parts });
  const id = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  SNAPSHOTS.set(id, { id, at, operation, table: tableName, field, payload, bytes: payload.length, rowCount: rows.length, truncated: rows.truncated === true });
  log.warn('dba', `pre-destruction snapshot ${id} captured for ${operation} ${tableName}${field ? '.' + field : ''} (${rows.length} data rows)`);

  return {
    snapshotId: id,
    at,
    operation,
    table: tableName,
    field,
    metadataRows: parts.dictionary.length,
    choiceRows: parts.choices.length,
    dataRows: rows.length,
    dataTruncated: rows.truncated === true,
    bytes: payload.length,
    ...(rows.truncated
      ? { warning: `The data export stopped at ${max} rows and is INCOMPLETE. It is not a full backup — do not treat it as one.` }
      : {}),
    note: 'Held in this process only. It is evidence that the data existed and a source to re-create from by hand; '
        + 'it is NOT a restore mechanism, and the platform provides none for this operation.',
  };
}

const SNAPSHOTS = new Map();
export function getSnapshot(id) { return SNAPSHOTS.get(id) ?? null; }

/**
 * `dba.destructiveGate` — what it takes to proceed, and why the answer is
 * normally "you do not".
 *
 * Called with nothing but the operation and target, it REFUSES and explains.
 * That is the default and the expected outcome.
 */
export async function destructiveGate({ operation, table: tableName, field = null, snapshotId = null, typedConfirmation = null, impactAcknowledged = false } = {}) {
  if (!isIrreversible(operation)) {
    return { ok: false, reason: `${operation} is not a Tier 3 operation; it does not belong on this path.` };
  }

  const cls = await classifyOperation(operation);
  const target = field ? `${tableName}.${field}` : tableName;

  /*
   * DOES THE TARGET EXIST? Asked first, and it changes the answer.
   *
   * Before this, dropping a column that was not there reported "escalation
   * unmet" — sending someone to open the most dangerous switch in the
   * application in order to perform a no-op. Existence is cheap to check and it
   * is the more useful answer, so it comes first. Nothing is destroyed by
   * saying "there is nothing there".
   */
  const present = field
    ? await metaQuery('sys_dictionary', { query: `name=${tableName}^element=${field}`, fields: 'sys_id', max: 1 }).catch(() => null)
    : await metaQuery('sys_db_object', { query: `name=${tableName}`, fields: 'sys_id', max: 1 }).catch(() => null);
  if (present && present.length === 0) {
    return {
      ok: false,
      nothingToRemove: true,
      operation,
      target,
      tier: 3,
      reason: field
        ? `${tableName} has no column "${field}" on this instance, so there is nothing to remove. No escalation, `
          + 'export or confirmation is needed for an operation with no target.'
        : `No table named "${tableName}" exists on this instance, so there is nothing to remove.`,
    };
  }
  const phrase = confirmationPhraseFor(operation, target);
  const impact = await analyzeImpact({ table: tableName, field }).catch(() => null);

  const requirements = [
    { key: 'escalation', met: escalationOpen(), how: 'A human must enable irreversible schema operations in Settings. The agent cannot set this, and no tool can reach it.' },
    { key: 'snapshot', met: Boolean(snapshotId && getSnapshot(snapshotId)), how: 'Run dba_snapshot first and pass the snapshotId it returns.' },
    { key: 'typedConfirmation', met: typedConfirmation === phrase, how: `Type exactly: ${phrase}` },
    { key: 'impactAcknowledged', met: impactAcknowledged === true, how: 'Read the impact report and acknowledge it explicitly.' },
  ];
  const unmet = requirements.filter((r) => !r.met);

  return {
    ok: unmet.length === 0,
    operation,
    target,
    tier: 3,
    reversible: false,
    statement: `${operation} on ${target} CANNOT be undone. No rollback context is created, on any database engine, `
             + 'and no delete-recovery mechanism covers schema changes. This is refused by default.',
    reason: cls.reason ?? null,
    requiredPhrase: phrase,
    requirements,
    unmet: unmet.map((r) => ({ requirement: r.key, how: r.how })),
    impactSummary: impact && !impact.error ? { totalDependents: impact.totalDependents, bySeverity: impact.bySeverity } : null,
    ...(unmet.length ? { refused: true } : {}),
  };
}

/**
 * Execute a Tier 3 operation — only ever after `destructiveGate` returns ok.
 *
 * The metadata delete goes over the Table API against `sys_dictionary` /
 * `sys_db_object`; the gate and the read-back are the protection, not the
 * transport.
 */
export async function executeIrreversible({ operation, table: tableName, field = null, snapshotId, typedConfirmation, impactAcknowledged, why = null } = {}, ctx = {}) {
  const gate = await destructiveGate({ operation, table: tableName, field, snapshotId, typedConfirmation, impactAcknowledged });
  if (!gate.ok) return { ok: false, stage: 'gate', gate };

  if (operation !== 'drop_column' && operation !== 'drop_table') {
    return {
      ok: false, stage: 'unsupported',
      gate,
      reason: `${operation} is correctly classified and correctly gated, but this layer does not implement it. `
            + 'Renames, retypes, narrowings and truncates are performed in the platform UI under the same '
            + 'confirmations — NHA will not do them behind a REST call it cannot verify.',
    };
  }

  const target = field ? `${tableName}.${field}` : tableName;
  const rows = operation === 'drop_column'
    ? await metaQuery('sys_dictionary', { query: `name=${tableName}^element=${field}`, fields: 'sys_id,name,element', max: 1 })
    : await metaQuery('sys_db_object', { query: `name=${tableName}`, fields: 'sys_id,name', max: 1 });
  if (!rows.length) return { ok: false, stage: 'locate', gate, reason: `${target} does not exist on this instance.` };

  const metaTable = operation === 'drop_column' ? 'sys_dictionary' : 'sys_db_object';
  const res = await table.remove(metaTable, rows[0].sys_id).catch((err) => ({ __error: err }));
  const failed = res && res.__error;

  cacheClear('dba:');
  const after = operation === 'drop_column'
    ? await metaQuery('sys_dictionary', { query: `name=${tableName}^element=${field}`, fields: 'sys_id', max: 1 }).catch(() => [])
    : await metaQuery('sys_db_object', { query: `name=${tableName}`, fields: 'sys_id', max: 1 }).catch(() => []);
  const gone = after.length === 0;

  /*
   * RECONCILE THE SOURCE, or the drop undoes itself.
   *
   * MEASURED in E2: dropping a column from an SDK-managed table left the Fluent
   * source still declaring it, so the next `now-sdk install` would have silently
   * re-created it and the drop would have looked undone by accident. That
   * reconciliation was done by hand at the time; doing it by hand is exactly how
   * it gets forgotten.
   *
   * A drop against an object this application does NOT define needs no
   * reconciliation — there is no source of ours to correct — and that case
   * reports `applicable: false` rather than silently doing nothing.
   */
  const reconciliation = gone ? await reconcileSourceAfterDrop(operation, tableName, field) : { applicable: false, reason: 'nothing was dropped' };

  return {
    ok: gone,
    stage: gone ? 'verified' : 'verification-failed',
    operation,
    target,
    snapshotId,
    readBack: gone ? `${target} is absent from the instance` : `${target} IS STILL PRESENT — the drop did not take effect`,
    irreversible: true,
    statement: gone
      ? `${target} is gone. This cannot be undone — no rollback context was created and none exists to create. The `
        + `snapshot ${snapshotId} is evidence of what was there, not a restore path.`
      : `${target} is still present. Nothing was destroyed.`,
    sourceReconciliation: reconciliation,
    ...(reconciliation.applicable && !reconciliation.reconciled
      ? { sourceDivergence: 'The object was dropped on the instance and this application’s source still declares it. '
          + 'The next install would RE-CREATE it. Fix the source before installing again.' }
      : {}),
    ...(failed ? { deleteReportedFailure: true, deleteError: String(failed.message || failed).slice(0, 400) } : {}),
    audit: auditEntry({ tool: `dba:${operation}`, tableName, sys_id: rows[0].sys_id, ctx, why, before: { [target]: 'present' }, after: gone ? { [target]: 'DROPPED' } : { [target]: 'present' }, status: gone ? 'applied' : 'unverified' }),
  };
}

/**
 * After a successful drop, take the column out of the source that declared it.
 *
 * Deliberately does NOT rebuild or reinstall: that would be a second deploy
 * behind a destructive operation the caller has already confirmed once. It
 * corrects the source and says so, leaving the next ordinary install to carry
 * it — which is now a no-op for this column rather than a resurrection.
 */
async function reconcileSourceAfterDrop(operation, tableName, field) {
  if (operation !== 'drop_column') {
    return { applicable: false, reason: 'source reconciliation currently covers drop_column only' };
  }
  let found;
  try { found = await findTableSource(tableName); }
  catch (err) { return { applicable: true, reconciled: false, error: err.message }; }
  if (!found.definedIn) {
    return { applicable: false, reason: `no Fluent source in this application defines ${tableName}, so there is nothing to reconcile` };
  }
  try {
    const { text, changed, reason } = removeColumn(found.definedIn.text, field);
    if (!changed) return { applicable: true, reconciled: true, alreadyAbsent: true, reason, file: found.definedIn.file };
    await fsp.writeFile(found.definedIn.file, text, 'utf8');
    const readBack = await fsp.readFile(found.definedIn.file, 'utf8');
    return {
      applicable: true,
      reconciled: !readBack.includes(`${field}:`),
      file: found.definedIn.file,
      note: 'The column was removed from the Fluent source so the next install cannot re-create it.',
    };
  } catch (err) {
    return { applicable: true, reconciled: false, error: err.message };
  }
}

/* ── audit ────────────────────────────────────────────────────────────────── */

/**
 * The ledger row shape. Written by the tool layer, which owns the session, so
 * this module stays free of agent concerns and testable without one.
 */
function auditEntry({ tool, tableName, sys_id, ctx, why, before, after, status }) {
  return {
    tool,
    sessionId: ctx.sessionId ?? null,
    turnSeq: ctx.turnSeq ?? 0,
    descriptor: { table: tableName, sys_id: sys_id ?? null, requested: { why, before, after } },
    verification: { status, by: 'dba-data read-back', note: 'State established by reading the instance after the operation, not from the write result.' },
  };
}

export { preflight };
