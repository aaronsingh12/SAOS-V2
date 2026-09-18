import { isCaptureOn, sweep, sweepMark, classifyTable } from '../servicenow/transport.js';
import { harvestSysIds } from '../memory/audit.js';
import { recordToolEvent } from '../memory/sessions.js';
import { log } from '../logging.js';

/**
 * The capture hook — what runs after a mutating tool succeeds.
 *
 * Two rules shape everything here.
 *
 * **Capture must never break the turn.** By the time this runs the tool has
 * already written to the instance. A sweep that threw would turn a successful
 * change into a failed turn while leaving the change in place, which is the
 * worst of both. Everything is caught, and a failure is reported as a capture
 * failure rather than a tool failure.
 *
 * **A non-config mutation must SAY so.** Creating an incident produces no
 * `sys_update_xml` row, so a capture that simply found nothing is
 * indistinguishable from one that silently failed. The audit row says
 * "not captured — data, not configuration" and names the table, which is the
 * difference between a feature you can trust and one you cannot.
 *
 * Targets are derived without a per-tool table map: `harvestSysIds` already
 * pulls record ids out of arbitrary tool results for the audit page, and the
 * sweep can locate an update row from a bare sys_id (`nameENDSWITH`), so the
 * hook never needs to know which table a given tool writes to.
 */

/**
 * Tables a tool is known to write, used ONLY to explain a non-capture.
 *
 * This is not how the capture verdict is reached — that comes from what the
 * sweep actually found on the instance. It exists so the audit row can say
 * *why* nothing was captured, and it is small on purpose: an entry that goes
 * stale makes a message less specific, never a result wrong.
 */
const TOOL_TABLE_HINT = {
  create_record: (input) => input?.table,
  update_record: (input) => input?.table,
  delete_record: (input) => input?.table,
  create_incident: () => 'incident',
  create_catalog_item: () => 'sc_cat_item',
  create_record_producer: () => 'sc_cat_item_producer',
  add_catalog_variable: () => 'item_option_new',
  update_catalog_variable: () => 'item_option_new',
  create_ui_policy: () => 'catalog_ui_policy',
  create_flow_live: () => 'sys_hub_flow',
  delete_live_flow: () => 'sys_hub_flow',
  create_sla: () => 'contract_sla',
};

/** A stamp taken BEFORE the tool runs, so the sweep window covers the whole call. */
export const captureMark = () => sweepMark();

/**
 * Sweep whatever one successful mutating call produced.
 *
 * Returns the event the caller should emit, or null when capture is off.
 */
