import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { STATUS_MARK, ACTIVITY_STATUS } from './activity.js';

/**
 * THE AGENT'S ACTIVITY, AS A LIST OF THINGS THAT HAPPENED.
 *
 * §5 asks the workspace to answer "what is it doing, what has it done, what is
 * it waiting for" without reading server logs, and §66 forbids answering with
 * anything that is not a real event. Every row below came from a frame the
 * backend emitted or a row it stored; there is no timer, no simulated progress
 * and no state this component advances on its own.
 *
 * §3 — NO PRIVATE REASONING. The titles are operational: "query_records",
 * "Approval required", "Verification: verified". There is no place in this
 * component where model deliberation could be rendered, because none is sent.
 *
 * ═══ RECONNECT AND REFRESH (§10, §11, §58) ═══
 *
 * The live rows come from the stream; the durable ones come from
 * `GET /api/agent/plan/:taskId/activity`. When the durable projection arrives
 * it REPLACES the live list rather than merging into it, because the two number
 * their events from different places and a merge is where §11's duplicate would
 * be born. Replacement cannot duplicate: there is one list, and it comes from
 * one source at a time.
 *
 * §57 — the rendered list is BOUNDED. A long plan can emit hundreds of events,
 * and rendering all of them costs more than anyone reads. The bound is on what
 * is DRAWN, never on what is kept: the durable history is untouched, the count
 * of what is hidden is shown, and one click reveals it.
 */

const WINDOW = 60;

const TYPE_LABEL = {
  task: 'task',
  plan: 'plan',
  step: 'step',
  tool: 'tool',
  approval: 'approval',
  verification: 'verify',
  recovery: 'recovery',
};

function ActivityPanel({
  rows = [], taskId = null, running = false, progress = null, skills = [], onOpenEvidence = null,
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const listRef = useRef(null);

  /*
   * §56 — the derived list is memoised on the rows, so an unrelated re-render
   * of the conversation does not re-slice a few hundred events. The rows
   * themselves are replaced by identity in the parent, so this recomputes
   * exactly when the timeline actually changed.
   */
  const shown = useMemo(
    () => (expanded || rows.length <= WINDOW ? rows : rows.slice(rows.length - WINDOW)),
    [rows, expanded],
  );
  const hidden = rows.length - shown.length;

  /*
   * §55 — the live region announces the CURRENT action, not every event.
   * Announcing each row would make a screen reader read a hundred lines during
   * a long plan, which is the accessibility equivalent of the spinner §66 bans.
   */
  const current = useMemo(
    () => [...rows].reverse().find((r) => r.status === ACTIVITY_STATUS.RUNNING) ?? null,
    [rows],
  );

  useEffect(() => {
    /* Follow the tail only while the task is live and the user has not scrolled up. */
    const el = listRef.current;
    if (!el || !running) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [shown.length, running]);

  if (!rows.length && !progress) return null;

  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <section className="ax" aria-label="Agent activity">
      <header className="ax-head">
        <span className="ax-title">Activity</span>
        <span className="ax-counts">
          {rows.length} event{rows.length === 1 ? '' : 's'}
          {counts.completed ? <> · <span className="ax-ok">{counts.completed} done</span></> : null}
          {counts.running ? <> · <span className="ax-run">{counts.running} running</span></> : null}
          {counts.failed ? <> · <span className="ax-bad">{counts.failed} failed</span></> : null}
          {counts.blocked ? <> · <span className="ax-warn">{counts.blocked} blocked</span></> : null}
        </span>
        {/* §46 — the skills ACTIVE for this task, not every installed one. */}
        {skills.length > 0 && (
          <span className="ax-skills" title="The skills this task is running under">
            {skills.map((s) => <span key={s.identity} className="ax-skill">{s.name}</span>)}
          </span>
        )}
        {onOpenEvidence && taskId && (
          <button type="button" className="btn ghost sm" onClick={onOpenEvidence}>
            Evidence
          </button>
        )}
      </header>

      {/* §26 — plan progress, from the server's own counts. Never estimated. */}
      {progress && progress.total > 0 && (
        <div className="ax-progress">
          {progress.total} step{progress.total === 1 ? '' : 's'}
          {' · '}{progress.completed} completed
          {progress.running ? <> · {progress.running} running</> : null}
          {progress.queued ? <> · {progress.queued} queued</> : null}
          {progress.failed ? <> · <span className="ax-bad">{progress.failed} failed</span></> : null}
          {progress.awaiting_approval
            ? <> · <span className="ax-warn">{progress.awaiting_approval} awaiting approval</span></>
            : null}
        </div>
      )}

      <div className="ax-live" role="status" aria-live="polite">
        {running && current ? `${current.title}` : ''}
      </div>

      {hidden > 0 && (
        <button type="button" className="ax-more" onClick={() => setExpanded(true)}>
          {hidden} earlier event{hidden === 1 ? '' : 's'} not shown — show all
        </button>
      )}

      <ol className="ax-list" ref={listRef}>
        {shown.map((r) => {
          const open = detail === r.id;
          const hasDetail = Boolean(r.summary || r.metadata);
          return (
            <li key={r.id} className={`ax-row ax-${r.status}`}>
              <button
                type="button"
                className="ax-row-btn"
                aria-expanded={hasDetail ? open : undefined}
                disabled={!hasDetail}
                onClick={() => hasDetail && setDetail(open ? null : r.id)}
              >
                <span className="ax-mark" aria-hidden="true">{STATUS_MARK[r.status] ?? '·'}</span>
                <span className="ax-type">{TYPE_LABEL[r.type] ?? r.type}</span>
                <span className="ax-what">{r.title}</span>
                {/*
                  * §8 — a row the server matched by time window rather than by
                  * task id says so. "This task ran it" and "this task probably
                  * ran it" are different claims and must not render the same.
                  */}
                {r.metadata?.exact === false && (
                  <span className="ax-inexact" title="Matched by this task's time window, not by its id.">
                    correlated
                  </span>
                )}
                <span className="ax-status">{r.status}</span>
              </button>
              {open && (
                <div className="ax-detail">
                  {r.summary && <div className="ax-summary">{r.summary}</div>}
                  {/*
                    * §18 — the CANONICAL arguments, redacted server-side before
                    * they were ever sent (§59). The client does no redaction of
                    * its own: a second redactor is a second thing to fall
                    * behind the key list.
                    */}
                  {r.metadata && (
                    <pre className="ax-meta">{JSON.stringify(r.metadata, null, 1)}</pre>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/*
 * §56 — MEMOISED, because this re-renders on every tool event and the
 * conversation beside it must not.
 *
 * The parent holds one array of rows and replaces it by identity, so the
 * default shallow comparison is exactly the right one: a new `rows` reference
 * means the timeline changed, and anything else — a message arriving, a badge
 * updating — leaves this untouched.
 */
export default memo(ActivityPanel);

/**
 * Fetch the durable timeline for a task (§10, §51, §58).
 *
 * READ-ONLY, and that is the §52 guarantee: mounting this cannot re-execute
 * anything, because the only thing it can do is GET a projection.
 */
export function useDurableActivity(taskId, { enabled = true } = {}) {
  const [state, setState] = useState({ loading: false, error: null, activity: null });

  useEffect(() => {
    if (!taskId || !enabled) { setState({ loading: false, error: null, activity: null }); return undefined; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get(`/agent/plan/${taskId}/activity`)
      .then((activity) => { if (alive) setState({ loading: false, error: null, activity }); })
      .catch((err) => { if (alive) setState({ loading: false, error: err.message, activity: null }); });
    return () => { alive = false; };
  }, [taskId, enabled]);

  return state;
}
