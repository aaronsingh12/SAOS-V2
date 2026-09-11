import crypto from 'node:crypto';
import { chatOnce } from '../agent/providers/index.js';
import { remediationFor } from './remediation.js';

/**
 * The remediation PROPOSAL — what the AI would do, before anything is done.
 *
 * ═══ THE MODEL SHIFT THIS FILE IMPLEMENTS ═══
 *
 * Health Assist used to refuse to propose a fix for findings that need human
 * judgement, on the grounds that a system which picks an owner is inventing an
 * accountable party. That reasoning was about the WRITE, and it was applied one
 * step too early: it stopped the AI from even suggesting.
 *
 * The boundary is now where it belongs. The AI investigates and proposes for
 * ANY finding; nothing reaches the instance until a human has read the proposal,
 * edited it if they disagree, and explicitly approved THAT version. Judgement is
 * still the human's — they just no longer have to start from a blank page.
 *
 * What survives from the old model is the part that was actually load-bearing:
 * a proposal for a judgement call must SAY it is a judgement call, state the
 * assumption it rests on, and carry its confidence. A confident-looking value
 * with no stated basis is the failure this module exists to avoid — not the
 * suggestion itself.
 *
 * ═══ WHAT THE MODEL MAY AND MAY NOT DO ═══
 *
 *  - it may propose a value for any field named by the finding's own rule;
 *  - it may NOT introduce a record. Every sys_id in a reply is checked against
 *    the finding's `target_ids`, and one that was never sent discards the WHOLE
 *    reply — a model that fabricated one target is not keying off the input;
 *  - it may NOT choose the table or the field. Those come from the rule.
 *
 * When the model is unavailable the proposal is still produced, with empty
 * values and `source: 'skeleton'`. An empty field a human fills in is honest; a
 * guessed one is not, and "the model was down" is not a reason to invent.
 */

/** A change whose value nobody has supplied yet cannot be executed. */
export const CHANGE_STATUS = Object.freeze({ READY: 'ready', NEEDS_VALUE: 'needs_value', REMOVED: 'removed' });

/**
 * Which field each rule's fix lands on.
 *
 * The rule decides this, not the model — a model free to choose the column
 * could "fix" a missing owner by writing the CI's name. `null` means the rule
 * has no single-field fix, and the proposal then carries steps the human writes
 * themselves rather than a field editor.
 */
export const FIX_FIELD = Object.freeze({
  'CMDB-OWNER': { table: 'cmdb_ci', field: 'owned_by', kind: 'reference', references: 'sys_user' },
  'CSDM-OWNER': { table: 'cmdb_ci_service', field: 'owned_by', kind: 'reference', references: 'sys_user' },
  'CSDM-LIFECYCLE': { table: 'cmdb_ci_service', field: 'life_cycle_stage', kind: 'string' },
  'CMDB-STALE': { table: 'cmdb_ci', field: 'install_status', kind: 'string' },
  'INT-HTTP': { table: 'sys_rest_message', field: 'rest_endpoint', kind: 'string' },
  'REL-SELF': { table: 'cmdb_rel_ci', field: null, kind: 'delete' },
  'REL-DUPLICATE': { table: 'cmdb_rel_ci', field: null, kind: 'delete' },
  'EVENT-UNBOUND': { table: 'em_alert', field: 'cmdb_ci', kind: 'reference', references: 'cmdb_ci' },
  'SEC-INACTIVE-ROLE': { table: 'sys_user_has_role', field: null, kind: 'delete' },
});

/**
 * The fields that might tell you the answer, per table.
 *
 * MEASURED: without these, the model was asked "who owns this CI?" while being
 * shown only the empty `owned_by` field it was meant to fill. It correctly
 * answered that it could not tell — an honest reply to a question with no
 * evidence attached, and a useless proposal.
 *
 * These are the neighbouring fields a human would actually look at: the group
 * already supporting the CI, who manages it, what it is. The record is already
 * being read in full for its current value, so this costs nothing extra and
 * turns "I cannot determine this" into "based on the support group, I suggest…"
 * — which the reviewer can then accept or overrule.
 *
 * They are CONTEXT, never the answer. The model still has to justify a value in
 * `assumption`, and a value it cannot justify is still blank.
 */
