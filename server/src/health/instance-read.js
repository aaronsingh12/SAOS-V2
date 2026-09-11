import { table } from '../servicenow/client.js';
import { referenceLookup } from '../servicenow/schema.js';

/**
 * Health Assist's READ-ONLY seam onto the instance.
 *
 * Proposal building needs the current value of a field, and validation needs to
 * re-read it afterwards. Both are reads, and both go through the one client
 * like everything else in this app.
 *
 * WHY THIS MODULE EXISTS AT ALL. It is the single place in `health/` — beside
 * `extract.js` — that may name the client, and it deliberately re-exports
 * NOTHING that writes. Health Assist proposes; the plan executor is the only
 * thing that changes the instance, because that is the path with the approval
 * gate, the read-back and the audit trail on it. A test asserts that no module
 * under `health/` calls `table.create`, `table.update` or `table.remove`, and
 * this file is what makes that assertion meaningful rather than incidental.
 */
export function readRecord(tableName, sysId) {
  return table.get(tableName, sysId, 'all');
}

/**
 * Resolve a display name to a sys_id on the referenced table.
 *
 * THE GAP THIS CLOSES, measured live. Asked to fill `owned_by` on a CI, the
 * model found the answer — `managed_by` named David Loo — and then correctly
 * refused to propose it, because `owned_by` is a reference field and holds a
 * sys_id, not a name. Writing the name would have been dropped or stored
 * wrong, so the honest answer was a blank.
 *
 * Blank is honest but useless, and the missing half is a lookup the app
 * already has. This is the SAME `referenceLookup` the typeahead and the agent
 * use, so a proposal resolves references exactly the way every other write in
 * this app does — "never invent a sys_id, resolve it" applies here too.
 *
 * Still a read. It answers "which record is this name", never writes one.
 */
export async function resolveReference(tableName, query) {
  const term = String(query || '').trim();
  if (!term) return { matches: [] };
  const rows = await referenceLookup(tableName, term, 5);
  return {
    matches: (rows || []).map((r) => ({ sys_id: r.sys_id, display: r.display })),
  };
}
