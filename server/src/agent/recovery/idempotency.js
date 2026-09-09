import { toolMap } from '../tools.js';
import { CAPABILITIES } from '../capability-discovery.js';

/**
 * PHASE 6 — IS THIS OPERATION SAFE TO REPEAT?
 *
 * THE FAILURE THIS PREVENTS. A POST to `/incident` times out. The response is
 * lost; the incident may exist. An HTTP client's instinct is to retry, and the
 * result is two incidents and a user who asked for one. "Retryable at the
 * transport layer" and "safe to repeat as a business operation" are completely
 * different questions, and conflating them is how duplicates get created.
 *
 * SO ONLY TWO CLASSES MAY EVER BE RETRIED AUTOMATICALLY. A read changes
 * nothing. An idempotent write applied twice leaves the same state as applied
 * once. Everything else — a create, or anything this layer cannot establish —
 * stops for a human.
 *
 * DERIVED FROM EXISTING METADATA, NOT INVENTED PER OPERATION. The registry
 * already carries `mutating`, and a tool that declares `describeWrite` already
 * reports its operation as create / update / delete against a specific sys_id.
 * That is enough to answer this for the tools that can answer it, and the ones
 * that cannot are UNKNOWN — which stops, rather than being assigned a guess.
 */

export const IDEMPOTENCY = Object.freeze({
  READ_ONLY: 'READ_ONLY',
  IDEMPOTENT: 'IDEMPOTENT',
  NON_IDEMPOTENT: 'NON_IDEMPOTENT',
  UNKNOWN: 'UNKNOWN',
});

/** Only these two may be repeated without a person deciding. */
export const AUTO_RETRYABLE = Object.freeze([IDEMPOTENCY.READ_ONLY, IDEMPOTENCY.IDEMPOTENT]);

export const isAutoRetryable = (klass) => AUTO_RETRYABLE.includes(klass);

const verdict = (klass, reason, detail = null) => Object.freeze({ idempotency: klass, reason, detail });

/**
 * Classify one operation.
 *
 * @param {object} opts
 * @param {string} opts.tool        registry tool name
 * @param {object} opts.descriptor  the tool's own `describeWrite` output, when it has one
 * @param {string} opts.capability  the Phase 3 capability the step declared
 */
export function classifyIdempotency({ tool = null, descriptor = null, capability = null, registry = toolMap } = {}) {
  /*
   * A DESCRIPTOR IS EVIDENCE OF A WRITE, whatever the caller knew about the
   * tool.
   *
   * Checked before the tool, because `describeWrite` output is the stronger
   * signal: it names the operation and the target. Reading the tool first meant
   * a call that supplied a descriptor but no tool name fell through to
   * "no tool, so nothing to repeat" and classified a CREATE as READ_ONLY —
   * which would have cleared the one operation that must never be repeated.
   */
  const declaredOp = String(descriptor?.operation ?? '').toLowerCase();
  if (!tool && !declaredOp) {
    return verdict(IDEMPOTENCY.READ_ONLY, 'the step runs no tool and describes no write, so repeating it changes nothing');
  }

  const entry = tool ? registry.get(tool) : null;
  if (tool && !entry) {
    // The verb does not exist here. Not a retry question — the operation cannot
    // run at all, and saying UNKNOWN keeps it out of the automatic path.
    return verdict(IDEMPOTENCY.UNKNOWN, `${tool} is not in the registry, so nothing about it can be established`);
  }

  /* A read is always safe to repeat. The registry's own flag decides. */
  if (entry && !entry.mutating && !declaredOp) {
    return verdict(IDEMPOTENCY.READ_ONLY, `${tool} is read-only in the registry`);
  }

  /*
   * A mutating tool that cannot describe its own write cannot be classified.
   *
   * Two thirds of the mutating surface is in this position — the SDK-backed
   * tools verify themselves internally rather than through `describeWrite`. For
   * THIS question that is a genuine unknown: a flow install, an application
   * scaffold or an irreversible DDL each has its own repeat semantics, and
   * assuming one would be inventing exactly the kind of per-operation rule this
   * file must not invent.
   */
  if (entry && typeof entry.describeWrite !== 'function' && !descriptor) {
    return verdict(IDEMPOTENCY.UNKNOWN,
      `${tool} mutates but does not describe its write, so whether repeating it is safe cannot be established`,
      { capability, mutating: true });
  }

  const op = declaredOp;
  const sysId = descriptor?.sys_id ?? null;

  /*
   * CREATE IS NEVER AUTOMATICALLY REPEATABLE.
   *
   * A second create makes a second record. There is no deterministic
   * reconciliation mechanism in this build that can tell "my create landed"
   * from "someone else made a similar record", so this is the case that must
   * always reach a person.
   */
  if (op === 'create' || op === 'insert') {
    return verdict(IDEMPOTENCY.NON_IDEMPOTENT,
      'creating again would create a second record, and nothing here can prove the first one landed',
      { operation: op });
  }

  /*
   * UPDATE and DELETE against a KNOWN sys_id are idempotent.
   *
   * Setting the same fields on the same record twice leaves the same state;
   * deleting a row that is already gone leaves it gone. Both are conditional on
   * the target being identified — an update with no sys_id is a query-shaped
   * write whose blast radius is not knowable from here.
   */
  if ((op === 'update' || op === 'delete') && sysId) {
    return verdict(IDEMPOTENCY.IDEMPOTENT,
      `${op} on a known sys_id leaves the same state however many times it is applied`,
      { operation: op, sys_id: sysId });
  }
  if (op === 'update' || op === 'delete') {
    return verdict(IDEMPOTENCY.UNKNOWN,
      `${op} without a specific sys_id could affect an unknown number of records`,
      { operation: op });
  }

  return verdict(IDEMPOTENCY.UNKNOWN,
    `the operation "${op || '(unstated)'}" has no established repeat semantics here`,
    { operation: op || null });
}

/**
 * The same question at the CAPABILITY level, for a step that has not run yet.
 *
 * Coarser than the tool-level answer and used only where no descriptor exists.
 * It reads Phase 3's own `mutating` flag and nothing else — it does not invent
 * semantics for capabilities the taxonomy has not modelled.
 */
export function capabilityIsRead(capability) {
  const spec = CAPABILITIES[capability];
  if (!spec) return null;
  return spec.mutating === false;
}