const CONTEXT_FIELDS = Object.freeze({
  cmdb_ci: ['name', 'sys_class_name', 'support_group', 'managed_by', 'assigned_to',
    'operational_status', 'install_status', 'discovery_source', 'business_criticality'],
  cmdb_ci_service: ['name', 'sys_class_name', 'support_group', 'managed_by', 'owned_by',
    'life_cycle_stage', 'life_cycle_stage_status', 'operational_status'],
  em_alert: ['number', 'source', 'node', 'resource', 'severity', 'state', 'description'],
  sys_rest_message: ['name', 'rest_endpoint', 'description'],
  sys_user_has_role: ['user', 'role', 'inherited'],
  cmdb_rel_ci: ['parent', 'child', 'type'],
});

/** The neighbouring evidence for one record, display values where they exist. */
function contextFor(tableName, row) {
  const out = {};
  for (const f of CONTEXT_FIELDS[tableName] || []) {
    const raw = row?.[f];
    if (raw == null) continue;
    const v = typeof raw === 'object' ? (raw.display_value || raw.value || '') : String(raw);
    if (v) out[f] = v;
  }
  return out;
}

const SYSTEM = [
  'You are proposing a remediation for a ServiceNow estate finding that deterministic rules already detected.',
  '',
  'Return ONLY valid JSON of this shape:',
  '{"summary":"...","reasoning":"...","risks":["..."],"reversible":true,',
  ' "validation":"...","changes":[{"sys_id":"<copied from the input>","value":"...","why":"...","assumption":"...","confidence":0.0}]}',
  '',
  'Rules you must not break:',
  '- Every sys_id MUST be copied verbatim from the RECORDS list. Never invent one, never omit one.',
  '- You do NOT choose the table or the field. They are given, and they are fixed.',
  '- `value` is what the field should be set to. If the evidence does not support a value, use "" and',
  '  say why in `assumption`. An empty value a human fills in is correct; a guessed one is not.',
  '- If `field_kind` is "reference", put the NAME or identifying text in `value` — for example "David Loo".',
  '  Do NOT output a sys_id, and do NOT leave `value` blank merely because you do not know the id: the',
  '  system resolves the name against the referenced table afterwards. Blank means you have no candidate',
  '  at all, not that you have a name without an id.',
  '- Each record carries a `context` object: the neighbouring fields on that same record.',
  '  USE IT. If the support group, managed_by or assigned_to indicates a plausible answer, propose it and',
  '  name the field you took it from in `assumption`. A suggestion a reviewer can overrule beats a blank.',
  '- `assumption` states what you inferred and from what. `confidence` is 0..1 and must be low when you inferred.',
  '- `reversible` says whether the change can be undone by writing the previous value back.',
  '- `validation` says how to confirm afterwards that the finding is actually resolved.',
  '- Do NOT claim anything has been applied. Nothing has. This is a proposal.',
].join('\n');

function unfence(text) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Check a model reply against the records that were actually sent.
 *
 * An unknown sys_id fails the WHOLE reply rather than being dropped, for the
 * same reason `explain.js` does it: a model that fabricated one entry has shown
 * it is not keying off the input, so its other entries are not trustworthy
 * either. Here the stakes are higher — these values are headed for a write.
 */
