import { executionOrder } from './store.js';

/**
 * PHASE 4 — THE REVIEW REPRESENTATION.
 *
 * What a human is shown before they authorise anything. It is a PROJECTION of
 * the durable plan, never a second source of truth: everything here is derived
 * from the stored steps, so a UI cannot show one thing while the executor runs
 * another.
 *
 * WHAT IT HAS TO MAKE OBVIOUS. A review that lists steps is not a review. The
 * things a person actually needs before clicking approve are: what will change
 * on the instance, through which mechanism and into which scope, which of it is
 * irreversible, what will be checked afterwards — and, most importantly, what
 * is still UNKNOWN. An unknown that is not surfaced here is an unknown the
 * approval silently covers.
 */

/**
 * Operations that cannot be undone.
 *
 * Drawn from the same list the DBA destructive gate enforces, because a review
 * that called something reversible when the gate treats it as irreversible
 * would be worse than saying nothing.
 */
const IRREVERSIBLE = new Set([
  'drop_table', 'drop_column', 'truncate_table', 'rename_table', 'rename_column',
  'change_column_type', 'decrease_column_width', 'reparent_column',
]);

const isDestructive = (s) => {
  const op = String(s.operation || '').toLowerCase();
  const tool = String(s.tool || '');
  if (IRREVERSIBLE.has(op)) return true;
  if (/\b(drop|truncate|delete|remove|purge)\b/.test(op)) return true;
  return /^(delete_|dba_drop_|dba_delete_|dba_execute_irreversible)/.test(tool);
};

/**
 * Build the review a human reads.
 *
 * `unknowns` is the part that earns its place. Everything the plan could not
 * establish — an unresolved reference, a capability discovery reported as
 * unknown, a step with no verification — is collected here rather than left for
 * someone to notice by its absence.
 */
export function buildReview(plan, { fingerprint = null, discovered = null } = {}) {
  const steps = plan?.steps ?? [];
  const ordered = executionOrder(steps);
  const seq = ordered.ok ? ordered.order : steps;

  const mutating = seq.filter((s) => s.mutating);
  const destructive = seq.filter(isDestructive);

  const unknowns = [];
  for (const s of seq) {
    if (s.mutating && (!s.verification || s.verification.strategy === 'none')) {
      unknowns.push({ step: s.id, kind: 'no_verification', note: `${s.operation} changes the instance and names no way to prove it worked.` });
    }
    // A sys_id that no earlier step resolves is one the plan is assuming.
    const sysId = s.target?.sys_id ?? s.inputs?.sys_id ?? null;
    if (s.mutating && sysId && !s.depends_on?.length) {
      unknowns.push({
        step: s.id, kind: 'unresolved_target',
        note: `${s.operation} targets ${sysId} without depending on a step that resolved it.`,
      });
    }
    if (s.capability && discovered?.capabilities?.[s.capability]?.status === 'unknown') {
      unknowns.push({ step: s.id, kind: 'capability_unknown', note: `${s.capability} could not be established on this instance.` });
    }
  }

  return {
    goal: plan?.goal ?? null,
    fingerprint,
    stepCount: seq.length,
    order: seq.map((s) => s.id),
    orderable: ordered.ok,

    plannedChanges: mutating.map((s) => ({
      step: s.id,
      operation: s.operation,
      target: s.target ?? null,
      mechanism: s.mechanism,
      scope: s.scope ?? null,
      approval: s.approval?.required !== false,
      requiresElevation: Boolean(s.approval?.requiresElevation),
      verification: s.verification?.strategy ?? null,
      destructive: isDestructive(s),
    })),

    affectedArtifacts: [...new Set(seq.map((s) => s.target?.table).filter(Boolean))],
    affectedRecords: seq.map((s) => s.target?.sys_id).filter(Boolean),
    mechanisms: [...new Set(seq.map((s) => s.mechanism).filter(Boolean))],
    scopes: [...new Set(seq.map((s) => s.scope).filter(Boolean))],

    approvalRequired: mutating.length > 0,
    // Named separately from `plannedChanges` because this is the line a reviewer
    // must not skim past.
    destructive: destructive.map((s) => ({ step: s.id, operation: s.operation, target: s.target ?? null })),
    verificationMethods: [...new Set(mutating.map((s) => s.verification?.strategy).filter(Boolean))],
    unknowns,

    steps: seq.map((s, i) => ({
      position: i + 1,
      id: s.id,
      state: s.state ?? 'pending',
      operation: s.operation,
      capability: s.capability,
      mechanism: s.mechanism,
      scope: s.scope ?? null,
      mutating: Boolean(s.mutating),
      dependsOn: s.depends_on ?? [],
      approval: s.approval ?? null,
      verification: s.verification ?? null,
      expectedEffects: s.expected_effects ?? [],
      destructive: isDestructive(s),
    })),
  };
}

/** A compact human-readable rendering, for a terminal or a log. */
export function renderReview(review) {
  const lines = [`Plan — ${review.goal}`, ''];
  for (const s of review.steps) {
    const bits = [s.mechanism, s.scope, s.mutating ? 'approval required' : 'read-only'].filter(Boolean);
    lines.push(`${s.position}. ${s.operation}`);
    lines.push(`   ${bits.join(' · ')}`);
    if (s.verification?.strategy) lines.push(`   verification: ${s.verification.strategy}`);
    if (s.destructive) lines.push('   DESTRUCTIVE — this cannot be undone');
    if (s.dependsOn.length) lines.push(`   after: ${s.dependsOn.join(', ')}`);
  }
  if (review.unknowns.length) {
    lines.push('', 'Unknowns:');
    for (const u of review.unknowns) lines.push(`   ${u.step}: ${u.note}`);
  }
  return lines.join('\n');
}
