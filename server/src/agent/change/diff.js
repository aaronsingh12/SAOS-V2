/**
 * PHASE 18 — THE DIFF. ARITHMETIC, NOT OPINION.
 *
 * §11 is the whole contract of this file: given the same two normalised states,
 * it produces the same changes, every time, with no model anywhere in the path.
 * Two values are equal or they are not, and nothing here is asked to judge.
 *
 * ═══ WHAT IS COMPARED, AND BY WHAT IDENTITY ═══
 *
 * A diff is only as good as its notion of "the same element". Three identities
 * are used and each was chosen from measurement rather than convenience:
 *
 *   a step      by `ui_id`, which survives a snapshot copy where the row's
 *               sys_id does not. Matching on sys_id would report every step of
 *               an unchanged flow as removed-and-added.
 *   an input    by name, within its step. Their serialisation order carries no
 *               meaning, so it is not compared (§7).
 *   a reference by identity — the sys_id — never the label beside it (§18).
 *
 * ═══ THE TWO WAYS A DIFF LIES ═══
 *
 * A FALSE POSITIVE says something changed that did not, and costs somebody an
 * afternoon proving a release is safe. Every one this build knows about comes
 * from comparing a field that describes the ROW rather than the artifact, and
 * `normalize.js` has already dropped those.
 *
 * A FALSE NEGATIVE says nothing changed when something did, and costs them the
 * release. §63.3 makes "a meaningful semantic change silently normalized away"
 * a blocker, so nothing here collapses, rounds or tidies: an element this file
 * cannot compare becomes an UNKNOWN change rather than an absent one.
 */
import { parseEncodedQuery } from '../test/trigger.js';
import { KINDS, ELEMENTS, CATEGORIES, STATUS } from './schemas.js';
import { _internals } from './normalize.js';

const { SEMANTIC_HEADER } = _internals;

/**
 * What a change to each header field actually is.
 *
 * Spelled out per field rather than defaulted, because they are genuinely
 * different things and lumping them together gets two of them wrong:
 *
 *   name         does not change what the flow DOES. It changes how everything
 *                that calls it by name finds it, which is a dependency change.
 *   description  presentation, and nothing else.
 *   active       decides whether the flow runs at all, so it is both a
 *                behaviour change and a trigger change.
 *   type         flow versus subflow is what kind of artifact this is, and
 *                whether anything can trigger it.
 */
const HEADER_CATEGORIES = Object.freeze({
  name: [CATEGORIES.STRUCTURAL, CATEGORIES.DEPENDENCY],
  description: [CATEGORIES.COSMETIC],
  active: [CATEGORIES.BEHAVIORAL, CATEGORIES.TRIGGER],
  type: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL],
});

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

/**
 * Compare two normalised flows.
 *
 * @param baseline  from `normalizeFlow`
 * @param current   from `normalizeFlow`
 *
 * Returns `{ changes, unchanged, complete, unreadable }`. `changes` is sorted
 * deterministically — by element, then path — so two runs produce byte-identical
 * output and a caller can diff the diffs.
 */
export function diffFlows(baseline, current) {
  const changes = [];
  const unreadable = [];

  if (!baseline || !current) {
    return {
      changes: [],
      unchanged: 0,
      complete: false,
      unreadable: [!baseline ? 'the baseline could not be read' : null, !current ? 'the current artifact could not be read' : null].filter(Boolean),
    };
  }

  /*
   * §40/§41 — a gap on either side means the comparison of THAT element is not
   * evidence. The gaps are carried through so the result can be labelled
   * PARTIAL and say which sections are missing, rather than presenting a
   * complete-looking diff over half an artifact.
   */
  for (const g of baseline.gaps ?? []) unreadable.push(`baseline: ${g}`);
  for (const g of current.gaps ?? []) unreadable.push(`current: ${g}`);
  const partial = unreadable.length > 0;

  let unchanged = 0;
  const count = () => { unchanged += 1; };

  diffHeader(baseline, current, changes, count, partial);
  diffTrigger(baseline.trigger, current.trigger, changes, count, partial);
  diffSteps(baseline.steps ?? [], current.steps ?? [], changes, count, partial);
  diffBranches(baseline.branches ?? [], current.branches ?? [], changes, count, partial);
  diffCalls(baseline.calls ?? [], current.calls ?? [], changes, count, partial);

  changes.sort(byElementThenPath);
  return { changes, unchanged, complete: !partial, unreadable };
}