export function validateProposalReply(raw, knownIds) {
  let parsed;
  try { parsed = JSON.parse(unfence(raw)); } catch { return { ok: false, reason: 'the reply was not valid JSON' }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'the reply was not an object' };
  if (!Array.isArray(parsed.changes)) return { ok: false, reason: 'the reply carried no changes array' };

  const byId = new Map();
  for (const c of parsed.changes) {
    const id = c?.sys_id;
    if (typeof id !== 'string' || !knownIds.has(id)) {
      return { ok: false, reason: `the reply named a record that was never sent (${String(id).slice(0, 16)})` };
    }
    byId.set(id, {
      value: typeof c.value === 'string' ? c.value.slice(0, 500) : '',
      why: typeof c.why === 'string' ? c.why.slice(0, 600) : '',
      assumption: typeof c.assumption === 'string' ? c.assumption.slice(0, 600) : '',
      confidence: Number.isFinite(c.confidence) ? Math.min(1, Math.max(0, c.confidence)) : 0.5,
    });
  }
  return {
    ok: true,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 2000) : '',
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 4000) : '',
    risks: Array.isArray(parsed.risks) ? parsed.risks.filter((r) => typeof r === 'string').slice(0, 8) : [],
    reversible: parsed.reversible !== false,
    validation: typeof parsed.validation === 'string' ? parsed.validation.slice(0, 1000) : '',
    byId,
  };
}

/**
 * Build a proposal for one finding.
 *
 * `readRecord` and `generate` are INJECTED rather than imported. Injection is
 * what keeps this module out of the "talks to the instance" set — extraction is
 * the only part of `health/` that reaches the platform directly, and a second
 * importer of the client would make that invariant a comment instead of a test.
 */