export async function captureAfterTool({
  sessionId, sessionTitle, toolName, input, result, since,
  /*
   * PHASE 8 — the task that owns this capture, when one does.
   *
   * A capture event is written by whoever called the tool, so it belongs to
   * that caller's task. NULL from the ordinary turn loop, which has no plan.
   * Without this the plan executor tagged its own tool events but left the
   * capture event beside them untagged, and the evidence then reported itself
   * as only-correlated because of a row it had in fact produced.
   */
  taskId = null,
}) {
  if (!isCaptureOn(sessionId)) return null;

  const hint = TOOL_TABLE_HINT[toolName]?.(input) || null;
  let classification = null;
  if (hint) {
    try { classification = await classifyTable(hint); } catch { /* explained below as unknown */ }
  }

  // A tool whose table is KNOWN to be data has nothing to sweep. Saying so
  // without a round trip is both faster and more honest than reporting an
  // empty sweep.
  if (classification && classification.configuration === false) {
    const event = {
      type: 'capture',
      captured: false,
      reason: 'data',
      table: hint,
      message: `not captured — data, not configuration (${hint} does not extend sys_metadata)`,
      moved: 0, sets: [], failures: [],
    };
    recordToolEvent(sessionId, {
      taskId,
      kind: 'capture', name: toolName, payload: { table: hint },
      result: JSON.stringify(event), resultStatus: 'skipped', mutating: false, approval: null,
    });
    return event;
  }

  const sysIds = harvestSysIds(input, result);
  try {
    const swept = await sweep({ sessionId, sessionTitle, since, sysIds, label: toolName });
    const event = {
      type: 'capture',
      captured: swept.moved.length > 0,
      moved: swept.moved.length,
      updates: swept.moved.map((m) => ({ name: m.name, target: m.target, type: m.type, scope: m.scope })),
      sets: swept.sets,
      collapsed: swept.collapsed.length,
      failures: swept.failures,
      unassigned: swept.unassigned,
      scanned: swept.scanned,
      elapsedMs: swept.elapsedMs,
      message: swept.unassigned.length
        ? `captured ${swept.moved.length}; ${swept.unassigned.length} left unassigned — another capture session's window covers them`
        : swept.moved.length
        ? `captured ${swept.moved.length} update${swept.moved.length === 1 ? '' : 's'} into ${swept.sets.map((s) => s.setName).join(', ')}`
        : classification?.configuration === null
          ? `nothing captured — ${hint || 'this table'} could not be classified, so whether that is correct is unknown`
          : 'nothing captured — this call produced no tracked configuration change',
    };
    recordToolEvent(sessionId, {
      taskId,
      kind: 'capture', name: toolName, payload: { sysIds: sysIds.slice(0, 20), since },
      result: JSON.stringify(event), resultStatus: swept.failures.length ? 'error' : 'ok',
      mutating: false, approval: null,
    });
    if (swept.failures.length) {
      log.warn('transport', `capture after ${toolName}: ${swept.failures.length} row(s) could not be captured`);
    }
    return event;
  } catch (err) {
    // Loud, recorded, and NOT fatal — the tool already succeeded.
    log.error('transport', `capture after ${toolName} failed: ${err.message}`, err.detail || err);
    const event = {
      type: 'capture', captured: false, reason: 'error', moved: 0, sets: [], failures: [{ stage: 'sweep', message: err.message }],
      message: `capture failed after ${toolName}: ${err.message}. The change itself succeeded and is in the Default update set.`,
    };
    recordToolEvent(sessionId, {
      taskId,
      kind: 'capture', name: toolName, payload: { since },
      result: JSON.stringify(event), resultStatus: 'error', mutating: false, approval: null,
    });
    return event;
  }
}

/**
 * End-of-turn reconciliation.
 *
 * The per-call sweep is keyed on ids the tool reported. This one is keyed only
 * on time, so it collects anything those missed — collateral rows a composite
 * builder produced, or a change made by an SDK install that reports its own
 * artifacts and not the twelve cross-scope privileges beside them.
 */
export async function reconcileTurn({ sessionId, sessionTitle, since, taskId = null }) {
  if (!isCaptureOn(sessionId) || !since) return null;
  try {
    const swept = await sweep({ sessionId, sessionTitle, since, label: 'turn-reconcile' });
    if (!swept.moved.length && !swept.failures.length && !swept.unassigned.length) return null;
    const event = {
      type: 'capture',
      phase: 'reconcile',
      captured: swept.moved.length > 0,
      moved: swept.moved.length,
      updates: swept.moved.map((m) => ({ name: m.name, target: m.target, type: m.type, scope: m.scope })),
      sets: swept.sets,
      collapsed: swept.collapsed.length,
      failures: swept.failures,
      unassigned: swept.unassigned,
      message: `end of turn: ${swept.moved.length} further update${swept.moved.length === 1 ? '' : 's'} captured`
        + (swept.unassigned.length ? `, ${swept.unassigned.length} unassigned` : ''),
    };
    recordToolEvent(sessionId, {
      taskId,
      kind: 'capture', name: 'turn-reconcile', payload: { since },
      result: JSON.stringify(event), resultStatus: swept.failures.length ? 'error' : 'ok',
      mutating: false, approval: null,
    });
    return event;
  } catch (err) {
    log.error('transport', `turn reconciliation failed: ${err.message}`);
    return null;
  }
}