/* ------------------------------------------------------------------ *
 * Header
 * ------------------------------------------------------------------ */

function diffHeader(baseline, current, changes, count, partial) {
  for (const field of SEMANTIC_HEADER) {
    const before = baseline.header?.[field] ?? null;
    const after = current.header?.[field] ?? null;
    if (same(before, after)) { count(); continue; }
    changes.push(change({
      kind: KINDS.CHANGED,
      path: `header.${field}`,
      element: ELEMENTS.HEADER,
      before, after,
      semantic_type: field === 'active' ? 'boolean' : 'string',
      categories: HEADER_CATEGORIES[field] ?? [CATEGORIES.STRUCTURAL],
      partial,
      evidence: [evidenceOf(baseline, `header.${field}`, before), evidenceOf(current, `header.${field}`, after)],
    }));
  }
}

/* ------------------------------------------------------------------ *
 * §14 / §15 — trigger and condition
 * ------------------------------------------------------------------ */

function diffTrigger(before, after, changes, count, partial) {
  if (!before && !after) return;
  if (!before || !after) {
    changes.push(change({
      kind: before ? KINDS.REMOVED : KINDS.ADDED,
      path: 'trigger',
      element: ELEMENTS.TRIGGER,
      before: before ? describeTrigger(before) : null,
      after: after ? describeTrigger(after) : null,
      semantic_type: 'trigger',
      categories: [CATEGORIES.TRIGGER, CATEGORIES.BEHAVIORAL, CATEGORIES.STRUCTURAL],
      partial,
    }));
    return;
  }

  for (const field of ['kind', 'table', 'strategy', 'count']) {
    const b = before[field] ?? null;
    const a = after[field] ?? null;
    if (same(b, a)) { count(); continue; }
    changes.push(change({
      kind: KINDS.CHANGED,
      path: `trigger.${field}`,
      element: ELEMENTS.TRIGGER,
      before: b, after: a,
      /* The table's label is shown beside the identity, never compared. */
      before_display: field === 'table' ? before.table_label : null,
      after_display: field === 'table' ? after.table_label : null,
      semantic_type: field === 'table' ? 'table' : 'string',
      categories: [CATEGORIES.TRIGGER, CATEGORIES.BEHAVIORAL,
        ...(field === 'table' ? [CATEGORIES.DEPENDENCY, CATEGORIES.DATA] : [])],
      partial,
    }));
  }

  diffCondition(before.condition, after.condition, changes, count, partial);
}

/**
 * §15 — the condition, term by term.
 *
 * A whole-string comparison would say "the condition changed" and leave a
 * person to spot the difference in two encoded queries. Parsing into terms says
 * which term, which is what a reader needs.
 *
 * THE PARSER IS REUSED, not rewritten. `agent/test/trigger.js` already reads an
 * encoded query for the fixture builder, and a second parser here would be a
 * second thing that can disagree with the platform.
 *
 * NO CLAIM OF LOGICAL EQUIVALENCE. §15 forbids it unless a deterministic
 * analyser establishes it, and there is none: two conditions that a human can
 * see are equivalent are reported as different if their terms differ. A
 * reordering of terms IS reported, as MOVED rather than CHANGED, because
 * nothing here has established that ServiceNow evaluates them order-independently.
 */