export async function buildProposal(finding, {
  readRecord = null,
  resolveReference = null,
  generate = chatOnce,
  maxRecords = 25,
} = {}) {
  const remediation = remediationFor(finding);
  const fix = FIX_FIELD[finding.rule_id] || null;
  const ids = (finding.target_ids || []).slice(0, maxRecords);
  const truncated = (finding.target_ids || []).length - ids.length;

  /*
   * CURRENT VALUES, READ LIVE.
   *
   * The health check read a snapshot; the record may have moved since. The
   * "before" a reviewer sees has to be what the instance holds NOW, or the diff
   * they approve is against a state that no longer exists.
   */
  const current = new Map();
  const unreadable = [];
  if (readRecord && fix?.table) {
    for (const id of ids) {
      try {
        const row = await readRecord(fix.table, id);
        if (!row) { unreadable.push({ sys_id: id, reason: 'the record is no longer on the instance' }); continue; }
        const raw = fix.field ? row[fix.field] : null;
        current.set(id, {
          value: raw && typeof raw === 'object' ? (raw.value ?? '') : (raw ?? ''),
          display: raw && typeof raw === 'object' ? (raw.display_value ?? '') : '',
          label: row.name?.display_value || row.name?.value || row.name || row.number?.value || id,
          context: contextFor(fix.table, row),
        });
      } catch (err) {
        unreadable.push({ sys_id: id, reason: err?.message || 'could not be read' });
      }
    }
  }

  const readable = ids.filter((id) => !unreadable.some((u) => u.sys_id === id));

  /* ── Ask the model. Its failure degrades the proposal; it never blocks it. ── */
  let llm = { status: 'skeleton', note: 'No model was consulted; values are blank for you to supply.' };
  let model = null;

  if (fix && readable.length) {
    const payload = {
      rule: finding.rule_id,
      finding: finding.title,
      observed: finding.description,
      table: fix.table,
      field: fix.field,
      field_kind: fix.kind,
      ...(fix.references ? { field_references_table: fix.references } : {}),
      records: readable.map((id) => ({
        sys_id: id,
        label: current.get(id)?.label ?? id,
        current_value: current.get(id)?.display || current.get(id)?.value || '',
        /* The neighbouring fields a human would look at to answer this. They
           are evidence to reason from, not the answer. */
        context: current.get(id)?.context ?? {},
      })),
      evidence: (finding.evidence || []).slice(0, 40).map((e) => ({
        sys_id: e.sn_sys_id, field: e.field_name, value: e.field_value,
      })),
    };
    try {
      const raw = String(await generate({
        system: SYSTEM,
        user: JSON.stringify(payload),
        maxTokens: 3000,
        decoding: { temperature: 0 },
      }) || '').trim();
      if (!raw) {
        llm = { status: 'unavailable', note: 'The model returned nothing. Values are blank for you to supply.' };
      } else {
        const checked = validateProposalReply(raw, new Set(readable));
        if (checked.ok) { model = checked; llm = { status: 'complete' }; }
        else llm = { status: 'rejected', note: `The proposal was rejected because ${checked.reason}. Values are blank for you to supply.` };
      }
    } catch (err) {
      llm = { status: 'unavailable', note: `The model could not be reached (${err?.message || err}). Values are blank for you to supply.` };
    }
  } else if (!fix) {
    llm = { status: 'no_field_fix', note: 'This rule has no single-field fix, so there is nothing to propose as a record change. The manual steps are the remedy.' };
  }

  /*
   * A REFERENCE FIELD HOLDS A SYS_ID, AND THE MODEL WILL NAME A PERSON.
   *
   * Measured: asked for `owned_by`, the model found David Loo in `managed_by`
   * and then correctly proposed nothing, because it knew a name is not a
   * sys_id. Resolving it here through the app's own lookup closes that gap
   * without asking the model to invent an id.
   *
   * A lookup with exactly ONE match is used. Several matches is an ambiguity a
   * person must settle, so the value stays blank and the candidates are
   * offered; none at all leaves it blank too. Picking the first of several
   * would be the invention this whole path avoids.
   */
  const resolved = new Map();
  if (resolveReference && fix?.kind === 'reference' && fix.references && model) {
    for (const id of readable) {
      const proposedName = model.byId.get(id)?.value?.trim();
      if (!proposedName || /^[0-9a-f]{32}$/i.test(proposedName)) continue;
      try {
        const { matches } = await resolveReference(fix.references, proposedName);
        if (matches.length === 1) resolved.set(id, { ...matches[0], from: proposedName });
        else if (matches.length > 1) resolved.set(id, { ambiguous: matches.slice(0, 5), from: proposedName });
        else resolved.set(id, { none: true, from: proposedName });
      } catch { /* the lookup is best-effort; a blank value is the fallback */ }
    }
  }

  const changes = readable.map((id, i) => {
    const m = model?.byId?.get(id);
    const cur = current.get(id) || {};
    const r = resolved.get(id);
    /* A resolved single match becomes the value; anything else stays blank. */
    const proposed = r?.sys_id ?? (r ? '' : (m?.value ?? ''));
    return {
      id: `c${i + 1}`,
      table: fix?.table ?? finding.table,
      sys_id: id,
      label: cur.label ?? id,
      field: fix?.field ?? null,
      fieldKind: fix?.kind ?? null,
      references: fix?.references ?? null,
      currentValue: cur.value ?? '',
      currentDisplay: cur.display ?? '',
      proposedValue: proposed,
      /* What the sys_id MEANS, so a reviewer reads a name and not 32 hex. */
      proposedDisplay: r?.display ?? (r ? '' : (m?.value ?? '')),
      /* Offered when a name matched several records — the reviewer picks. */
      candidates: r?.ambiguous ?? null,
      resolvedFrom: r?.from ?? null,
      resolutionNote: r?.ambiguous
        ? `"${r.from}" matches ${r.ambiguous.length} records on ${fix.references}. Pick one — it was left blank rather than guessed.`
        : r?.none
          ? `"${r.from}" matched no record on ${fix.references}, so no value was set.`
          : null,
      why: m?.why ?? '',
      assumption: m?.assumption ?? '',
      confidence: m?.confidence ?? null,
      status: fix?.kind === 'delete' || proposed ? CHANGE_STATUS.READY : CHANGE_STATUS.NEEDS_VALUE,
      edited: false,
    };
  });

  return {
    findingFingerprint: finding.fingerprint,
    ruleId: finding.rule_id,
    title: finding.title,
    table: fix?.table ?? finding.table,
    field: fix?.field ?? null,
    operation: fix?.kind === 'delete' ? 'delete' : 'update',
    summary: model?.summary
      || (fix
        ? `Set ${fix.field ?? 'the affected records'} on ${changes.length} record${changes.length === 1 ? '' : 's'}. No value has been proposed — supply one below.`
        : 'This rule has no single-field fix. Follow the manual steps instead.'),
    reasoning: model?.reasoning || remediation.why,
    risks: model?.risks?.length ? model.risks : ['Not assessed by a model — review the change list yourself.'],
    reversible: fix?.kind === 'delete' ? false : (model?.reversible ?? true),
    validation: model?.validation
      || `Re-run the health check. This finding (${finding.rule_id}) should no longer list these records.`,
    changes,
    unreadable,
    truncated,
    llm,
    /*
     * A judgement call is LABELLED, not blocked. The reviewer is told the value
     * was inferred and from what; they are not told they may not have one.
     */
    needsJudgement: remediation.decision === 'human',
    judgementNote: remediation.decision === 'human'
      ? 'This finding states a fact; the value below was inferred from surrounding evidence. Check it before approving — the assumption for each record is shown with it.'
      : 'This finding states its own fix, so the change below follows from the evidence rather than from an inference.',
    manualSteps: remediation.manualSteps,
    effort: remediation.effort,
  };
}

