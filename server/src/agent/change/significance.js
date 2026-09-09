/**
 * PHASE 18 — HOW MUCH A CHANGE COULD COST, DECIDED BY TABLE.
 *
 * §63.6 makes "risk based only on model opinion" a release blocker, and the way
 * to make that impossible is not to be careful — it is to have no model in the
 * path at all. Everything below is a lookup keyed on facts the diff already
 * established: which element changed, in what way, and what the artifact says
 * about it.
 *
 * ═══ WHY A CATEGORY TABLE ALONE IS NOT ENOUGH ═══
 *
 * §24's own examples rule it out. It puts "condition changed" at MEDIUM and
 * "trigger changed from CREATE to UPDATE" at HIGH — and both are TRIGGER
 * changes. The difference is not the category, it is what changed within it: a
 * new condition narrows or widens WHICH records the flow runs for, while a new
 * trigger kind changes WHEN it runs at all, and everything downstream moves
 * with the second in a way it does not with the first.
 *
 * So the rules below key on the PATH, which is the only place that distinction
 * survives. The category table remains as the floor for anything the path rules
 * do not recognise — and the floor for an unrecognised category is UNKNOWN
 * rather than LOW, because "nothing here recognises this" and "this is
 * harmless" are different answers and §40's discipline applies to risk too.
 *
 * ═══ CERTAINTY BEFORE RISK (§25) ═══
 *
 * `rank` sorts on status first and risk second, which Phase 16 learned the hard
 * way: a POSSIBLE CRITICAL above a CONFIRMED HIGH puts speculation at the top
 * of every report. The overall risk of a comparison is likewise taken over the
 * CONFIRMED changes; anything unknown is reported beside it rather than allowed
 * to inflate it.
 */
import { DESTRUCTIVE } from '../lint/index.js';
import {
  KINDS, ELEMENTS, CATEGORIES, RISK, RISK_RANK, CATEGORY_RISK, STATUS, STATUS_RANK,
} from './schemas.js';

/**
 * The path rules, in order. The FIRST match wins, so they run most specific
 * first — and each one names the reason, because a risk a person cannot argue
 * with is a risk they cannot check.
 */
const RULES = Object.freeze([
  {
    id: 'trigger_kind',
    when: (c) => c.path === 'trigger.kind',
    risk: RISK.HIGH,
    why: 'The trigger kind decides WHEN the flow runs. Every effect it has moves with it, '
      + 'and records that used to be processed may no longer be — or may now be processed twice.',
  },
  {
    id: 'trigger_table',
    when: (c) => c.path === 'trigger.table',
    risk: RISK.HIGH,
    why: 'The flow now listens to a different table, so it runs for a different population of records.',
  },
  {
    id: 'trigger_presence',
    when: (c) => c.element === ELEMENTS.TRIGGER && (c.kind === KINDS.ADDED || c.kind === KINDS.REMOVED),
    risk: RISK.HIGH,
    why: 'A flow gaining or losing its trigger starts or stops running altogether.',
  },
  {
    id: 'flow_active',
    when: (c) => c.path === 'header.active',
    risk: RISK.HIGH,
    why: 'Activating or deactivating a flow starts or stops every effect it has.',
  },
  {
    id: 'condition',
    when: (c) => c.element === ELEMENTS.CONDITION,
    risk: RISK.MEDIUM,
    why: 'The condition decides which records the flow runs for. A narrower one silently stops '
      + 'processing records it used to; a wider one starts processing records it did not.',
  },
  {
    /*
     * ADDED **or** RETYPED INTO. FOUND BY REVIEW: this matched only ADDED, so
     * turning an existing "Update Record" into a "Delete Record" — the same
     * outcome by a different route, and arguably the easier one to miss in a
     * code review — fell through to the category floor and scored lower than
     * adding one. What matters is that the flow now deletes, not how it got there.
     */
    id: 'destructive_added',
    when: (c) => c.element === ELEMENTS.ACTION
      && (c.kind === KINDS.ADDED || c.kind === KINDS.CHANGED)
      && DESTRUCTIVE.test(String(c.after ?? ''))
      && !DESTRUCTIVE.test(String(c.before ?? '')),
    risk: RISK.HIGH,
    why: 'The flow now runs a step that removes or disables data, and did not before. '
      + 'Re-running the flow does not undo it.',
  },
  {
    id: 'security',
    when: (c) => c.categories.includes(CATEGORIES.SECURITY),
    risk: RISK.CRITICAL,
    why: 'The authority the flow acts under changed, so what it is permitted to do changed with it.',
  },
  {
    id: 'action_presence',
    when: (c) => c.element === ELEMENTS.ACTION && (c.kind === KINDS.ADDED || c.kind === KINDS.REMOVED),
    risk: RISK.MEDIUM,
    why: 'The flow does one more thing, or one thing fewer, than it did.',
  },
  {
    id: 'branch_move',
    when: (c) => c.element === ELEMENTS.BRANCH,
    risk: RISK.MEDIUM,
    why: 'The step moved into or out of a container, so the conditions under which it runs changed.',
  },
  {
    id: 'position_move',
    when: (c) => c.kind === KINDS.MOVED && c.semantic_type === 'position',
    risk: RISK.MEDIUM,
    why: 'Execution order changed, so a step may now run before something it used to run after.',
  },
  {
    id: 'reference',
    when: (c) => c.element === ELEMENTS.REFERENCE,
    risk: RISK.MEDIUM,
    why: 'The flow now acts on a different record than it did.',
  },
  {
    id: 'data_write',
    when: (c) => c.element === ELEMENTS.INPUT && c.categories.includes(CATEGORIES.DATA),
    risk: RISK.MEDIUM,
    why: 'What the flow writes changed, so records it processes end up in a different state.',
  },
  {
    id: 'flow_renamed',
    when: (c) => c.path === 'header.name',
    risk: RISK.MEDIUM,
    why: 'Anything that calls this flow by name — a subflow call, a script, a catalog item — finds it by '
      + 'that name. A rename does not change what it does and can stop it being reached at all.',
  },
  {
    id: 'cosmetic',
    when: (c) => c.categories.length === 1 && c.categories[0] === CATEGORIES.COSMETIC,
    risk: RISK.LOW,
    why: 'This is presentation. Nothing about what the flow does changed.',
  },
].map(Object.freeze));