function diffCondition(before, after, changes, count, partial) {
  if (same(before, after)) { count(); return; }

  if (!before || !after) {
    changes.push(change({
      kind: before ? KINDS.REMOVED : KINDS.ADDED,
      path: 'trigger.condition',
      element: ELEMENTS.CONDITION,
      before, after,
      semantic_type: 'condition',
      categories: [CATEGORIES.TRIGGER, CATEGORIES.BEHAVIORAL],
      partial,
    }));
    return;
  }

  const b = termsOf(before);
  const a = termsOf(after);
  const bKeys = new Set(b.map(termKey));
  const aKeys = new Set(a.map(termKey));

  for (const t of a) {
    if (!bKeys.has(termKey(t))) {
      changes.push(change({
        kind: KINDS.ADDED,
        path: `trigger.condition[${t.field}]`,
        element: ELEMENTS.CONDITION,
        before: null, after: t.raw,
        semantic_type: 'condition_term',
        categories: [CATEGORIES.TRIGGER, CATEGORIES.BEHAVIORAL],
        partial,
      }));
    }
  }
  for (const t of b) {
    if (!aKeys.has(termKey(t))) {
      changes.push(change({
        kind: KINDS.REMOVED,
        path: `trigger.condition[${t.field}]`,
        element: ELEMENTS.CONDITION,
        before: t.raw, after: null,
        semantic_type: 'condition_term',
        categories: [CATEGORIES.TRIGGER, CATEGORIES.BEHAVIORAL],
        partial,
      }));
    }
  }

  /*
   * The terms are the same and the string is not: the order changed, or a part
   * of the query this build cannot parse did. Either way something differs, and
   * §63.3 forbids letting it disappear because the parser found nothing to say.
   */
  if (bKeys.size === aKeys.size && [...bKeys].every((k) => aKeys.has(k))) {
    changes.push(change({
      kind: KINDS.MOVED,
      path: 'trigger.condition',
      element: ELEMENTS.CONDITION,
      before, after,
      semantic_type: 'condition',
      categories: [CATEGORIES.TRIGGER, CATEGORIES.STRUCTURAL],
      /* UNKNOWN, and deliberately: the same terms in a different order MAY be
       * equivalent, and nothing here has established that they are. */
      status: STATUS.UNKNOWN,
      note: 'The condition contains the same terms in a different order, or in a form this build could not '
        + 'fully parse. Whether that changes behaviour is not established.',
      partial,
    }));
  }
}

const termsOf = (query) => parseEncodedQuery(query).terms;
const termKey = (t) => `${t.field}|${t.op}|${t.value ?? ''}`;

const describeTrigger = (t) => [t.kind, t.table, t.condition].filter(Boolean).join(' / ');

/* ------------------------------------------------------------------ *
 * §16 / §17 — steps
 * ------------------------------------------------------------------ */

function diffSteps(before, after, changes, count, partial) {
  const bById = new Map(before.map((s) => [s.id, s]));
  const aById = new Map(after.map((s) => [s.id, s]));
  const bOrder = new Map(before.map((s, i) => [s.id, i]));
  const aOrder = new Map(after.map((s, i) => [s.id, i]));
  /* Positions counted over the steps that exist in BOTH states, so an insertion
   * or a removal elsewhere does not shift everything after it. */
  const common = new Set(before.map((s) => s.id).filter((id) => aById.has(id)));
  const bCommon = new Map(before.filter((s) => common.has(s.id)).map((s, i) => [s.id, i]));
  const aCommon = new Map(after.filter((s) => common.has(s.id)).map((s, i) => [s.id, i]));

  for (const s of after) {
    if (bById.has(s.id)) continue;
    changes.push(change({
      kind: KINDS.ADDED,
      path: `steps[${s.id}]`,
      element: ELEMENTS.ACTION,
      before: null, after: s.type,
      semantic_type: 'action',
      categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL, CATEGORIES.DEPENDENCY],
      detail: { order: s.order, parent: s.parent, inputs: Object.keys(s.inputs) },
      partial,
    }));
  }
  for (const s of before) {
    if (aById.has(s.id)) continue;
    changes.push(change({
      kind: KINDS.REMOVED,
      path: `steps[${s.id}]`,
      element: ELEMENTS.ACTION,
      before: s.type, after: null,
      semantic_type: 'action',
      categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL],
      detail: { order: s.order, parent: s.parent },
      partial,
    }));
  }

  for (const s of after) {
    const b = bById.get(s.id);
    if (!b) continue;

    if (!same(b.type, s.type)) {
      changes.push(change({
        kind: KINDS.CHANGED,
        path: `steps[${s.id}].type`,
        element: ELEMENTS.ACTION,
        before: b.type, after: s.type,
        semantic_type: 'action',
        categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL, CATEGORIES.DEPENDENCY],
        partial,
      }));
    } else { count(); }

    if (!same(b.parent, s.parent)) {
      changes.push(change({
        kind: KINDS.MOVED,
        path: `steps[${s.id}].parent`,
        element: ELEMENTS.BRANCH,
        before: b.parent, after: s.parent,
        semantic_type: 'branch',
        categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL],
        note: 'The step moved into or out of a container, so the conditions under which it runs changed.',
        partial,
      }));
    }

    /*
     * §16 — a reorder is reported only when this step's position changed
     * RELATIVE TO THE OTHER STEPS THAT STILL EXIST.
     *
     * TWO WAYS TO GET THIS WRONG, and this had the second.
     *
     * Comparing `order` numbers reports a renumbering: 1,2,3 becoming 10,20,30
     * is the same sequence and no move at all.
     *
     * Comparing ARRAY INDICES, which is what this did, is worse. Inserting one
     * step at the front shifts every later index by one, so a single addition
     * came back as an addition PLUS a move of every step after it. Found by
     * review. On a twenty-step flow that is nineteen false positives from one
     * real edit, and §63.2 is about exactly that.
     *
     * So position is counted over the steps present in BOTH states: a step that
     * did not move relative to its surviving neighbours has not moved.
     */
    if (bCommon.get(s.id) !== aCommon.get(s.id) && s.identity === 'ui_id') {
      changes.push(change({
        kind: KINDS.MOVED,
        path: `steps[${s.id}].position`,
        element: ELEMENTS.ACTION,
        before: bOrder.get(s.id), after: aOrder.get(s.id),
        semantic_type: 'position',
        categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL],
        note: 'Execution order changed, so what this step sees when it runs may have changed.',
        partial,
      }));
    }

    diffInputs(b, s, changes, count, partial);
  }
}