/** Changes that would actually be executed: not removed, and carrying a value. */
export function executableChanges(proposal) {
  return (proposal?.changes || []).filter(
    (c) => c.status !== CHANGE_STATUS.REMOVED
      && (c.fieldKind === 'delete' || String(c.proposedValue ?? '').trim() !== ''),
  );
}

/**
 * The proposal as a PLAN the existing pipeline can run.
 *
 * One step per record, because that is what the executor verifies per record —
 * a batched step would read back as one result and hide a partial write.
 *
 * `verification: read_back` is not decorative: `mutation-pipeline.js` re-reads
 * the field and compares, so a 2xx that stored nothing comes back `no-op`
 * rather than success. That is the same guarantee every other write in this app
 * gets, and it is the reason the plan layer is reused instead of replaced.
 */
export function planFromProposal(proposal, { goal } = {}) {
  const changes = executableChanges(proposal);
  const steps = changes.map((c, i) => {
    const isDelete = c.fieldKind === 'delete';
    return {
      id: `step_${i + 1}`,
      operation: isDelete
        ? `delete ${c.table} ${c.sys_id}`
        : `set ${c.field} on ${c.table} ${c.sys_id}`,
      capability: isDelete ? 'record_delete' : 'record_update',
      tool: isDelete ? 'delete_record' : 'update_record',
      mechanism: 'rest',
      scope: null,
      mutating: true,
      target: { table: c.table, sys_id: c.sys_id },
      inputs: isDelete
        ? { table: c.table, sys_id: c.sys_id }
        : { table: c.table, sys_id: c.sys_id, data: { [c.field]: c.proposedValue } },
      depends_on: [],
      expected_effects: isDelete
        ? [`${c.table} ${c.sys_id} no longer exists`]
        : [`${c.field} is ${c.proposedValue}`],
      verification: isDelete
        ? { strategy: 'read_back', asserts: [`${c.sys_id} is absent`] }
        : { strategy: 'read_back', asserts: [`${c.field} == ${c.proposedValue}`] },
    };
  });

  return {
    goal: goal || `Health Assist remediation — ${proposal.ruleId}: ${proposal.title}`,
    steps,
  };
}

/**
 * A stable hash of the part of a proposal that would actually execute.
 *
 * This is what the human approves. It covers the target, the field and the
 * value — and nothing else — so editing a value produces a different hash and
 * the old approval stops applying, while re-rendering the same proposal does
 * not invalidate one. The plan layer fingerprints again on its own terms; this
 * is the drawer's own guard, checked before the plan is ever built.
 */
export function proposalFingerprint(proposal) {
  const material = executableChanges(proposal).map((c) => [
    c.table, c.sys_id, c.field ?? '', c.fieldKind === 'delete' ? '<delete>' : String(c.proposedValue ?? ''),
  ]);
  material.sort((a, b) => a.join(' ').localeCompare(b.join(' ')));
  return crypto.createHash('sha256')
    .update(JSON.stringify({ rule: proposal.ruleId, op: proposal.operation, material }))
    .digest('hex');
}
