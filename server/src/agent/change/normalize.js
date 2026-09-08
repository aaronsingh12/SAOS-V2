/**
 * PHASE 18 — THE CANONICAL FORM, AND THE HASH OVER IT.
 *
 * §6 asks for a representation that is deterministic, stable, order-aware and
 * non-lossy for meaningful semantics. §13 asks that equivalent artifacts not
 * produce fake changes. Those two pull in opposite directions and this file is
 * where the line between them is drawn — every field is either kept because it
 * carries meaning, or dropped because the INSTANCE proved it does not.
 *
 * ═══ WHAT THE INSTANCE PROVED, AND HOW ═══
 *
 * Flow Designer keeps a published copy of every flow in
 * `sys_hub_flow_snapshot`. Reading a flow and its own snapshot gives two states
 * of ONE artifact, and on dev424910 forty such pairs were compared: all forty
 * are semantically identical. So they are the perfect control — anything that
 * differs between a flow and its own snapshot and is NOT a real edit is, by
 * construction, transport noise.
 *
 * Measured differences between a live flow and its identical snapshot:
 *
 *   the flow's sys_id            different row, same artifact
 *   every action instance sys_id different rows, same steps
 *   every trigger instance sys_id  ditto
 *   sys_class_name               sys_hub_flow vs sys_hub_flow_snapshot
 *   sys_created_on / updated_on  when the copy was taken
 *   version / status             snapshot bookkeeping
 *
 * Measured to be IDENTICAL, and therefore kept as identity:
 *
 *   ui_id / parent_ui_id         the step's own identity, preserved by the copy
 *   order                        execution order
 *   action_type                  what the step does
 *   the decoded `values` blob    every input, verbatim
 *   the decoded trigger inputs   table, condition, strategy
 *
 * That is why step identity here is `ui_id` and not the row's sys_id, and why
 * the hash excludes every sys_id. Both are conclusions from data, not
 * assumptions, and §13's "only ignore a field when the instance proves it is
 * non-semantic" is satisfied by exactly this experiment.
 *
 * ═══ WHAT IS DELIBERATELY NOT NORMALISED (§7) ═══
 *
 * Action ORDER is preserved. Branch nesting is preserved. Input order within an
 * action is preserved. §7 permits normalising only what ServiceNow's own
 * semantics make order-independent, and nothing here is known to be — so
 * nothing is sorted except the trigger's input map, which is a keyed map and
 * has no order in the first place.
 */
import crypto from 'node:crypto';
import { SECRET_KEYS, REDACTED } from '../evidence/redact.js';

/* ------------------------------------------------------------------ *
 * Header fields that carry meaning
 * ------------------------------------------------------------------ */

/**
 * The header fields a change to which is a change to the flow.
 *
 * Everything else on the record — the sys_id, the class, the timestamps, the
 * snapshot's version and status — describes the ROW rather than the flow, and
 * a diff that reported them would report that a snapshot is a snapshot.
 */
const SEMANTIC_HEADER = Object.freeze(['name', 'description', 'active', 'type']);

/** Kept on the shape for a reader, excluded from the hash and from the diff. */
const PROVENANCE_HEADER = Object.freeze(['sys_id', 'status', 'scope', 'updated_on']);

/* ------------------------------------------------------------------ *
 * §6 — the canonical shape
 * ------------------------------------------------------------------ */

/**
 * Normalise a flow artifact into the canonical semantic form.
 *
 * @param artifact  from `readFlowArtifact`
 * @param provenance { source, read_at, ... } — carried, never hashed
 *
 * Returns `{ artifact, header, trigger, steps, references, writes, gaps,
 * complete }`. `gaps` is the artifact's own list of what could not be read, and
 * `complete` is false whenever it is non-empty — §40 turns on a partial read
 * never rendering as a whole one.
 */