/**
 * §17/§18/§19 — one step's inputs.
 *
 * The display rule is enforced here and nowhere else, so there is one place to
 * read it: a change to `display` with an unchanged `value` is NOT a change. It
 * is recorded on the result as a relabelling so a reader is not baffled by a
 * different name in the UI, and it never becomes a diff entry.
 */
function diffInputs(before, after, changes, count, partial) {
  const names = new Set([...Object.keys(before.inputs ?? {}), ...Object.keys(after.inputs ?? {})]);

  for (const name of [...names].sort()) {
    const b = before.inputs?.[name] ?? null;
    const a = after.inputs?.[name] ?? null;
    const path = `steps[${after.id}].inputs.${name}`;
    const isReference = Boolean(a?.reference || b?.reference);
    const element = isReference ? ELEMENTS.REFERENCE : ELEMENTS.INPUT;

    if (!b && a) {
      changes.push(change({
        kind: KINDS.ADDED, path, element,
        before: null, after: a.value, after_display: a.display,
        semantic_type: isReference ? 'reference' : (a.type ?? 'value'),
        categories: categoriesForInput(name, a, isReference, true),
        partial,
      }));
      continue;
    }
    if (b && !a) {
      changes.push(change({
        kind: KINDS.REMOVED, path, element,
        before: b.value, after: null, before_display: b.display,
        semantic_type: isReference ? 'reference' : (b.type ?? 'value'),
        categories: categoriesForInput(name, b, isReference, true),
        partial,
      }));
      continue;
    }

    if (same(b.value, a.value)) {
      count();
      /* §19 — identity unchanged. A different label is not a semantic change,
       * and is carried as a note rather than as a diff entry. */
      if (!same(b.display, a.display)) {
        changes.push(change({
          kind: KINDS.UNCHANGED, path, element,
          before: b.value, after: a.value,
          before_display: b.display, after_display: a.display,
          semantic_type: isReference ? 'reference' : (a.type ?? 'value'),
          categories: [CATEGORIES.COSMETIC],
          display_only: true,
          note: 'The label changed and the identity did not, so nothing about what this flow does changed.',
          partial,
        }));
      }
      continue;
    }

    changes.push(change({
      kind: KINDS.CHANGED, path, element,
      before: b.value, after: a.value,
      before_display: b.display, after_display: a.display,
      semantic_type: isReference ? 'reference' : (a.type ?? b.type ?? 'value'),
      categories: categoriesForInput(name, a, isReference, false),
      partial,
    }));
  }
}

