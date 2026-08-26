/**
 * WI-4 — one place that decides how an ELEVATION outcome is shown to a human.
 *
 * THE RULE, structural not remembered: green is reachable ONLY from a read-back-
 * proven EXECUTED tier. This function derives its visual state SOLELY from the
 * honest WI-3 result object (`tier` + pre-write `state`) — never from an HTTP
 * status, a returned sys_id, or "approval was granted". That inversion is the
 * M3/renderer-dishonesty class (writeOutcome.js was born from its first
 * instance: a success glyph welded onto "was not updated"); this is the same
 * discipline applied to the elevation path.
 *
 * Plain JS, not JSX, so the offline suite can assert every branch — Node cannot
 * import a .jsx file. Same reason writeOutcome.js / instanceState.js sit beside
 * their components.
 *
 * The six states, each distinct and each honest:
 *   EXECUTED    green — elevation used, target, and the CONFIRMED field set.
 *   COERCED     amber, loud — per-field requested-vs-actual diff; never hidden.
 *   FAILED      red — "did not land"; no fabricated reason when none is known.
 *   REFUSED     red — ineligible: names the role and why; nothing elevated/written.
 *   FAIL_CLOSED amber — "couldn't verify eligibility — blocked"; a refusal to
 *               attempt, not an op failure.
 *   DENIED      neutral — "you declined; nothing elevated, nothing written."
 */

const cell = (v) => (v && typeof v === 'object' ? (v.value ?? '') : (v ?? ''));

/**
 * `e` is the emitted `elevation` object:
 *   { tier, state, required_role, elevation_occurred, target,
 *     compared_fields, compared_detail, mismatches, coerced, unverified, detail, reason }
 */
export function elevationOutcome(e) {
  const role = e?.required_role || null;
  const target = e?.target || null;

  // ---- pre-write states (no write was attempted) ----
  // Checked BEFORE tier, and none of them can be green: a pre-write state means
  // nothing was elevated or written, whatever else the object carries.
  const state = e?.state || null;
  if (state === 'DENIED') {
    return base({
      green: false, tone: 'neutral', badgeClass: '', label: 'declined',
      headline: 'You declined — nothing was elevated, and nothing was written.',
      role, target, elevationOccurred: false, reason: null,
    });
  }
  if (state === 'REFUSED') {
    return base({
      green: false, tone: 'bad', badgeClass: 'red', label: 'refused — not eligible',
      headline: `Refused: this needs ${role || 'an elevated role'}, and the runner is not eligible. Nothing was elevated or written.`,
      role, target, elevationOccurred: false, reason: e?.reason || null,
    });
  }
  if (state === 'FAIL_CLOSED') {
    return base({
      green: false, tone: 'warn', badgeClass: 'amber', label: 'blocked — could not verify',
      headline: `Blocked: eligibility for ${role || 'the required role'} could not be verified, so no elevation was attempted (fail-closed).`,
      role, target, elevationOccurred: false, reason: e?.reason || null,
    });
  }

  // ---- post-write tiers (truth = target read-back) ----
  const tier = e?.tier || 'FAILED';

  if (tier === 'EXECUTED') {
    // THE ONLY GREEN STATE. Confirmed scope = the compared scope, exactly.
    return base({
      green: true, tone: 'ok', badgeClass: '', label: 'elevated & verified',
      headline: `Elevated with ${role || 'the required role'} and verified on the instance.`,
      role, target, elevationOccurred: e?.elevation_occurred === true,
      confirmedFields: (e?.compared_detail || []).map((d) => ({ field: d.field, requested: String(cell(d.requested)), actual: String(cell(d.actual)) })),
      reason: null,
    });
  }

  if (tier === 'COERCED') {
    const diffs = [
      ...(e?.mismatches || []).map((d) => ({ field: d.field, requested: String(cell(d.requested)), actual: String(cell(d.actual)), kind: 'changed' })),
      ...(e?.coerced || []).map((d) => ({ field: d.field, requested: String(cell(d.requested)), actual: String(cell(d.actual)), kind: 'platform-rewrote' })),
      ...(e?.unverified || []).map((f) => ({ field: f, requested: '(asserted)', actual: '(not read — unverified)', kind: 'unverified' })),
    ];
    return base({
      green: false, tone: 'warn', badgeClass: 'amber', label: 'stored, changed',
      headline: 'It landed, but not as requested — the platform changed or did not confirm some fields.',
      role, target, elevationOccurred: e?.elevation_occurred === true,
      showDiff: true, diffs, reason: e?.detail || null,
    });
  }

  // FAILED — did not land. No fabricated reason.
  return base({
    green: false, tone: 'bad', badgeClass: 'red', label: 'did not land',
    headline: 'The write did not land on the instance.',
    role, target, elevationOccurred: false,
    reason: e?.detail || null,   // null-safe: if no reason is known, say nothing rather than inventing one
  });
}

function base(o) {
  return {
    green: false, tone: 'neutral', badgeClass: '', label: '', headline: '',
    role: null, target: null, elevationOccurred: false,
    confirmedFields: [], showDiff: false, diffs: [], reason: null,
    ...o,
  };
}
