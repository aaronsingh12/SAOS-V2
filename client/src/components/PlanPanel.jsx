import { memo, useState } from 'react';
import { STATUS_MARK } from './activity.js';

/**
 * THE PLAN, AS A FIRST-CLASS PANEL (§16–§19).
 *
 * ═══ WHERE THE DATA COMES FROM, AND WHY NOT THE OBVIOUS PLACE ═══
 *
 * The obvious source is `GET /api/agent/plan/:taskId`, which returns the plan
 * and its steps. It is not used here, and the reason is §59: that route returns
 * the durable step ROWS, `inputs_json` included, exactly as the executor stored
 * them — unredacted, because its consumers were server-side and it predates
 * this layer.
 *
 * §59 lists the plan as one of the surfaces a credential must never reach, and
 * §18 asks for the canonical arguments to be shown. Both hold at once only if
 * the arguments are redacted BEFORE they leave the server. The activity
 * projection does exactly that — every `metadata` object passes through the
 * existing redactor on its way out — so this panel is built from the activity's
 * step events instead. No second redactor, no new leak, and the older route is
 * left with the contract its existing callers expect.
 *
 * §17 — COMPACT BY DEFAULT. The collapsed form is one line of counts; a step
 * opens on click. Showing every tool argument by default would bury the shape
 * of the plan under its payloads, which is the thing a person is reading the
 * plan to see.
 */

const stateOf = (e) => e.status;

function PlanPanel({ steps = [], progress = null, dataflow = [] }) {
  const [open, setOpen] = useState(false);
  const [openStep, setOpenStep] = useState(null);

  if (!steps.length) return null;

  const done = steps.filter((s) => stateOf(s) === 'completed').length;
  const running = steps.filter((s) => stateOf(s) === 'running').length;
  const queued = steps.filter((s) => stateOf(s) === 'queued').length;
  const failed = steps.filter((s) => stateOf(s) === 'failed').length;
  const deps = steps.reduce((n, s) => n + (s.metadata?.depends_on?.length ?? 0), 0);

  return (
    <section className="pl" aria-label="Plan">
      <button
        type="button"
        className="pl-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pl-title">Plan</span>
        <span className="pl-sum">
          {steps.length} step{steps.length === 1 ? '' : 's'}
          {' · '}{done} completed
          {running ? ` · ${running} running` : ''}
          {queued ? ` · ${queued} queued` : ''}
          {failed ? <> · <span className="pl-bad">{failed} failed</span></> : null}
          {deps ? ` · ${deps} dependenc${deps === 1 ? 'y' : 'ies'}` : ''}
        </span>
        <span className="pl-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <ol className="pl-steps">
          {steps.map((s, i) => {
            const m = s.metadata ?? {};
            const isOpen = openStep === s.id;
            return (
              <li key={s.id} className={`pl-step pl-${stateOf(s)}`}>
                <button
                  type="button"
                  className="pl-step-btn"
                  aria-expanded={isOpen}
                  onClick={() => setOpenStep(isOpen ? null : s.id)}
                >
                  <span className="pl-mark" aria-hidden="true">{STATUS_MARK[stateOf(s)] ?? '·'}</span>
                  <span className="pl-n">{m.sequence ?? i + 1}.</span>
                  <span className="pl-what">{s.title}</span>
                  {m.mutating && <span className="pl-mut" title="This step writes to the instance">writes</span>}
                </button>

                {isOpen && (
                  <div className="pl-detail">
                    {/* §18 — operation, mechanism, target, inputs, dependencies, verification. */}
                    <dl className="pl-dl">
                      {m.operation && (<><dt>Operation</dt><dd className="mono">{m.operation}</dd></>)}
                      {m.tool && (<><dt>Tool</dt><dd className="mono">{m.tool}</dd></>)}
                      {m.mechanism && (<><dt>Mechanism</dt><dd className="mono">{m.mechanism}</dd></>)}
                      {m.scope && (<><dt>Scope</dt><dd className="mono">{m.scope}</dd></>)}
                      {m.depends_on?.length > 0 && (
                        <><dt>Depends on</dt><dd className="mono">{m.depends_on.join(', ')}</dd></>
                      )}
                    </dl>

                    {m.inputs && (
                      <div className="pl-block">
                        <div className="pl-block-head">Inputs</div>
                        {/*
                          * The CANONICAL arguments — what the executor was
                          * given, not what the model first proposed (§18) —
                          * redacted server-side (§59).
                          */}
                        <pre className="pl-pre">{JSON.stringify(m.inputs, null, 1)}</pre>
                      </div>
                    )}

                    {m.effects && (
                      <div className="pl-block">
                        <div className="pl-block-head">Expected effect</div>
                        <pre className="pl-pre">{JSON.stringify(m.effects, null, 1)}</pre>
                      </div>
                    )}

                    {/*
                      * §27/§79.3 — the VERDICT, verbatim. When there is none,
                      * this section is absent rather than saying "pending" —
                      * which would be a claim about a verification that has not
                      * been attempted.
                      */}
                    {m.verification && (
                      <div className="pl-block">
                        <div className="pl-block-head">Verification</div>
                        <pre className="pl-pre">{JSON.stringify(m.verification, null, 1)}</pre>
                      </div>
                    )}

                    {s.summary && <div className="pl-why">{s.summary}</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/*
       * §19 — DATAFLOW. What a `$ref` was, and what the resolver made it.
       *
       * Shown only for references that ACTUALLY RESOLVED, because the resolved
       * value is the interesting half and an unresolved row would be a promise
       * about a step that has not run. This is the existing resolver's own
       * record; nothing here resolves anything.
       */}
      {open && dataflow.length > 0 && (
        <div className="pl-flow">
          <div className="pl-block-head">Dataflow</div>
          {dataflow.map((d) => (
            <div key={d.id} className="pl-ref">
              <span className="mono pl-ref-from">{d.summary}</span>
              <span className="pl-arrow" aria-hidden="true">→</span>
              <span className="mono pl-ref-to">{d.metadata?.resolved ?? 'resolved'}</span>
            </div>
          ))}
        </div>
      )}

      {progress && progress.total !== steps.length && (
        <div className="pl-note">
          The server counts {progress.total} step{progress.total === 1 ? '' : 's'} for this task.
        </div>
      )}
    </section>
  );
}

/*
 * §56 — memoised for the same reason ActivityPanel is: the plan changes far
 * less often than the conversation around it, and re-rendering a twelve-step
 * plan on every assistant token is work nobody asked for.
 */
export default memo(PlanPanel);