/**
 * Which categories an input change carries.
 *
 * Every one is read off the normalised shape — the input's declared reference
 * table, its name, whether it is a data pill — and not from what the value
 * looks like.
 */
function categoriesForInput(name, input, isReference, structural) {
  const out = [CATEGORIES.BEHAVIORAL];
  if (structural) out.push(CATEGORIES.STRUCTURAL);
  if (isReference) out.push(CATEGORIES.DEPENDENCY, CATEGORIES.DATA);
  /* `values` is the field map an Update/Create Record writes, and `table_name`
   * is which table it writes to. Both are what the flow does to DATA. */
  if (name === 'values' || name === 'table_name' || name === 'table' || name === 'record') out.push(CATEGORIES.DATA);
  /* The platform's own names for who a step acts as. A change here changes
   * authority, which §24 ranks above everything else. */
  if (/^(run_as|impersonat|roles?|acl)/i.test(name)) out.push(CATEGORIES.SECURITY);
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ *
 * Branch containers and subflow calls
 * ------------------------------------------------------------------ */

/**
 * The IF / ELSE / FOR EACH containers.
 *
 * Matched on `ui_id`, for the reason the steps are. What is compared is the
 * container's DEFINITION — the identity naming which kind it is — its nesting,
 * and its position among the containers that survive in both states.
 *
 * Its CONDITION is not compared, and `normalizeBranches` has already said so as
 * a gap. That is why every change here arrives with `partial` true and a status
 * of UNKNOWN: this build can see that a branch changed and cannot see whether
 * the test inside it did, and those are different claims.
 */
function diffBranches(before, after, changes, count, partial) {
  const bById = new Map(before.map((b) => [b.id, b]));
  const aById = new Map(after.map((b) => [b.id, b]));
  const common = new Set(before.map((b) => b.id).filter((id) => aById.has(id)));
  const bPos = new Map(before.filter((b) => common.has(b.id)).map((b, i) => [b.id, i]));
  const aPos = new Map(after.filter((b) => common.has(b.id)).map((b, i) => [b.id, i]));

  for (const b of after) {
    if (bById.has(b.id)) continue;
    changes.push(change({
      kind: KINDS.ADDED, path: `branches[${b.id}]`, element: ELEMENTS.BRANCH,
      before: null, after: b.definition_label ?? b.definition,
      semantic_type: 'branch',
      categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL],
      detail: { order: b.order, parent: b.parent }, partial,
    }));
  }
  for (const b of before) {
    if (aById.has(b.id)) continue;
    changes.push(change({
      kind: KINDS.REMOVED, path: `branches[${b.id}]`, element: ELEMENTS.BRANCH,
      before: b.definition_label ?? b.definition, after: null,
      semantic_type: 'branch',
      categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL],
      detail: { order: b.order, parent: b.parent }, partial,
    }));
  }
  for (const b of after) {
    const was = bById.get(b.id);
    if (!was) continue;

    if (!same(was.definition, b.definition)) {
      changes.push(change({
        kind: KINDS.CHANGED, path: `branches[${b.id}].definition`, element: ELEMENTS.BRANCH,
        before: was.definition, after: b.definition,
        before_display: was.definition_label, after_display: b.definition_label,
        semantic_type: 'branch', categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL], partial,
      }));
    } else { count(); }

    if (!same(was.parent, b.parent)) {
      changes.push(change({
        kind: KINDS.MOVED, path: `branches[${b.id}].parent`, element: ELEMENTS.BRANCH,
        before: was.parent, after: b.parent,
        semantic_type: 'branch', categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL],
        note: 'The container moved inside another container, so what governs it changed.', partial,
      }));
    }
    if (bPos.get(b.id) !== aPos.get(b.id) && b.identity === 'ui_id') {
      changes.push(change({
        kind: KINDS.MOVED, path: `branches[${b.id}].position`, element: ELEMENTS.BRANCH,
        before: bPos.get(b.id), after: aPos.get(b.id),
        semantic_type: 'position', categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL], partial,
      }));
    }
  }
}