export function normalizeFlow(artifact, provenance = {}) {
  if (!artifact?.flow) {
    return {
      artifact: null, header: null, trigger: null, steps: [], branches: [], calls: [],
      references: [], writes: [],
      gaps: ['The artifact could not be read at all.'], complete: false, provenance,
    };
  }

  const flow = artifact.flow;
  const gaps = [...(artifact.gaps ?? [])];

  const header = {};
  for (const f of SEMANTIC_HEADER) header[f] = normalizeScalar(flow[f]);

  const trigger = normalizeTrigger(artifact.triggers ?? [], gaps);
  const steps = (artifact.actions ?? [])
    .map((a, i) => normalizeStep(a, i, gaps))
    .sort((a, b) => a.order - b.order || String(a.id).localeCompare(String(b.id)));
  const branches = normalizeBranches(artifact.logic ?? [], gaps);
  const calls = normalizeCalls(artifact.subflow_calls ?? [], gaps);

  return {
    artifact: {
      type: 'flow',
      /* Identity is carried for a reader and is NOT part of the hash: a
       * snapshot is a different row and the same artifact. */
      sys_id: flow.sys_id ?? null,
      name: flow.name ?? null,
      ...Object.fromEntries(PROVENANCE_HEADER.filter((k) => k !== 'sys_id').map((k) => [k, flow[k] ?? null])),
    },
    header,
    trigger,
    steps,
    branches,
    calls,
    references: referencesOf(steps, trigger, calls),
    writes: writesOf(steps),
    gaps,
    complete: gaps.length === 0,
    provenance,
  };
}

