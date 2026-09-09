import { table } from '../servicenow/client.js';
import { getSchema } from '../servicenow/schema.js';
import { diffWrite, verificationForModel } from '../servicenow/write-verify.js';
import { log } from '../logging.js';

/**
 * The I/O half of WI-1: fetch what the pure verifier needs, then run it.
 *
 * Kept out of `write-verify.js` on purpose — that module stays pure so every
 * classification rule can be asserted offline against recorded fixtures. This
 * one does the two round trips those rules depend on, and both are optional:
 * a verification that cannot be performed reports `unverified` with a reason,
 * and NEVER reports success. "We could not check" and "we checked and it was
 * fine" must not render the same way, which is the whole lesson of the defect
 * this exists for.
 */

/**
 * Snapshot before an update.
 *
 * This is what makes `dropped` provable rather than inferred: a discarded write
 * leaves the record's previous value in place, so without the previous value
 * the diff can only say "different", not "unchanged". It also supplies the
 * cheap decisive signal — `sys_mod_count` and `sys_updated_on` frozen.
 *
 * One GET, only for updates, only when the tool declared what it was touching.
 */
export async function snapshotBefore(descriptor) {
  if (!descriptor || descriptor.operation !== 'update') return null;
  if (!descriptor.table || !descriptor.sys_id) return null;
  try {
    return await table.get(descriptor.table, descriptor.sys_id, 'all');
  } catch (err) {
    log.debug?.('verify', `no pre-write snapshot for ${descriptor.table}/${descriptor.sys_id}: ${err.message}`);
    return null;
  }
}

/** Field name → internal_type, for the journal exclusion. Best effort. */
async function fieldTypesFor(tableName) {
  if (!tableName) return { types: {}, hierarchy: [] };
  try {
    const schema = await getSchema(tableName);
    const types = {};
    for (const f of schema.fields || []) types[f.name] = f.type || f.internal_type;
    return { types, hierarchy: schema.hierarchy || [] };
  } catch {
    // Losing the schema costs precision on journal fields only; it must not
    // cost the whole verification.
    return { types: {}, hierarchy: [] };
  }
}

/**
 * A delete is verified by absence, not by a field diff.
 *
 * Cheap, and it closes the same class of lie: the Table API answers 204 to a
 * DELETE it did not perform just as readily as to one it did.
 */
async function verifyDelete(descriptor) {
  try {
    const rows = await table.query(descriptor.table, {
      query: `sys_id=${descriptor.sys_id}`, fields: 'sys_id', limit: 1, display: 'false',
    });
    const gone = rows.length === 0;
    return {
      verified: gone,
      status: gone ? 'applied' : 'no-op',
      summary: gone
        ? `the record is gone from ${descriptor.table}`
        : `no-op: ${descriptor.table}/${descriptor.sys_id} is still on the instance after the delete returned success`,
      applied: gone ? [{ field: 'sys_id', value: descriptor.sys_id }] : [],
      dropped: gone ? [] : [{ field: 'sys_id', requested: 'deleted', actual: 'still present', reason: 'the record survived the delete' }],
      transformed: [], unverifiable: [], noOpSignal: null,
    };
  } catch (err) {
    return unverified(`the delete could not be confirmed: ${err.message}`);
  }
}

function unverified(reason) {
  return {
    verified: false, status: 'unverified', summary: reason,
    applied: [], dropped: [], transformed: [],
    unverifiable: [{ field: '(all)', reason }], noOpSignal: null,
  };
}

/**
 * Verify one completed mutation.
 *
 * `descriptor` comes from the tool's own `describeWrite`. A tool that returns
 * null is not a hole in the coverage — the SDK-backed tools and the verifiers
 * read their work back through their own paths, and are labelled as such
 * rather than being diffed against a shape they never promised.
 */