/**
 * The calls this flow makes to other flows.
 *
 * A repointed call is a DEPENDENCY change and a behaviour change at once: the
 * flow now runs different logic, and now needs a different artifact to exist.
 * Compared by target IDENTITY and never by the subflow's name — §18 applies to
 * a subflow reference exactly as it applies to a user reference, and a renamed
 * subflow is §19's case rather than a change.
 */
function diffCalls(before, after, changes, count, partial) {
  const bById = new Map(before.map((c) => [c.id, c]));
  const aById = new Map(after.map((c) => [c.id, c]));

  for (const c of after) {
    if (bById.has(c.id)) continue;
    changes.push(change({
      kind: KINDS.ADDED, path: `calls[${c.id}]`, element: ELEMENTS.REFERENCE,
      before: null, after: c.target, after_display: c.target_name,
      semantic_type: 'subflow',
      categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL, CATEGORIES.DEPENDENCY], partial,
    }));
  }
  for (const c of before) {
    if (aById.has(c.id)) continue;
    changes.push(change({
      kind: KINDS.REMOVED, path: `calls[${c.id}]`, element: ELEMENTS.REFERENCE,
      before: c.target, after: null, before_display: c.target_name,
      semantic_type: 'subflow',
      categories: [CATEGORIES.STRUCTURAL, CATEGORIES.BEHAVIORAL, CATEGORIES.DEPENDENCY], partial,
    }));
  }
  for (const c of after) {
    const was = bById.get(c.id);
    if (!was) continue;

    if (!same(was.target, c.target)) {
      changes.push(change({
        kind: KINDS.CHANGED, path: `calls[${c.id}].target`, element: ELEMENTS.REFERENCE,
        before: was.target, after: c.target,
        before_display: was.target_name, after_display: c.target_name,
        semantic_type: 'subflow',
        categories: [CATEGORIES.BEHAVIORAL, CATEGORIES.DEPENDENCY], partial,
      }));
    } else if (!same(was.target_name, c.target_name)) {
      /* §19 again: the subflow was renamed and this call still points at it. */
      changes.push(change({
        kind: KINDS.UNCHANGED, path: `calls[${c.id}].target`, element: ELEMENTS.REFERENCE,
        before: was.target, after: c.target,
        before_display: was.target_name, after_display: c.target_name,
        semantic_type: 'subflow', categories: [CATEGORIES.COSMETIC], display_only: true,
        note: 'The subflow this call points at was renamed. The call still points at the same flow.',
        partial,
      }));
      count();
    } else { count(); }

    if (was.wait !== c.wait) {
      changes.push(change({
        kind: KINDS.CHANGED, path: `calls[${c.id}].wait`, element: ELEMENTS.REFERENCE,
        before: String(was.wait), after: String(c.wait),
        semantic_type: 'boolean', categories: [CATEGORIES.BEHAVIORAL], partial,
        note: c.wait
          ? 'The flow now waits for this subflow to finish before continuing.'
          : 'The flow no longer waits for this subflow to finish, so what follows it may run before it does.',
      }));
    }

    const names = new Set([...Object.keys(was.inputs ?? {}), ...Object.keys(c.inputs ?? {})]);
    for (const name of [...names].sort()) {
      const b = was.inputs?.[name] ?? null;
      const a = c.inputs?.[name] ?? null;
      if (same(b, a)) { count(); continue; }
      changes.push(change({
        kind: b === null ? KINDS.ADDED : (a === null ? KINDS.REMOVED : KINDS.CHANGED),
        path: `calls[${c.id}].inputs.${name}`, element: ELEMENTS.INPUT,
        before: b, after: a, semantic_type: 'value',
        categories: [CATEGORIES.BEHAVIORAL, CATEGORIES.DATA], partial,
      }));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

/** Null, undefined and the empty string are one absence. Everything else is
 *  compared as the string the platform stored. */
function same(a, b) {
  const x = a === null || a === undefined || a === '' ? null : String(a);
  const y = b === null || b === undefined || b === '' ? null : String(b);
  return x === y;
}

function change(spec) {
  return {
    kind: spec.kind,
    path: spec.path,
    element: spec.element,
    before: spec.before ?? null,
    after: spec.after ?? null,
    before_display: spec.before_display ?? null,
    after_display: spec.after_display ?? null,
    semantic_type: spec.semantic_type ?? 'value',
    categories: spec.categories,
    /*
     * §25 — certainty. A comparison of two states this build READ is CONFIRMED:
     * the values came off the instance and nothing was inferred. It drops to
     * UNKNOWN when the caller says so (an order change whose effect is not
     * established) or when either artifact had a gap, because a diff over a
     * section that could not be read is not evidence about that section.
     */
    status: spec.status ?? (spec.partial ? STATUS.UNKNOWN : STATUS.CONFIRMED),
    display_only: Boolean(spec.display_only),
    note: spec.note ?? null,
    detail: spec.detail ?? null,
    evidence: spec.evidence ?? [],
  };
}

const evidenceOf = (state, path, value) => ({
  source: state?.provenance?.source ?? null,
  artifact_sys_id: state?.artifact?.sys_id ?? null,
  path,
  value: value === null || value === undefined ? null : String(value),
});

const ELEMENT_ORDER = [
  ELEMENTS.TRIGGER, ELEMENTS.CONDITION, ELEMENTS.ACTION, ELEMENTS.BRANCH,
  ELEMENTS.REFERENCE, ELEMENTS.INPUT, ELEMENTS.OUTPUT, ELEMENTS.DEPENDENCY, ELEMENTS.HEADER,
];

function byElementThenPath(a, b) {
  const ea = ELEMENT_ORDER.indexOf(a.element);
  const eb = ELEMENT_ORDER.indexOf(b.element);
  if (ea !== eb) return ea - eb;
  return a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind);
}

/* ------------------------------------------------------------------ *
 * §20 — dependency movement
 * ------------------------------------------------------------------ */

/**
 * Which dependencies the change introduces and which it drops.
 *
 * Computed from the normalised `references`, each of which the artifact itself
 * establishes — a declared reference field, a trigger's table, an action type.
 * Nothing is inferred from a value that merely looks like an identity.
 */
export function dependencyDelta(baseline, current) {
  const key = (r) => `${r.kind}:${r.table ?? ''}:${r.target}`;
  const before = new Map((baseline?.references ?? []).map((r) => [key(r), r]));
  const after = new Map((current?.references ?? []).map((r) => [key(r), r]));
  return {
    added: [...after.values()].filter((r) => !before.has(key(r))),
    removed: [...before.values()].filter((r) => !after.has(key(r))),
  };
}

/* ------------------------------------------------------------------ *
 * §26 — the counts, before any prose
 * ------------------------------------------------------------------ */

/**
 * The deterministic summary.
 *
 * §26 says the model may turn this into English and may not alter it. These are
 * the numbers it will be given, computed once, so a sentence that disagrees
 * with them can be caught by comparing the two.
 *
 * A display-only entry is counted separately and is NOT a change: it is carried
 * with `kind: UNCHANGED` precisely so that a reader who wants to know why a
 * name looks different can see it without it inflating a total.
 */
export function summarise({ changes = [], unchanged = 0, dependencies = { added: [], removed: [] } } = {}) {
  const real = changes.filter((c) => !c.display_only && c.kind !== KINDS.UNCHANGED);
  const by = (k) => real.filter((c) => c.kind === k).length;
  const withCategory = (cat) => real.filter((c) => c.categories.includes(cat)).length;

  return {
    total: real.length,
    added: by(KINDS.ADDED),
    removed: by(KINDS.REMOVED),
    changed: by(KINDS.CHANGED),
    moved: by(KINDS.MOVED),
    unchanged,
    display_only: changes.filter((c) => c.display_only).length,
    trigger_changes: withCategory(CATEGORIES.TRIGGER),
    behavioral_changes: withCategory(CATEGORIES.BEHAVIORAL),
    dependency_changes: withCategory(CATEGORIES.DEPENDENCY),
    security_changes: withCategory(CATEGORIES.SECURITY),
    data_changes: withCategory(CATEGORIES.DATA),
    cosmetic_changes: withCategory(CATEGORIES.COSMETIC),
    dependencies_added: dependencies.added.length,
    dependencies_removed: dependencies.removed.length,
    unknown: real.filter((c) => c.status === STATUS.UNKNOWN).length,
  };
}
