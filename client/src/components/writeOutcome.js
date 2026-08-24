/**
 * WI-6 — one place that decides how a write is shown.
 *
 * THE DEFECT. The transcript rendered, literally:
 *
 *     ✅ Update set "AGAMYA_Scope" … was not updated
 *
 * a success glyph welded onto a sentence saying the opposite. It happened
 * because the glyph came from "the tool did not throw" while the words came
 * from somewhere else entirely, and nothing tied the two together.
 *
 * So both now come from ONE object: the WI-1 verification attached to the tool
 * result. A tool that returned 2xx while the platform discarded the write has
 * `status: 'no-op'`, and there is no path through this function that pairs that
 * status with a success mark. The rule is not "remember not to do that" — it is
 * that the glyph and the label are computed together from the same field.
 *
 * Plain JS, not JSX, so the offline suite can assert it — Node cannot import a
 * .jsx file. Same reason `instanceState.js` sits beside `states.jsx`.
 */

/** verification.status → how the card reads. Tokens are locked; only these three. */
const OUTCOMES = {
  applied: { tone: 'ok', label: 'done', badgeClass: '' },
  'self-verified': { tone: 'ok', label: 'done', badgeClass: '' },
  transformed: { tone: 'warn', label: 'stored, changed', badgeClass: 'amber' },
  partial: { tone: 'warn', label: 'partial', badgeClass: 'amber' },
  'no-op': { tone: 'bad', label: 'no-op', badgeClass: 'red' },
  unverified: { tone: 'warn', label: 'unverified', badgeClass: 'amber' },
};

const fields = (arr) => (arr || []).map((d) => d.field).filter(Boolean).join(', ');

/**
 * How one tool card should render.
 *
 * `m` is the transcript entry: `{ status, verification, mutating }`. Falls back
 * to the transport-level status when there is no verification — a read-only
 * tool, or a call that errored before reaching the instance.
 */
export function writeOutcome(m) {
  const v = m?.verification;

  // No verification: a read, or a call that failed outright. The old two-state
  // behaviour, which was never wrong for these.
  if (!v || !v.status) {
    if (m?.status === 'error') return { tone: 'bad', label: 'error', badgeClass: 'red', dotStyle: { background: 'var(--red)' }, detail: null, title: null };
    if (m?.status === 'running') return { tone: 'pending', label: 'running', badgeClass: '', dotStyle: {}, detail: null, title: null };
    return { tone: 'ok', label: m?.status || 'done', badgeClass: '', dotStyle: {}, detail: null, title: null };
  }

  const base = OUTCOMES[v.status] || OUTCOMES.unverified;
  const dotStyle = base.tone === 'bad'
    ? { background: 'var(--red)' }
    : base.tone === 'warn' ? { background: 'var(--amber)' } : {};

  let detail = null;
  if (v.status === 'no-op') {
    detail = `The platform discarded this write. ${fields(v.dropped) || 'Nothing'} unchanged — the record was not modified.`;
  } else if (v.status === 'partial') {
    detail = `The platform dropped ${fields(v.dropped)}. The other fields were stored.`;
  } else if (v.status === 'transformed') {
    const why = (v.transformed || []).find((t) => t.reason)?.reason;
    detail = `Stored, but ${fields(v.transformed)} differ from what was sent${why ? ` (${why})` : ''}.`;
  } else if (v.status === 'unverified' && v.unverifiable?.length) {
    detail = `Not verifiable by read-back: ${fields(v.unverifiable)}.`;
  }

  return { ...base, dotStyle, detail, title: v.summary || null };
}

/**
 * The capture line's REASON only.
 *
 * The badge already says "not captured"; the message used to start with the
 * same two words, so the row read "not captured / not captured — data, not
 * configuration". The verdict belongs to the badge and the reason to the text,
 * and neither should say the other's half.
 */
export function captureReason(m) {
  const msg = String(m?.message || '');
  return msg
    .replace(/^\s*(not captured|captured)\s*[—:-]\s*/i, '')
    .replace(/^\s*(not captured|captured)\s+/i, '')
    .trim() || msg;
}

/**
 * WI-4 — who authorised a mutation, and when.
 *
 * THE DEFECT this closes is one the card could not previously have shown.
 * Investigating 2026-08-24 came down to "the checkbox was off, so how did this
 * reach approved?" and the answer was unobtainable: approval state was a single
 * terminal string with no source and no timestamp. The card said "approved" and
 * could not say by whom.
 *
 * The card's badge now comes from the server's `approval_resolved` event rather
 * than from the click that preceded it, and this renders the rest of that same
 * event. Nothing here is inferred from the write having succeeded — that is the
 * inversion `writeOutcome` exists to prevent, applied to the other half of the
 * card.
 *
 * `unknown` renders as unknown. It is what every row written before the
 * provenance columns existed carries, and an approval nobody can be attributed
 * is a finding worth showing, not a gap worth smoothing.
 *
 * `m` is the approval transcript entry: `{ decided, source, at }`.
 */
export function approvalProvenance(m) {
  const at = m?.at ? ` · ${clockOf(m.at)}` : '';
  if (m?.decided) {
    if (m.source === 'user_click') return `You approved${at}`;
    if (m.source === 'auto_approve') return `Auto-approved — no human saw the gate${at}`;
    return `Approved, but the source was never recorded (${m?.source || 'unknown'})${at}`;
  }
  if (m?.source === 'timeout') return `Expired — nobody answered${at}`;
  if (m?.source === 'user_click') return `You rejected${at}`;
  return `Rejected (${m?.source || 'unknown'})${at}`;
}

/**
 * The browser's own clock, because the browser is where the reader is.
 *
 * The instant is stamped UTC by the server; the session renders local time.
 * That seven-hour gap has produced a whole class of trap in this project, so the
 * conversion happens exactly once, here, from the ISO instant.
 */
function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
