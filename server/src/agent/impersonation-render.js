import { getMode } from '../memory/impersonation-mode.js';

/**
 * B6 — renderer honesty for impersonation.
 *
 * TWO JOBS, both of which are about not saying something untrue:
 *
 *   1. The chip. A human must never have to remember whose authority the thing
 *      in front of them carries.
 *   2. Denial labels. A blocked operation must be labelled by its actual cause,
 *      because "Aagamya cannot see this" and "this table refuses cross-scope
 *      writes" are different facts about different subjects, and mislabelling
 *      the second as the first invents a claim about a person.
 *
 * WHY THE CHIP IS NOT SIMPLY "AS <user> (impersonated)".
 *
 * The build pack specifies that wording on every approval card and result line
 * while mode is active. Taken literally it would be false today, in exactly the
 * way B5 caught: no mutating tool routes its write through the impersonation
 * wrapper, so `update_record` executes over REST as the NowHelpAssist service
 * account even while mode is on. A card reading "AS aagamya.tanwar" over a
 * write that will be stamped `admin` is the confidently-wrong failure this
 * project exists to prevent — and it is worse on an approval card than
 * anywhere else, because it is the moment a person is deciding.
 *
 * So the chip reports mode AND what this particular operation actually
 * executes as. When an operation genuinely runs impersonated it says so in the
 * pack's words; when it does not, it says that instead. The two are never
 * spelled the same way.
 */

export const CHIP_TONE = { IMPERSONATED: 'amber', MODE_ONLY: 'blue' };

/**
 * The chip for one operation, or null when nothing is being impersonated.
 *
 * `executesImpersonated` is the caller's claim about THIS operation, and it is
 * required rather than defaulted so a new call site has to think about it. A
 * tool that reaches the instance through `runImpersonated` passes true; anything
 * going over the ordinary REST path passes false.
 */
export function impersonationChip(sessionId, { executesImpersonated = false } = {}) {
  const mode = getMode(sessionId);
  if (!mode.active) return null;

  const who = mode.target.user_name;
  if (executesImpersonated) {
    return {
      label: `AS ${who} (impersonated)`,
      tone: CHIP_TONE.IMPERSONATED,
      executesImpersonated: true,
      target: mode.target,
      task: mode.task,
      title: `This runs as ${who}. The instance will record it as their work and keeps no record of the real `
        + 'initiator — NowHelpAssist\'s audit ledger is the only place that exists.',
    };
  }

  return {
    label: `impersonating ${who} · this runs as NowHelpAssist`,
    tone: CHIP_TONE.MODE_ONLY,
    executesImpersonated: false,
    target: mode.target,
    task: mode.task,
    title: `Impersonation mode is active for ${who}, but this operation does not go through the impersonation `
      + 'path — it runs under the NowHelpAssist service identity and the instance will attribute it there.',
  };
}

/* ------------------------------------------------------------------ *
 * Denial labelling
 * ------------------------------------------------------------------ */

export const DENIAL = {
  ALLOWED: 'allowed',
  LAYER_1: 'layer1_scope_policy',
  LAYER_2: 'layer2_user_acl',
  UNKNOWN: 'unknown',
};

/**
 * Label a denial from the PRE-FLIGHT capability booleans.
 *
 * Phase 0 measured this the hard way: across ten cross-scope and ACL-denied
 * operations, NOTHING THREW. Not a denied read, not a denied write, not a
 * cross-scope block. There are no denial strings on this platform to match on,
 * so there is nothing to parse and no exception to inspect — which is why the
 * capability booleans have to be read BEFORE the operation rather than after it
 * fails, because it will not fail.
 *
 * THE DISCRIMINATOR IS `canRead`:
 *
 *   Layer-1 (application/scope policy) refuses the OPERATION and leaves the
 *   table readable — measured `canRead: true` with canWrite/canCreate/canDelete
 *   all false on a caller_access=2 table from the global harness.
 *
 *   Layer-2 (the user's ACLs) removes the user's sight of the rows entirely —
 *   measured `canRead: false` for a role-less impersonated user, with the
 *   secure query iterating zero rows.
 *
 * `canRead: true` with everything else also true is not a denial at all.
 */
