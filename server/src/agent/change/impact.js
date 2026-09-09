/**
 * PHASE 18 — WHAT THE CHANGE MEANS FOR THE INSTANCE IT LANDS ON.
 *
 * A diff says what is different. Impact says what is different ABOUT THIS
 * INSTANCE — and that difference is the whole reason this file exists rather
 * than being folded into `diff.js`. "assignment_group changed" is a fact about
 * two artifacts. "the field it now writes is computed by the platform and the
 * write will be discarded" is a fact about dev424910, and it needs the
 * dictionary and the semantic ledger to establish.
 *
 * ═══ NOTHING HERE RE-DERIVES WHAT NOWLINT ALREADY KNOWS (§21) ═══
 *
 * §21 is explicit: do not duplicate NowLint logic, reuse it. So schema impact
 * asks the SAME injected authorities NowLint's context asks — the live
 * dictionary and `derivationOf` — and where a question is a lint rule's
 * question, this file does not answer it at all. It says which rules the change
 * makes relevant and hands them the artifact.
 *
 * ═══ AND NOTHING HERE RUNS A TEST (§23) ═══
 *
 * `testRecommendation` decides whether a change is TESTABLE and says so. It
 * does not create a fixture, does not build a plan and does not call NowTest —
 * §23 says a test is an explicit continuation, and §63.8 makes a fabricated
 * test result a release blocker. The strongest way to satisfy the second is for
 * this module to have no way to produce one.
 */
import { KINDS, ELEMENTS, CATEGORIES, STATUS } from './schemas.js';

/* ------------------------------------------------------------------ *
 * §21 — schema impact
 * ------------------------------------------------------------------ */

/**
 * What the live instance says about the fields this change now touches.
 *
 * @param changes   assessed changes
 * @param current   the normalised current state
 * @param ctx       { fieldsOf(table), derivationOf(table, field) } — the same
 *                  authorities NowLint's context wraps, injected the same way
 *
 * Every finding cites the authority that produced it, and a question that could
 * not be answered becomes an UNKNOWN rather than a silence: a dictionary that
 * could not be read is not evidence that a field is fine.
 */