export async function verifyMutation({ descriptor, result, before, toolName }) {
  /*
   * SESSION 1 / WI-4 — A REFUSAL IS NOT A WRITE TO VERIFY.
   *
   * The record tools now answer `{ ok: false, refused: true, reason }` for a
   * policy-refused or unknown table, and they carry a descriptor like any
   * other write. Diffing that answer against the descriptor's requested fields
   * would report every field "not returned at all", label the call a no-op,
   * and register the drops — a confident account of a write that was never
   * attempted. The tool's own verdict is the evidence, and it is conclusive.
   */
  if (result && result.ok === false && result.refused === true) {
    const why = `${toolName} refused before writing (${result.reason ?? 'refused'}); nothing was attempted`;
    return {
      verified: false, status: 'unverified', summary: why,
      applied: [], dropped: [], transformed: [],
      unverifiable: [{ field: '(all)', reason: why }], noOpSignal: null,
      verifiedBy: toolName,
      notAttempted: true,
      refused: result.reason ?? 'refused',
    };
  }
  if (!descriptor) {
    /*
     * WI-5 — A TOOL THAT REPORTED FAILURE HAS NOT SELF-VERIFIED ANYTHING.
     *
     * This branch used to return `self-verified` for every descriptor-less
     * tool, without ever looking at what the tool SAID. So a `create_flow_live`
     * call that refused at the binding preflight — `ok: false`,
     * `bindingRefused: true`, nothing attempted, nothing installed — came back
     * labelled self-verified, was written to the mutation ledger, and rendered
     * in the turn summary as "1 mutation ✅ create_flow_live".
     *
     * The tool's own result is the only evidence available here, and it is
     * conclusive in the negative direction: a tool reporting `ok: false` did
     * not write. `notAttempted` carries that to the ledger, which then declines
     * to record a mutation that never happened.
     */
    if (result && result.ok === false) {
      const why = result.bindingRefused
        ? `${toolName} was refused at the binding preflight; nothing was attempted`
        : `${toolName} reported failure; nothing was written`;
      return {
        verified: false, status: 'unverified', summary: why,
        applied: [], dropped: [], transformed: [],
        unverifiable: [{ field: '(all)', reason: why }], noOpSignal: null,
        verifiedBy: toolName,
        notAttempted: true,
      };
    }
    return {
      /*
       * `verified: null` and NOT true. The harness checked nothing here — this
       * is the tool's own account of its own work, and the status word says so.
       */
      verified: null, status: 'self-verified', summary: `${toolName} reports its own read-back — not checked by the harness`,
      applied: [], dropped: [], transformed: [], unverifiable: [], noOpSignal: null,
      verifiedBy: toolName,
    };
  }
  if (descriptor.operation === 'delete') return verifyDelete(descriptor);

  /*
   * The record as the platform returned it. `create`/`update` hand back the
   * written record; anything else means we have nothing to diff against.
   *
   * A COMPOSITE TOOL RETURNS A WRAPPER, NOT A RECORD, and that made its
   * read-back structurally impossible. FOUND BY THE PHASE 20 PDI:
   * `create_catalog_item` creates an item AND its variables, so its result is
   * `{ item, variables }`. Diffing the requested `name` against that wrapper
   * found no `name` anywhere and reported `no-op: the platform discarded this
   * write` — about a catalog item that had been created perfectly.
   *
   * So a `describeWrite` may now name the record inside its own result. Every
   * tool that returns the record directly is unaffected: the fallback is the
   * behaviour that was always there.
   */
  const returned = (descriptor.record && typeof descriptor.record === 'object')
    ? descriptor.record
    : (result && typeof result === 'object' ? result : null);
  if (!returned) return unverified('the tool returned no record to compare against');

  const { types, hierarchy } = await fieldTypesFor(descriptor.table);
  return diffWrite({
    table: descriptor.table,
    operation: descriptor.operation || 'update',
    requested: descriptor.requested || {},
    returned,
    before,
    fieldTypes: types,
    hierarchy,
  });
}

/**
 * Attach the verdict to the payload the MODEL reads.
 *
 * Appended after truncation rather than before it. The result body is cut at a
 * character limit, and a verification spliced in beforehand is exactly the kind
 * of tail that gets silently removed — which would leave the model reading a
 * plausible success with the disproof cut off. That is the shape of the
 * original defect, so the block is placed where the cut cannot reach it.
 */
export function attachVerification(truncatedOutput, verification) {
  const block = verificationForModel(verification);
  if (!block) return truncatedOutput;
  return `${truncatedOutput}\n${JSON.stringify({ verification: block }, null, 1)}`;
}

/**
 * How a verified mutation should be reported: as an error the model must react
 * to, or as an ordinary success.
 *
 * A dropped field is NOT an exception — the call reached the instance and part
 * of it may have landed — but it must not read as plain success either, or the
 * model narrates a write that did not happen. `isError` drives the model's own
 * framing, and the status drives the renderer (WI-6).
 */
export function isFailedWrite(verification) {
  return Boolean(verification) && (verification.status === 'no-op' || verification.status === 'partial');
}