export function classifyDenial({ preflight, operation = 'write' } = {}) {
  if (!preflight || typeof preflight !== 'object') {
    return {
      layer: DENIAL.UNKNOWN,
      allowed: null,
      label: 'permission not checked',
      detail: 'No capability pre-flight was recorded for this operation, so its outcome cannot be attributed to a '
        + 'cause. Nothing throws on denial here, so an absent pre-flight means the answer is genuinely unknown '
        + 'rather than fine.',
    };
  }

  const canRead = truthy(preflight.canRead);
  const opAllowed = truthy(operationFlag(preflight, operation));

  /*
   * THE OPERATION'S OWN FLAG IS ASKED FIRST, and that ordering is a fix, not a
   * detail. Measured live on dev442675: a role-less user has canRead FALSE and
   * canCreate TRUE on `incident`, and Phase 0 watched that insert genuinely
   * succeed. An earlier version here tested canRead first and reported
   * "aagamya.tanwar lacks permission" for a create she can actually perform —
   * a denial label on an operation that was about to work.
   *
   * Read-denied-but-write-allowed is a real ServiceNow shape, not an edge case
   * to normalise away. It is reported as PERMITTED, with the consequence
   * named: the operation lands, and the acting user cannot see what they did.
   */
  if (opAllowed) {
    return {
      layer: DENIAL.ALLOWED,
      allowed: true,
      label: 'permitted',
      detail: canRead ? null
        : 'Permitted, but the acting user cannot READ this table — the operation will land and they will not be '
          + 'able to see the result. Read it back as NowHelpAssist to confirm what happened.',
      writeOnly: !canRead,
    };
  }

  // Sight of the table is intact, the operation is not: the table is refusing
  // the operation, not the person.
  if (canRead && !opAllowed) {
    return {
      layer: DENIAL.LAYER_1,
      allowed: false,
      label: 'blocked by application/scope access',
      detail: 'The table is readable but refuses this operation to callers outside its own application scope. '
        + 'This is a property of the TABLE, not of any user — the same block would apply whoever was acting.',
    };
  }

  // No sight of the table at all: this is about the effective user.
  return {
    layer: DENIAL.LAYER_2,
    allowed: false,
    label: 'the acting user lacks permission',
    detail: 'The effective user cannot read this table, so their ACLs — not the application scope — are what '
      + 'blocks this. A different user might be permitted.',
  };
}

/**
 * The sentence a human reads, with the impersonated user named when there is
 * one. Kept separate from the classification so the label can be tested without
 * a session and rendered with one.
 */
export function denialSentence({ preflight, operation = 'write', target = null } = {}) {
  const verdict = classifyDenial({ preflight, operation });
  if (verdict.layer === DENIAL.ALLOWED) return { ...verdict, sentence: null };
  if (verdict.layer === DENIAL.UNKNOWN) return { ...verdict, sentence: verdict.label };

  const who = target?.user_name ?? 'the acting user';
  const sentence = verdict.layer === DENIAL.LAYER_1
    // Deliberately does NOT name the user: doing so would assert a fact about
    // their permissions that this signal does not support.
    ? `Blocked by application/scope access on this table — not by ${who}'s permissions.`
    : `${who} lacks permission for this.`;
  return { ...verdict, sentence };
}

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

function operationFlag(preflight, operation) {
  switch (String(operation)) {
    case 'read': return preflight.canRead;
    case 'insert':
    case 'create': return preflight.canCreate;
    case 'delete': return preflight.canDelete;
    case 'update':
    case 'write':
    default: return preflight.canWrite;
  }
}
