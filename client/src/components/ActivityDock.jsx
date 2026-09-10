import { useEffect, useMemo, useRef } from 'react';
import ActivityPanel from './ActivityPanel.jsx';
import { captureReason } from './writeOutcome.js';
import { ACTIVITY_STATUS, STATUS_LABEL, AGENT_STATUS } from './activity.js';

/*
 * ACTIVITY, OUT OF THE TRANSCRIPT.
 *
 * This replaces the stage card that used to sit between the messages and the
 * composer. That card competed with the conversation for vertical space and
 * announced "Task started" as though it were a message, which it is not.
 *
 * What is here instead is two views of the SAME existing state:
 *
 *   collapsed — a compact indicator beside the composer. One glyph, one word,
 *               one count. It is the only place the agent's status is shown
 *               now; the composer no longer prints it too.
 *   expanded  — the existing ActivityPanel, unchanged, in a drawer down the
 *               right of the playground.
 *
 * No data is invented. `rows` are the frames the backend emitted, `status` is
 * the same deriveStatus() vocabulary the header used, and the panel is the
 * same component with the same props it has always had.
 */

const Icon = {
  /* Concentric pulse — reads as "something is happening" at 14px, which a
     spinner glyph does not once it stops spinning. */
  activity: (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h3.5l2-6 4 12 2.5-6H21" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
};

/**
 * The compact indicator. Sits to the right of the composer, never inside the
 * transcript, and is the single representation of "what is the agent doing".
 */
export function ActivityIndicator({
  rows = [], running = false, status = AGENT_STATUS.IDLE, open = false, onToggle,
}) {
  const label = STATUS_LABEL[status] ?? STATUS_LABEL[AGENT_STATUS.IDLE];
  const liveRow = useMemo(
    () => [...rows].reverse().find((r) => r.status === ACTIVITY_STATUS.RUNNING) ?? null,
    [rows],
  );

  return (
    <button
      type="button"
      className={`act-dot ag-${label.tone}${label.spin ? ' is-live' : ''}${open ? ' is-open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? 'Hide activity' : 'Show activity'}
      /* The running row's real title, on hover — the detail the old card put
         on screen permanently. */
      title={liveRow ? `${label.text} — ${liveRow.title}` : label.text}
    >
      <span className="act-dot-icon" aria-hidden="true">{Icon.activity}</span>
      <span className="act-dot-text">
        <span className="act-dot-label">Activity</span>
        <span className="act-dot-state">{label.text}</span>
      </span>
      {rows.length > 0 && <span className="act-dot-count">{rows.length}</span>}
      <span className={`act-dot-chevron${open ? ' is-open' : ''}`} aria-hidden="true">{Icon.chevron}</span>
    </button>
  );
}

/**
 * The drawer. A SIBLING of the transcript rather than an overlay on it, so the
 * messages narrow to make room instead of being covered — the panel gets its
 * own column and nothing is ever hidden behind it.
 *
 * It stays mounted at width 0 when closed. Animating a width the browser can
 * interpolate is what makes the open and close a single smooth movement rather
 * than a pop, and keeping the subtree mounted means the panel does not rebuild
 * its list every time it is opened.
 */
export function ActivityDrawer({
  open, rows = [], taskId = null, running = false, progress = null, skills = [],
  /* The latest capture message, straight from AgentChat's own messages. */
  updateSet = null,
  onOpenEvidence = null, onClose,
}) {
  /* Derived from the rows, not stored: the same array the panel renders. */
  const counts = useMemo(() => rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {}), [rows]);

  /*
   * FOLLOW THE TAIL, WITHOUT FIGHTING THE READER.
   *
   * New events scroll into view only when you are already near the bottom —
   * scroll up to inspect an earlier tool call and it leaves you there until you
   * come back down. The body is the ONE scroller: ActivityPanel's own list no
   * longer scrolls inside it (see .ax-list in experience.css), so there is a
   * single place for this to act on and no nested scrollbars to fight.
   */
  const bodyRef = useRef(null);
  const nearBottomRef = useRef(true);
  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows.length, open, progress]);

  return (
    <aside
      className={`act-drawer${open ? ' is-open' : ''}`}
      aria-hidden={!open}
      aria-label="Agent activity"
    >
      <div className="act-drawer-inner" inert={open ? undefined : ''}>
        {/*
          * THE ONE HEADER. ActivityPanel below renders with showHeader={false},
          * because it used to print a second "Activity" with the same counts
          * directly under this one.
          *
          * Every number is derived from the rows the backend actually emitted —
          * nothing here is a constant, and a count that is zero is simply not
          * shown rather than printed as "0 running".
          */}
        <header className="act-drawer-head">
          <span className="act-drawer-title">Activity</span>
          <span className="act-drawer-counts">
            {rows.length} event{rows.length === 1 ? '' : 's'}
            {counts.completed ? <> · <span className="ax-ok">{counts.completed} done</span></> : null}
            {counts.running ? <> · <span className="ax-run">{counts.running} running</span></> : null}
            {counts.failed ? <> · <span className="ax-bad">{counts.failed} failed</span></> : null}
            {counts.blocked ? <> · <span className="ax-warn">{counts.blocked} blocked</span></> : null}
            {skills.length > 0 ? <> · {skills.length} skill{skills.length === 1 ? '' : 's'}</> : null}
          </span>
          <button type="button" className="act-drawer-close" onClick={onClose} aria-label="Close activity">
            {Icon.close}
          </button>
        </header>

        <div className="act-drawer-body" ref={bodyRef} onScroll={onBodyScroll}>
          {/*
            * The existing panel, with the props it has always taken. Every
            * event, the bounded window, the expandable detail and the Evidence
            * button come from it unchanged.
            */}
          <ActivityPanel
            showHeader={false}
            rows={rows}
            taskId={taskId}
            running={running}
            progress={progress}
            skills={skills}
            onOpenEvidence={onOpenEvidence}
          />
          {/* ActivityPanel returns null when there is genuinely nothing — say
              so rather than leaving an empty drawer that implies work. */}
          {!rows.length && !progress && (
            <p className="act-drawer-empty">No activity yet. This fills in while a turn runs.</p>
          )}
        </div>

        {/*
          * UPDATE SET — the foot of the panel, roughly a tenth of its height.
          *
          * Only the LATEST report: a capture verdict supersedes the one before
          * it, so a running list would be a history of the same question asked
          * repeatedly. The badge states the verdict and captureReason() states
          * only the reason, which is the same split the bubble used — the text
          * is unchanged, only where it is drawn.
          */}
        <section className="act-updateset" aria-label="Update set">
          <div className="act-updateset-head">Update Set</div>
          {updateSet ? (
            <div className="act-updateset-body">
              <span className={`badge ${updateSet.failures?.length ? 'red' : updateSet.captured ? 'green' : ''}`}>
                {updateSet.failures?.length ? 'capture failed' : updateSet.captured ? 'captured' : 'not captured'}
              </span>
              <span className="act-updateset-reason" title={captureReason(updateSet)}>
                {captureReason(updateSet)}
              </span>
            </div>
          ) : (
            <p className="act-updateset-empty">No update-set changes</p>
          )}
        </section>
      </div>
    </aside>
  );
}