/*
 * `.map(Object.freeze)` and not just the array. FOUND BY REVIEW: freezing the
 * array alone left every rule object writable, so `RULES[0].risk = 'LOW'` would
 * have silently succeeded at runtime — and a risk table that can be edited in
 * place is not the frozen literal this file's own comment claims it is.
 */

/**
 * The risk of one change, and the reason for it.
 *
 * A display-only entry is not a change and carries no risk — it exists on the
 * result so a reader is not baffled by a different label, and §19 is explicit
 * that it is not a semantic change.
 */
export function riskOf(change) {
  if (!change) return { risk: RISK.UNKNOWN, rule: null, why: 'There is no change to assess.' };
  if (change.display_only || change.kind === KINDS.UNCHANGED) {
    return { risk: RISK.LOW, rule: 'display_only', why: 'The identity did not change, only the label shown beside it.' };
  }

  for (const rule of RULES) {
    if (rule.when(change)) return { risk: rule.risk, rule: rule.id, why: rule.why };
  }

  /*
   * No path rule recognised it. Fall back to the category floor — the highest
   * risk any of its categories carries — and say that is what happened, so a
   * reader can tell a considered answer from a default one.
   */
  const floors = (change.categories ?? []).map((c) => CATEGORY_RISK[c]).filter(Boolean);
  if (!floors.length) {
    return {
      risk: RISK.UNKNOWN, rule: 'unrecognised',
      why: 'This build has no rule for a change of this shape, so how much it could cost is not established.',
    };
  }
  const highest = floors.reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a));
  return { risk: highest, rule: 'category_floor', why: `Assessed from its categories (${change.categories.join(', ')}).` };
}

/** Stamp every change with its risk. Pure; returns new objects. */
export function assess(changes) {
  return changes.map((c) => ({ ...c, ...riskOf(c) }));
}

/**
 * §25 — certainty first, then risk, then a stable tiebreak.
 *
 * The stable tiebreak matters as much as the order: §11 requires the same two
 * artifacts to produce identical output, and a sort with ties resolved by
 * insertion order is only deterministic by accident.
 */
export function rank(changes) {
  return [...changes].sort((a, b) => {
    const s = (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0);
    if (s) return s;
    const r = (RISK_RANK[b.risk] ?? 0) - (RISK_RANK[a.risk] ?? 0);
    if (r) return r;
    return a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind);
  });
}

/**
 * The risk of the comparison as a whole.
 *
 * Taken over the CONFIRMED changes only. A change this build could not decide
 * is reported beside the verdict rather than folded into it: raising the
 * headline on the strength of something unestablished is the same mistake as
 * lowering it, and §25 forbids the first explicitly.
 *
 * A comparison with nothing to assess is LOW, not UNKNOWN — "the two states are
 * identical" is a confident answer, and the one a reader most wants.
 */
export function overallRisk(changes, { complete = true } = {}) {
  const real = changes.filter((c) => !c.display_only && c.kind !== KINDS.UNCHANGED);
  if (!real.length) {
    return {
      risk: complete ? RISK.LOW : RISK.UNKNOWN,
      reason: complete
        ? 'The two states are semantically identical.'
        : 'No difference was found in the sections that could be read, and some sections could not be read.',
      unknown_changes: 0,
    };
  }

  const confirmed = real.filter((c) => c.status === STATUS.CONFIRMED);
  const unknown = real.filter((c) => c.status !== STATUS.CONFIRMED);
  const pool = confirmed.length ? confirmed : real;
  const top = pool.reduce((a, b) => ((RISK_RANK[b.risk] ?? 0) > (RISK_RANK[a.risk] ?? 0) ? b : a));

  return {
    risk: confirmed.length ? top.risk : RISK.UNKNOWN,
    reason: confirmed.length
      ? top.why
      : 'Every difference found is one whose effect this build could not establish.',
    driver: confirmed.length ? { path: top.path, rule: top.rule } : null,
    unknown_changes: unknown.length,
    /* §41 — an incomplete read can only ever lower confidence, never the risk. */
    note: complete ? null
      : 'Some of the artifact could not be read, so this assessment covers only what was compared.',
  };
}
