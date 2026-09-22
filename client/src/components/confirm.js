/**
 * One place destructive confirmation happens.
 *
 * Every delete used to call `window.confirm` inline with its own wording,
 * which meant no consistent phrasing and — more to the point — no single seam
 * to replace. D-2's dialog drops in HERE and nowhere else: the call sites were
 * already promise-based, so swapping the native modal for a real dialog was
 * not also an async refactor of every caller.
 *
 * If no dialog host is mounted this throws rather than falling back to
 * `window.confirm`. A silent fallback would mean the app quietly reverts to
 * the thing this replaced, on the exact code path where being wrong deletes
 * something.
 */

let host = null;

/** Called by ConfirmDialog when it mounts. Returns its own unregister. */
export function registerConfirmHost(fn) {
  host = fn;
  return () => { if (host === fn) host = null; };
}

function ask(request) {
  if (!host) {
    throw new Error(
      'No confirmation dialog is mounted — <ConfirmDialog /> must be rendered at the app root. ' +
      'Refusing to fall back to window.confirm on a destructive action.'
    );
  }
  return host(request);
}

/**
 * @param {object} opts
 * @param {string} opts.action    what is about to happen, e.g. "Delete variable"
 * @param {string} opts.subject   what it happens to, e.g. "justification"
 * @param {string} [opts.detail]  the consequence a person needs before deciding
 * @param {string} [opts.sysId]   the exact record, shown in mono — the subject
 *                                is a label and labels are not unique
 * @param {string} [opts.confirmLabel]
 * @returns {Promise<boolean>}
 */
export function confirmDestructive({ action, subject, detail, sysId, confirmLabel }) {
  return ask({ kind: 'confirm', action, subject, detail, sysId, confirmLabel, danger: true });
}

/**
 * The non-destructive twin — "create this?", "reinstall?". Same dialog, no
 * danger styling, so an ordinary confirmation does not cry wolf in red.
 */
export function confirmAction({ action, subject, detail, sysId, confirmLabel }) {
  return ask({ kind: 'confirm', action, subject, detail, sysId, confirmLabel, danger: false });
}

/**
 * `window.prompt` had exactly one call site (renaming a chat), and leaving one
 * native modal in an app that just removed all the others reads as a bug.
 * @returns {Promise<string|null>} null when cancelled
 */
export function promptFor({ action, subject, label, value = '', confirmLabel = 'Save' }) {
  return ask({ kind: 'prompt', action, subject, label, value, confirmLabel, danger: false });
}

/**
 * The consequence lines, written once so they read the same everywhere and so
 * the ones that are load-bearing are not left to a caller to remember.
 */
export const CONSEQUENCE = {
  variable:
    'Any UI policy that names this variable in a condition or an action will keep the reference and silently stop matching.',
  policy:
    'This removes the Fluent source and reinstalls the application, so it takes about a minute.',
  item: 'Its variables, choices and UI policies go with it.',
  setLink:
    'Only the link to this item is removed. The variable set and its variables stay, and other items using the set keep it.',
  choice:
    'A UI policy condition comparing against this value can never be true again.',
  guide: 'The guide is removed; the catalog items it referenced are not.',
  producer: 'The producer and its variables are removed; records it already created are not.',
  flow:
    'Its Fluent source is removed and the application reinstalled, which deletes the record on the instance.',
  incident: 'This cannot be undone.',
  sla: 'Clocks already running on existing records are not removed by this.',
  /*
   * This used to read "Its audit trail does too", which was accurate and was
   * describing a BUG: tool_events and sysid_provenance cascaded from sessions,
   * so deleting a chat erased the record of what it did to a live instance.
   * Migration 14 split them. The copy has to move with the behaviour, or the
   * dialog is confidently wrong at the moment someone is deciding.
   */
  session:
    'The transcript goes with it. The audit trail does NOT — what this session actually changed on the '
    + 'instance stays on the Audit page.',
  allSessions:
    'Every conversation and its search index are removed. The audit trail is NOT touched: the mutation '
    + 'ledger, tool events and sys_id provenance survive, so what was changed on your ServiceNow instances '
    + 'remains on the Audit page. Instance settings and the knowledge ledger are untouched too.',
  connection:
    'The stored username and password are cleared, and everything this app stored for the instance is permanently '
    + 'deleted: health scores, metrics, findings and settings, chat history and the audit trail. The next login builds '
    + 'new scores. Nothing on the ServiceNow instance itself is changed.',
};
