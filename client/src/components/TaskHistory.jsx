import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { STATUS_LABEL } from './activity.js';

/**
 * PAST TASKS (§51–§53).
 *
 * ═══ REOPENING A TASK RE-EXECUTES NOTHING (§52) ═══
 *
 * That is the property this component exists to keep, and it is kept by having
 * no way to break it: the only network call here is a GET, and the only call
 * `onOpen` leads to is another GET. There is no POST, no tool, no plan and no
 * approval reachable from this file — so "do not accidentally rerun tools
 * because the component mounted" is not a rule anyone has to remember.
 *
 * §51 — the rows come from `agent_tasks` through the existing task layer. No
 * second task database, and the status beside each row is the same derivation
 * the live header uses, so a completed task reads identically whether it is
 * being watched or reopened a week later.
 *
 * §53 — CONTINUATION. The actions offered start a NEW deliberate turn; they
 * never mutate the completed task. They are ordinary chat messages, which is
 * why they are handed back to the composer rather than sent: a continuation the
 * user did not read before it ran would be the agent deciding for them.
 */

const CONTINUATIONS = [
  { label: 'Investigate with Doctor', prompt: '/diagnose ' },
  { label: 'Review evidence', prompt: null },
];

export default function TaskHistory({ sessionId, currentTaskId = null, onOpen = null, onContinue = null }) {
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await api.get(`/agent/plan/history/${sessionId}`);
      setTasks(res.tasks);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="th-empty">History unavailable — {error}</div>;
  if (!tasks) return <div className="th-empty">Loading…</div>;
  if (!tasks.length) return <div className="th-empty">No tasks yet in this chat.</div>;

  return (
    <section className="th" aria-label="Past tasks">
      <header className="th-head">
        <span className="th-title">Tasks</span>
        <span className="th-count">{tasks.length}</span>
      </header>
      <ul className="th-list">
        {tasks.map((t) => {
          const label = STATUS_LABEL[t.status] ?? { text: t.status, tone: 'idle' };
          return (
            <li key={t.task_id} className={`th-item${t.task_id === currentTaskId ? ' th-current' : ''}`}>
              <button
                type="button"
                className="th-row"
                onClick={() => onOpen?.(t.task_id)}
                disabled={!onOpen}
                title={onOpen ? (t.goal || 'Untitled task') : 'Available once the running turn finishes'}
              >
                <span className={`th-dot th-${label.tone}`} aria-hidden="true">●</span>
                <span className="th-goal">{t.goal || 'Untitled task'}</span>
                <span className="th-state">{label.text}</span>
              </button>
              <div className="th-meta">
                <span className="mono">{new Date(t.created_at).toLocaleString()}</span>
                {t.progress?.total > 0 && (
                  <span>{t.progress.completed}/{t.progress.total} steps</span>
                )}
                {/* §44 — what this task ran under, from the task's own record. */}
                {t.skills?.length > 0 && (
                  <span title={t.skills.map((s) => s.identity).join(', ')}>
                    {t.skills.length} skill{t.skills.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              {t.failure_reason && <div className="th-fail">{t.failure_reason}</div>}
              {onContinue && t.status === 'FAILED' && (
                <div className="th-cont">
                  {CONTINUATIONS.filter((c) => c.prompt).map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      className="btn ghost sm"
                      onClick={() => onContinue(c.prompt)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