/** A scalar, in one canonical spelling. `null` and `''` are the same absence. */
function normalizeScalar(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function normalizeTrigger(triggers, gaps) {
  if (!triggers.length) return null;
  if (triggers.length > 1) {
    /* Kept as a list rather than collapsed: two triggers is a real shape and a
     * diff between one and two of them is a real change. */
    gaps.push(`This flow has ${triggers.length} triggers; each is compared separately.`);
  }
  const t = triggers[0];
  return {
    kind: normalizeScalar(t.type),
    table: normalizeScalar(t.table),
    /* The raw encoded query, never the display-substituted one. `condition`
     * prefers displayValue, which puts labels into a query and would report a
     * relabelled reference as a condition change. */
    condition: normalizeScalar(t.condition_query),
    strategy: normalizeScalar(t.strategy),
    /* The label is carried for a reader and excluded from the hash: it is the
     * display side of `table`, and §19's rule applies to it. */
    table_label: normalizeScalar(t.table_label),
    count: triggers.length,
  };
}

/**
 * One action, canonically.
 *
 * `id` is the step's identity across states. Measured: `ui_id` survives the
 * snapshot copy where the row's sys_id does not, so it is the only field that
 * can answer "is this the same step". A step with no `ui_id` falls back to its
 * position and type, and says so — an identity this build had to invent is
 * marked so the diff can decline to call it MOVED.
 */
function normalizeStep(action, index, gaps) {
  const uiId = normalizeScalar(action.ui_id);
  if (!action.inputs_readable) {
    gaps.push(`Action ${uiId ?? `#${index + 1}`} has inputs that could not be decoded.`);
  }
  return {
    id: uiId ?? `position:${index}:${normalizeScalar(action.type_name) ?? 'unknown'}`,
    identity: uiId ? 'ui_id' : 'position',
    order: Number(action.order ?? index),
    type: normalizeScalar(action.type_name),
    parent: normalizeScalar(action.parent_ui_id),
    readable: action.inputs_readable !== false,
    /* A keyed map: an input is identified by its name, and the order the
     * platform happened to serialise them in carries no meaning. */
    inputs: Object.fromEntries(
      (action.inputs ?? [])
        .filter((i) => i.name)
        .map((i) => [i.name, normalizeInput(i, i.name)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  };
}

/**
 * One input.
 *
 * §18/§19 live here. `value` is what the flow supplies and is the semantic
 * content; `display` is the label the platform rendered beside it and is NOT.
 * They are kept as separate fields so the diff can compare one and show the
 * other, which is the whole of §19.
 */
/*
 * §57/§63.13 — A SECRET NEVER ENTERS THE NORMALISED FORM.
 *
 * A flow action can carry a credential in an input: a REST step with a
 * `password`, an outbound call with an `api_key`. Everything downstream of this
 * function handles what it returns — the diff, the evidence entries, the
 * rendered report, and the baseline stored in `agent_tasks.metadata_json` — so
 * a plaintext value here becomes a plaintext value in all four.
 *
 * REDACTING AT THE BOUNDARY, NOT AT THE EXITS, is what makes that impossible
 * rather than merely unlikely: there is no path by which a caller obtains the
 * value and forgets to mask it, because this module never hands it out.
 *
 * BUT A REDACTED VALUE MUST STILL BE COMPARABLE. Replacing every secret with
 * one constant would make two DIFFERENT passwords compare equal — a real
 * semantic change silently normalised away, which §63.3 makes its own release
 * blocker. So the value is replaced by a short digest OF itself: equal secrets
 * produce equal digests and different ones do not, the artifact hash still
 * moves when a credential is rotated, and the plaintext is not recoverable
 * from anything this domain produces.
 *
 * The key list is imported from the existing redactor rather than restated, so
 * §57's "do not create another redaction implementation" holds — this is not a
 * second redactor, it is the same list used to decline to carry a value.
 */
const isSecretName = (name) => {
  const n = String(name ?? '').toLowerCase();
  return SECRET_KEYS.some((k) => n.includes(k));
};

/** A stable, non-reversible stand-in that preserves equality and nothing else. */
const fingerprintSecret = (value) => (value === null || value === undefined
  ? null
  : `${REDACTED}:${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`);

/**
 * A field map with any credential-named field masked, or the text unchanged.
 *
 * MEASURED GAP, and the reason this exists as well as the name check above. An
 * Update Record's credential does not arrive in an input called `password`; it
 * arrives inside an input called `values`, as `api_key=sk-live-9999^state=2`.
 * The input's own name reveals nothing, so masking by input name alone left the
 * plaintext in the normalised form and therefore in the stored baseline.
 *
 * Only text that actually parses as a field map is touched. A plain string
 * value is returned as it was: mangling one would be inventing a difference,
 * which is the other half of this file's job.
 */
function redactFieldMap(text) {
  if (typeof text !== 'string' || !text.includes('=')) return text;
  let touched = false;
  const out = text.split('^').map((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) return pair;
    const field = pair.slice(0, at).trim();
    if (!/^[a-z][a-z0-9_.]*$/i.test(field) || !isSecretName(field)) return pair;
    touched = true;
    return `${field}=${fingerprintSecret(pair.slice(at + 1))}`;
  });
  return touched ? out.join('^') : text;
}

function normalizeInput(i, name = null) {
  const secret = isSecretName(name ?? i?.name);
  const plain = redactFieldMap(normalizeScalar(i.supplied));
  return {
    value: secret ? fingerprintSecret(plain) : plain,
    /* A display value beside a credential is just as likely to be one. */
    display: secret ? (i.display ? REDACTED : null) : normalizeScalar(i.display),
    secret,
    is_pill: Boolean(i.is_pill),
    type: normalizeScalar(i.type),
    reference: normalizeScalar(i.reference),
    mandatory: Boolean(i.mandatory),
  };
}

/* ------------------------------------------------------------------ *
 * §20 — what the flow depends on
 * ------------------------------------------------------------------ */

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * Every dependency the artifact ITSELF establishes.
 *
 * §20 is strict: declare a dependency only where artifact or schema evidence
 * establishes it. So each entry below points at something the artifact names in
 * a field the platform declared for that purpose — a reference input's
 * `reference` table, a trigger's table, an action's type. Nothing is inferred
 * from a value that merely looks like an identity.
 */
/**
 * The IF / ELSE / FOR EACH containers.
 *
 * FOUND BY REVIEW, AND IT WAS THE WORST DEFECT IN THE PHASE. These were read by
 * `readFlowArtifact` and dropped here, so a flow with twenty-two containers
 * normalised to its actions alone and compared clean against anything sharing
 * them. `complete` stayed true and the report said "the two states are
 * identical" — a confident, wrong answer, and precisely what §63.3 makes a
 * release blocker.
 *
 * WHAT IS COMPARED, AND WHAT HONESTLY IS NOT. A container's identity, its
 * definition (the sys_id naming If / Else / For Each), its position and its
 * nesting are compared. Its CONDITION is not: that lives in a blob this build
 * does not fetch, and pretending otherwise would be the opposite mistake. So a
 * gap is stated for every flow that has one, `complete` goes false, and the
 * report says which part was not looked at. A stated gap and a silent drop are
 * different things, and only one of them is honest.
 */
function normalizeBranches(logic, gaps) {
  if (!logic.length) return [];
  gaps.push(`This flow has ${logic.length} branch container(s). Whether one was added, removed, `
    + 'retyped or reordered IS compared; the conditions inside them are not read by this build, and are not.');
  return logic
    .map((l, i) => ({
      id: normalizeScalar(l.ui_id) ?? `position:${i}:${normalizeScalar(l.definition) ?? 'unknown'}`,
      identity: l.ui_id ? 'ui_id' : 'position',
      order: Number(l.order ?? i),
      /* The identity of the container type, never the word beside it. */
      definition: normalizeScalar(l.definition),
      definition_label: normalizeScalar(l.definition_label),
      parent: normalizeScalar(l.parent_ui_id),
    }))
    .sort((x, y) => x.order - y.order || String(x.id).localeCompare(String(y.id)));
}

/**
 * The calls this flow makes to other flows.
 *
 * The same defect as the branches and a sharper one: a subflow call is a
 * DEPENDENCY on another artifact, so repointing one changes what the flow does
 * AND what has to exist for it to work. It was invisible to the diff and to the
 * hash.
 *
 * `target` is the subflow's sys_id and `target_name` is its label. Only the
 * first is ever compared, for the reason §18 gives about every other reference.
 */
function normalizeCalls(calls, gaps) {
  return calls
    .map((c, i) => {
      if (!c.subflow) gaps.push(`A subflow call at position ${c.order ?? i} names no target.`);
      return {
        id: normalizeScalar(c.ui_id) ?? `position:${i}:${normalizeScalar(c.subflow) ?? 'unknown'}`,
        identity: c.ui_id ? 'ui_id' : 'position',
        order: Number(c.order ?? i),
        target: normalizeScalar(c.subflow),
        target_name: normalizeScalar(c.subflow_name),
        wait: Boolean(c.wait),
        parent: normalizeScalar(c.parent_ui_id),
        inputs: Object.fromEntries(
          Object.entries(c.inputs ?? {})
            .map(([k, v]) => [k, normalizeScalar(v)])
            .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
        ),
      };
    })
    .sort((x, y) => x.order - y.order || String(x.id).localeCompare(String(y.id)));
}

function referencesOf(steps, trigger, calls = []) {
  const out = [];
  if (trigger?.table) {
    out.push({ kind: 'table', target: trigger.table, via: 'trigger.table' });
  }
  /* A call to another flow is a dependency on another artifact, and one of the
   * few this build can name by identity rather than by label. */
  for (const c of calls) {
    if (c.target) {
      out.push({ kind: 'subflow', target: c.target, display: c.target_name, via: `calls[${c.id}].target` });
    }
  }
  for (const s of steps) {
    if (s.type) out.push({ kind: 'action', target: s.type, via: `steps[${s.id}].type` });
    for (const [name, input] of Object.entries(s.inputs)) {
      if (input.reference && input.value && !input.is_pill) {
        out.push({
          kind: 'record',
          target: input.value,
          table: input.reference,
          display: input.display,
          via: `steps[${s.id}].inputs.${name}`,
          is_identity: SYS_ID_RE.test(input.value),
        });
      }
      if (name === 'table_name' && input.value && !input.is_pill) {
        out.push({ kind: 'table', target: input.value, via: `steps[${s.id}].inputs.${name}` });
      }
    }
  }
  return dedupe(out, (r) => `${r.kind}:${r.table ?? ''}:${r.target}`);
}

/** Which table/field pairs the flow writes, from the field maps it carries. */
function writesOf(steps) {
  const out = [];
  for (const s of steps) {
    const table = s.inputs.table_name?.value ?? s.inputs.table?.value ?? null;
    const values = s.inputs.values?.value ?? null;
    if (!table || !values) continue;
    for (const pair of String(values).split('^')) {
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const field = pair.slice(0, at).trim();
      if (!/^[a-z][a-z0-9_.]*$/i.test(field)) continue;
      /* `values` is a field MAP: the input is not named for a credential even
       * when one of the fields it writes is, so each field is checked on its
       * own rather than inheriting the input's verdict. */
      const raw = pair.slice(at + 1);
      const secret = isSecretName(field);
      out.push({
        table,
        field,
        value: secret ? fingerprintSecret(raw) : raw,
        secret,
        via: `steps[${s.id}].inputs.values`,
      });
    }
  }
  return out;
}

const dedupe = (list, key) => {
  const seen = new Set();
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/* ------------------------------------------------------------------ *
 * §29 / §30 — the artifact hash
 * ------------------------------------------------------------------ */

/**
 * The canonical hash of a normalised flow.
 *
 * §30 lists what must be excluded — provider, model, timestamp, task id,
 * runtime execution ids — and this excludes more than that, because the
 * measurement above showed more that is non-semantic: every sys_id, the class
 * name, the snapshot's version and status.
 *
 * WHAT IT COVERS is the whole of the semantic content: the header fields, the
 * trigger, and every step in EXECUTION ORDER with its inputs' VALUES. Display
 * labels are excluded, so a relabelled reference hashes the same (§19), and a
 * different reference does not.
 *
 * THE TEST THAT MATTERS is not a unit test: a live flow and its published
 * snapshot are two different rows, written years apart, carrying different
 * identities throughout — and they hash identically. Anything this function let
 * through that it should not would show up there first.
 */
export function hashArtifact(normalized) {
  return crypto.createHash('sha256').update(canonicalString(normalized)).digest('hex');
}

/** The exact bytes the hash is taken over. Exported so a disagreement about a
 *  hash is inspectable rather than mysterious. */
export function canonicalString(n) {
  if (!n) return '';
  const lines = [];
  lines.push(`type=${n.artifact?.type ?? 'unknown'}`);
  for (const f of SEMANTIC_HEADER) lines.push(`header.${f}=${scalar(n.header?.[f])}`);

  if (n.trigger) {
    lines.push(`trigger.kind=${scalar(n.trigger.kind)}`);
    lines.push(`trigger.table=${scalar(n.trigger.table)}`);
    lines.push(`trigger.condition=${scalar(n.trigger.condition)}`);
    lines.push(`trigger.strategy=${scalar(n.trigger.strategy)}`);
    lines.push(`trigger.count=${n.trigger.count ?? 1}`);
  } else {
    lines.push('trigger=none');
  }

  /* Branch containers and calls, in execution order, for the same reason the
   * steps are — and because both were invisible to the hash until a review
   * found them. */
  for (const [i, b] of (n.branches ?? []).entries()) {
    lines.push(`branches[${i}].id=${scalar(b.id)}`);
    lines.push(`branches[${i}].definition=${scalar(b.definition)}`);
    lines.push(`branches[${i}].parent=${scalar(b.parent)}`);
  }
  for (const [i, c] of (n.calls ?? []).entries()) {
    lines.push(`calls[${i}].id=${scalar(c.id)}`);
    /* The TARGET, never its name. */
    lines.push(`calls[${i}].target=${scalar(c.target)}`);
    lines.push(`calls[${i}].wait=${c.wait ? '1' : '0'}`);
    lines.push(`calls[${i}].parent=${scalar(c.parent)}`);
    for (const [name, v] of Object.entries(c.inputs ?? {})) {
      lines.push(`calls[${i}].inputs.${name}=${scalar(v)}`);
    }
  }

  /* Execution order is semantic, so the steps are hashed in it. */
  for (const [i, s] of (n.steps ?? []).entries()) {
    lines.push(`steps[${i}].id=${scalar(s.id)}`);
    lines.push(`steps[${i}].type=${scalar(s.type)}`);
    lines.push(`steps[${i}].parent=${scalar(s.parent)}`);
    lines.push(`steps[${i}].readable=${s.readable ? '1' : '0'}`);
    for (const [name, input] of Object.entries(s.inputs ?? {})) {
      /* VALUE ONLY. The display label is what §19 says must not move a hash. */
      lines.push(`steps[${i}].inputs.${name}=${scalar(input.value)}`);
    }
  }
  return lines.join('\n');
}

/*
 * ABSENCE AND A VALUE ARE ENCODED STRUCTURALLY, NOT BY A MAGIC STRING.
 *
 * This used to emit a literal NUL for absence. It could not collide with a real
 * value, which was the point — and it also made this file read as BINARY to
 * grep, so every audit that searched the tree was silently skipping it. Found by
 * review, and the replacement is better than the original: a present value is
 * prefixed with a colon and an absent one emits nothing, so no value can
 * impersonate an absence and the canonical string stays readable.
 */
const scalar = (v) => (v === null || v === undefined ? '' : `:${v}`);

/* ------------------------------------------------------------------ *
 * §29 — a version identity, or an honest substitute
 * ------------------------------------------------------------------ */

/**
 * What to call this state.
 *
 * §29 says to capture a version identifier where one exists and to use a
 * deterministic hash where none does — and never to manufacture a number. A
 * snapshot carries a real `version`; a live flow does not, so it gets the first
 * twelve characters of its own content hash, which is a name derived from the
 * thing rather than assigned to it.
 */
export function versionIdOf(normalized, { version = null } = {}) {
  const real = normalizeScalar(version);
  if (real) return { id: real, derived: false, note: 'the version the platform recorded' };
  const hash = hashArtifact(normalized);
  return { id: hash.slice(0, 12), derived: true, note: 'derived from the artifact content; the platform records no version for this state' };
}

export const _internals = {
  SEMANTIC_HEADER, PROVENANCE_HEADER, normalizeStep, normalizeInput, writesOf, referencesOf,
  normalizeBranches, normalizeCalls, isSecretName, fingerprintSecret,
};
