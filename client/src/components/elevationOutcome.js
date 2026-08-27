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
 * The states, each distinct and each honest:
 *   EXECUTED     green — elevation used, target, and the CONFIRMED field set.
 *   COERCED      amber, loud — per-field requested-vs-actual diff; never hidden.
 *   FAILED       red — "did not land"; no fabricated reason when none is known.
 *   REFUSED      red — ineligible: names the role and why; nothing elevated/written.
 *   FAIL_CLOSED  amber — "couldn't verify eligibility — blocked"; a refusal to
 *                attempt, not an op failure.
 *   DENIED       neutral — "you declined; nothing elevated, nothing written."
 *
 * WI-ACL-1 adds two, both for the same reason: an ACL is TWO records, and its
 * role requirement — the thing that decides who gets in — is not on the record
 * that read back.
 *   REFUSED_SPEC red — the rule was rejected BEFORE approval because it would
 *                not do what it looks like it does (empty, invalid role,
 *                condition on a nonexistent field, scoped target). Distinct from
 *                REFUSED, which is about permission rather than the rule itself.
 *   role_less    red — the loudest state here. The ACL row landed with NO roles
 *                and no other condition: an empty ACL, which DENIES EVERYONE it
 *                matches, and evidence the atomic rollback failed to run.
 *
 * And it tightens EXECUTED: green now requires the role links to have been read
 * AND to match. A perfect field diff on a rule with the wrong roles is not a
 * success, and must never be shown as one.
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
  if (state === 'REFUSED_SPEC') {
    /*
     * WI-ACL-1 — distinct from REFUSED on purpose.
     *
     * REFUSED means "you are not allowed to do this". This means "what you asked
     * for would break what you are trying to protect" — an ACL that would be
     * empty and deny everyone, a role that does not exist, a condition on a
     * field the table does not have. One is a permissions answer, the other is a
     * request that needs rewriting, and a user who cannot tell them apart will
     * chase the wrong fix. Nothing was elevated or written in either case.
     */
    return base({
      green: false, tone: 'bad', badgeClass: 'red', label: 'refused — unsafe rule',
      headline: 'Refused before approval: that rule would not do what it looks like it does. Nothing was elevated or written.',
      role, target, elevationOccurred: false, reason: e?.reason || null,
      specRefusal: e?.spec_refusal?.reason || null,
    });
  }

  // ---- post-write tiers (truth = target read-back) ----
  const tier = e?.tier || 'FAILED';
  const acl = e?.acl || null;

  if (tier === 'EXECUTED') {
    /*
     * THE ONLY GREEN STATE. Confirmed scope = the compared scope, exactly.
     *
     * WI-ACL-1 adds a SECOND half to that scope for an ACL. An ACL's role
     * requirement lives in `sys_security_acl_role`, not on the ACL, so a row that
     * read back perfectly says nothing at all about whether the rule requires the
     * role the user asked for. Green here therefore requires the role links to
     * have been READ and to MATCH; a tier that says EXECUTED while the role half
     * was never read is downgraded rather than trusted, because "not read" and
     * "correct" are the two things this renderer exists to keep apart.
     */
    if (acl && acl.roles && !(acl.roles.read === true && acl.roles.ok === true)) {
      return base({
        green: false, tone: 'warn', badgeClass: 'amber', label: 'fields verified, roles NOT',
        headline: 'The ACL row landed and its fields match — but its ROLE requirement was not confirmed, so this is not verified.',
        role, target, elevationOccurred: e?.elevation_occurred === true,
        showDiff: true,
        diffs: [{ field: 'required roles', requested: (acl.roles_expected || []).join(', ') || '(none)', actual: acl.roles.detail || '(not read)', kind: 'unverified' }],
        reason: acl.roles.detail || null,
        aclRoles: acl.roles,
      });
    }
    return base({
      green: true, tone: 'ok', badgeClass: '', label: 'elevated & verified',
      headline: `Elevated with ${role || 'the required role'} and verified on the instance.`,
      role, target, elevationOccurred: e?.elevation_occurred === true,
      confirmedFields: (e?.compared_detail || []).map((d) => ({ field: d.field, requested: String(cell(d.requested)), actual: String(cell(d.actual)) })),
      reason: null,
      aclRoles: acl?.roles || null,
    });
  }

  /*
   * WI-ACL-1 — THE LOCKOUT STATE, checked before COERCED and rendered as the
   * loudest thing this component can say.
   *
   * `role_less` means the ACL row landed, roles were asked for, none are present,
   * and the rule carries no other condition. That is an EMPTY ACL: the platform
   * denies by default on it, so the rule is not "incomplete", it is actively
   * refusing everyone it matches. It also means the atomic rollback did not run.
   *
   * Rendering that as amber "stored, changed" alongside a coerced choice value
   * would be the M3 class in its purest form — the same visual weight for "a
   * field got rewritten" and "you have locked users out of this table". It gets
   * its own state, and it tells the reader what to do about it.
   */
  if (e?.acl?.role_less === true) {
    return base({
      green: false, tone: 'bad', badgeClass: 'red', label: 'EMPTY ACL — denies everyone',
      headline: 'The ACL row is on the instance with NO role requirement and no other condition. '
        + 'An empty ACL denies everyone it matches, and the rollback that should have removed it did not run. Delete it now.',
      role, target, elevationOccurred: e?.elevation_occurred === true,
      showDiff: true,
      diffs: [{ field: 'required roles', requested: (e.acl.roles_expected || []).join(', ') || '(none)', actual: '(none present)', kind: 'changed' }],
      reason: e?.detail || null,
      aclRoles: e?.acl?.roles || null,
      lockout: true,
    });
  }

  if (tier === 'COERCED') {
    const diffs = [
      ...(e?.mismatches || []).map((d) => ({ field: d.field, requested: String(cell(d.requested)), actual: String(cell(d.actual)), kind: 'changed' })),
      ...(e?.coerced || []).map((d) => ({ field: d.field, requested: String(cell(d.requested)), actual: String(cell(d.actual)), kind: 'platform-rewrote' })),
      ...(e?.unverified || []).map((f) => ({ field: f, requested: '(asserted)', actual: '(not read — unverified)', kind: 'unverified' })),
      // The role half sits in the SAME diff list, so a rule whose fields are
      // perfect and whose role requirement is wrong cannot read as "fine".
      ...(acl && acl.roles && !acl.roles.ok
        ? [{ field: 'required roles', requested: (acl.roles_expected || []).join(', ') || '(none)', actual: acl.roles.detail || '(not read)', kind: acl.roles.read ? 'changed' : 'unverified' }]
        : []),
    ];
    return base({
      green: false, tone: 'warn', badgeClass: 'amber', label: 'stored, changed',
      headline: 'It landed, but not as requested — the platform changed or did not confirm some fields.',
      role, target, elevationOccurred: e?.elevation_occurred === true,
      showDiff: true, diffs, reason: e?.detail || null,
      aclRoles: acl?.roles || null,
    });
  }

  // FAILED — did not land. No fabricated reason.
  return base({
    green: false, tone: 'bad', badgeClass: 'red', label: 'did not land',
    headline: acl?.operation === 'delete'
      ? 'The ACL was not removed — it is still on the instance and still enforcing.'
      : 'The write did not land on the instance.',
    role, target, elevationOccurred: false,
    reason: e?.detail || null,   // null-safe: if no reason is known, say nothing rather than inventing one
    aclRoles: acl?.roles || null,
  });
}

function base(o) {
  return {
    green: false, tone: 'neutral', badgeClass: '', label: '', headline: '',
    role: null, target: null, elevationOccurred: false,
    confirmedFields: [], showDiff: false, diffs: [], reason: null,
    // WI-ACL-1 — the role half and the two ACL-specific flags, always present so
    // a consumer never has to distinguish "absent" from "false".
    aclRoles: null, specRefusal: null, lockout: false,
    ...o,
  };
}