export async function schemaImpact({ changes, current, ctx }) {
  const findings = [];
  const seen = new Set();

  /*
   * The writes the CURRENT artifact performs, restricted to the ones a change
   * actually touched. Assessing every write on every run would report the same
   * pre-existing facts as though the change had introduced them.
   *
   * "TOUCHED" INCLUDES A WHOLE STEP THAT WAS ADDED, and it did not. FOUND BY
   * REVIEW: the match was `path.startsWith(via minus '.values')`, so an edited
   * input matched — `steps[x].inputs.values` against `steps[x].inputs` — and a
   * newly added step did not, because its change path is `steps[x]` and nothing
   * starts with a longer string. A step added to write `priority` therefore got
   * no derived-field warning at all, which is the one case where the warning
   * matters most.
   *
   * Matching on the STEP is both simpler and right: a write belongs to a step,
   * and a change to that step — added, retyped, or an input edited — makes its
   * writes worth assessing.
   */
  const stepOf = (p) => /^steps\[([^\]]+)\]/.exec(String(p))?.[1] ?? null;
  const touchedSteps = new Set(
    changes
      .filter((c) => !c.display_only && c.kind !== KINDS.UNCHANGED)
      .map((c) => stepOf(c.path))
      .filter(Boolean),
  );

  for (const w of current?.writes ?? []) {
    const owner = stepOf(w.via);
    if (!owner || !touchedSteps.has(owner)) continue;
    const key = `${w.table}.${w.field}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const derived = safe(() => ctx.derivationOf?.(w.table, w.field, { hierarchy: [w.table] }));
    if (derived) {
      findings.push({
        kind: 'derived_field',
        status: STATUS.LIKELY,
        path: w.via,
        statement: `${key} is computed by the platform from ${derived.value.from.join(' + ')}.`,
        why_it_matters: 'A direct write to it is accepted and then overwritten, so a change that targets it '
          + 'will report success and do nothing.',
        evidence: [{ source: 'semantic_fact', detail: derived.note ?? null }],
      });
      continue;
    }

    const fields = await safeAsync(() => ctx.fieldsOf?.(w.table));
    if (!fields) {
      findings.push({
        kind: 'schema_unknown',
        status: STATUS.UNKNOWN,
        path: w.via,
        statement: `The dictionary for ${w.table} could not be read, so nothing is established about ${key}.`,
        why_it_matters: 'A field that could not be checked is not a field that was found to be fine.',
        evidence: [],
      });
      continue;
    }
    const field = fields.get(w.field);
    if (!field) {
      findings.push({
        kind: 'field_absent',
        status: STATUS.CONFIRMED,
        path: w.via,
        statement: `${key} is not a field on ${w.table} according to the live dictionary.`,
        why_it_matters: 'A write to a field the table does not have is accepted by the API and silently dropped.',
        evidence: [{ source: 'live_schema', detail: `${fields.size} field(s) read` }],
      });
    } else if (field.readOnly === true) {
      findings.push({
        kind: 'field_read_only',
        status: STATUS.CONFIRMED,
        path: w.via,
        statement: `${key} is marked read-only in the live dictionary.`,
        why_it_matters: 'The platform will not accept the write this change now makes.',
        evidence: [{ source: 'live_schema', detail: 'dictionary read_only = true' }],
      });
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * §20 — what the flow now depends on
 * ------------------------------------------------------------------ */

/**
 * Turn a dependency delta into statements a reader can act on.
 *
 * §20 permits declaring a dependency only where artifact or schema evidence
 * establishes it, and `normalize.js` has already applied that filter — every
 * reference here came from a field the platform declared for the purpose. What
 * this adds is the SENTENCE, plus one check the artifact alone cannot make:
 * whether a newly-referenced record is named by identity or by label.
 */
export function dependencyImpact(delta) {
  const out = [];
  for (const r of delta.added ?? []) {
    if (r.kind === 'record' && !r.is_identity) {
      out.push({
        kind: 'new_dependency_by_label',
        status: STATUS.CONFIRMED,
        path: r.via,
        statement: `The flow now depends on a ${r.table} record named as "${r.target}" rather than by sys_id.`,
        why_it_matters: 'A reference supplied as a label resolves by name, so it points at a different record '
          + 'on an instance where that name is taken by something else — or at nothing.',
        evidence: [{ source: 'live_flow', detail: r.via }],
      });
      continue;
    }
    out.push({
      kind: 'new_dependency',
      status: STATUS.CONFIRMED,
      path: r.via,
      statement: r.kind === 'record'
        ? `The flow now depends on a ${r.table} record${r.display ? ` (${r.display})` : ''}.`
        : `The flow now depends on the ${r.kind} "${r.target}".`,
      why_it_matters: 'A dependency it did not have before is a new way for it to fail.',
      evidence: [{ source: 'live_flow', detail: r.via }],
    });
  }
  for (const r of delta.removed ?? []) {
    out.push({
      kind: 'dropped_dependency',
      status: STATUS.CONFIRMED,
      path: r.via,
      statement: r.kind === 'record'
        ? `The flow no longer depends on a ${r.table} record${r.display ? ` (${r.display})` : ''}.`
        : `The flow no longer depends on the ${r.kind} "${r.target}".`,
      why_it_matters: 'Whatever that dependency was doing is no longer being done.',
      evidence: [{ source: 'live_flow', detail: r.via }],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * §22 — which lint rules this change makes relevant
 * ------------------------------------------------------------------ */

/**
 * Which of NowLint's rules bear on the elements that changed.
 *
 * Read off the rule descriptions rather than guessed: each entry names what its
 * rule actually inspects, and the mapping is from the ELEMENT a change sits on
 * to the rules that read that element.
 */
const RULES_BY_ELEMENT = Object.freeze({
  [ELEMENTS.TRIGGER]: ['FLOW006', 'FLOW007', 'FLOW012'],
  [ELEMENTS.CONDITION]: ['FLOW006', 'FLOW007'],
  [ELEMENTS.ACTION]: ['FLOW004', 'FLOW005', 'FLOW009', 'FLOW012', 'FLOW008'],
  [ELEMENTS.BRANCH]: ['FLOW012'],
  [ELEMENTS.INPUT]: ['FLOW001', 'FLOW002', 'FLOW004', 'FLOW005'],
  [ELEMENTS.REFERENCE]: ['FLOW003', 'FLOW011', 'FLOW001'],
  [ELEMENTS.HEADER]: ['FLOW012'],
});

/**
 * The rules a change makes relevant, and the honest caveat that goes with it.
 *
 * §22 permits scoping the lint to what changed AND forbids claiming "lint
 * clean" when a rule was not evaluated. Both are satisfied by returning the
 * scope AND what it excludes, so the caller physically has the list of what it
 * must not claim about.
 *
 * `FLOW010` is always relevant: whether this build can act on the artifact at
 * all is a property of the instance, not of the change.
 */
export function lintScope(changes) {
  const relevant = new Set(['FLOW010']);
  for (const c of changes) {
    if (c.display_only || c.kind === KINDS.UNCHANGED) continue;
    for (const id of RULES_BY_ELEMENT[c.element] ?? []) relevant.add(id);
  }
  return {
    relevant: [...relevant].sort(),
    /* Filled in by the caller once it knows the full rule list, so this module
     * does not have to import the rules to say what it left out. */
    scoped: relevant.size > 0,
    caveat: 'Rules outside this list were not evaluated against the change, so nothing here says they pass.',
  };
}

/* ------------------------------------------------------------------ *
 * §23 — is this testable
 * ------------------------------------------------------------------ */

/**
 * Whether the changed artifact can be verified at runtime, and how.
 *
 * Returns a RECOMMENDATION. It never runs anything, and it cannot: the module
 * imports nothing that could.
 *
 * The three answers §23 asks for, each keyed on what actually changed:
 *
 *   the trigger changed        the test scenario has to be rebuilt, because the
 *                              fixture that fired the old flow may not fire this one
 *   only downstream changed    a targeted test is possible against the same fixture
 *   the fixture cannot fire it INCONCLUSIVE, and NowTest will say so itself
 *
 * @param testability injected from Phase 17: { triggerOf, isDisposable } — the
 *        SAME functions NowTest uses to decide, so a recommendation here and a
 *        refusal there cannot disagree.
 */
export function testRecommendation({ changes, current, testability }) {
  const real = changes.filter((c) => !c.display_only && c.kind !== KINDS.UNCHANGED);
  if (!real.length) {
    return {
      recommended: false,
      reason: 'Nothing changed, so there is nothing a run would establish that the comparison has not.',
      scenario: null,
    };
  }

  const trigger = safe(() => testability?.triggerOf?.({ triggers: rawTriggerOf(current) }));
  if (!trigger?.ok) {
    return {
      recommended: false,
      reason: trigger?.note ?? 'This build cannot work out what would make this flow run, so it cannot propose a test.',
      scenario: null,
      blocked: true,
    };
  }
  if (!safe(() => testability?.isDisposable?.(trigger.table))) {
    return {
      recommended: false,
      reason: `A test would have to create a record on ${trigger.table}, which is not a table this build `
        + 'creates disposable records on. NowTest would refuse, so it is not offered.',
      scenario: null,
      blocked: true,
    };
  }

  const triggerChanged = real.some((c) => c.categories.includes(CATEGORIES.TRIGGER));
  return {
    recommended: true,
    reason: triggerChanged
      ? 'The trigger changed, so the scenario has to be rebuilt from the CURRENT artifact — a fixture that '
        + 'fired the previous version may not fire this one.'
      : 'The trigger is unchanged and the change is downstream of it, so the same kind of fixture that fired '
        + 'the previous version will fire this one.',
    scenario: triggerChanged ? 'regenerate' : 'targeted',
    table: trigger.table,
    /* The request a caller would hand to NowTest, phrased the way NowTest reads
     * requests. It is a string, not a call. */
    request: `Test the ${current?.artifact?.name ?? 'flow'} flow.`,
  };
}

/** The trigger, back in the shape Phase 17's `triggerOf` reads. */
const rawTriggerOf = (current) => (current?.trigger
  ? [{
    type: current.trigger.kind,
    table: current.trigger.table,
    table_label: current.trigger.table_label,
    condition_query: current.trigger.condition,
    condition: current.trigger.condition,
    strategy: current.trigger.strategy,
    sys_id: null,
  }]
  : []);

/* ------------------------------------------------------------------ *
 * §28 — what the old version actually did
 * ------------------------------------------------------------------ */

/**
 * Execution history, attached ONLY when provenance permits it.
 *
 * §28 is unusually careful and it is right to be: execution records say what
 * some version of the flow did, and nothing in them says WHICH. A snapshot
 * published in 2025 and executions from last week may or may not belong to each
 * other, and the artifact cannot tell you.
 *
 * So this attaches history as an OBSERVATION about the flow, timestamped, and
 * refuses to attribute it to the baseline unless every execution predates the
 * moment the current state diverged — which, without a real "changed at", it
 * cannot. The honest result is almost always "these executions belong to some
 * version of this flow", and saying that is the point.
 */
export function executionContext({ executions = [], baselineCapturedAt = null }) {
  if (!executions.length) {
    return { available: false, note: 'No execution history was read for this flow.' };
  }
  /*
   * TWO TIMESTAMP FORMATS, COMPARED AS STRINGS, IS NOT A COMPARISON.
   *
   * FOUND BY REVIEW. ServiceNow writes `2026-09-07 10:00:00` and this build's
   * own capture time is an ISO `2026-09-07T00:00:00Z`. Comparing them as
   * strings puts the space (0x20) before the T (0x54), so EVERY execution on
   * the same day sorted before the capture and was declared to predate it —
   * attributing recent runs to the baseline, which is the precise thing §28
   * warns against.
   *
   * Both are parsed to milliseconds instead, and an unparseable one makes the
   * whole set unattributable rather than silently comparing as text.
   */
  const attributable = Boolean(baselineCapturedAt)
    && Number.isFinite(millis(baselineCapturedAt))
    && executions.every((e) => {
      const at = millis(e.started_at);
      return Number.isFinite(at) && at < millis(baselineCapturedAt);
    });
  return {
    available: true,
    count: executions.length,
    states: executions.reduce((acc, e) => {
      acc[e.state] = (acc[e.state] ?? 0) + 1;
      return acc;
    }, {}),
    attributable_to_baseline: attributable,
    note: attributable
      ? 'Every execution read predates the baseline, so it describes the version being compared against.'
      : 'These executions belong to some version of this flow. Nothing establishes which, so they are not '
        + 'attributed to either state being compared.',
  };
}

/** ServiceNow's `YYYY-MM-DD HH:MM:SS` (UTC) and an ISO string, in one unit. */
function millis(stamp) {
  const s = String(stamp ?? '').trim();
  if (!s) return NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  return Date.parse(iso);
}

const safe = (fn) => { try { return fn(); } catch { return null; } };
const safeAsync = async (fn) => { try { return await fn(); } catch { return null; } };

export const _internals = { RULES_BY_ELEMENT };
