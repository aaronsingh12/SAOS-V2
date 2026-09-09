/**
 * PHASE 17 — NOWTEST, on screen.
 *
 * §38 gives the order and §39 gives the wording, and both exist for the same
 * reason: a test result is read in about four seconds, and those four seconds
 * decide what someone does next. So the sections run SETUP → EXECUTION →
 * ASSERTIONS → CLEANUP → VERDICT, with the verdict last, because the word
 * "PASS" means nothing until a reader has seen what was set up and what
 * actually ran. Leading with the verdict would let a person act on a green
 * badge without ever learning that only two of five promised effects were
 * checked.
 *
 * THIS COMPONENT DECIDES NOTHING. `status`, `statement`, every assertion's
 * `status`, the cleanup status and the failure classifications all arrive
 * computed by `result.js` and are rendered verbatim. This is the same rule
 * LintPanel keeps, for the same reason: a client that re-derived a verdict
 * could disagree with the arithmetic that actually read the instance, and the
 * version a person reads would be the one that was wrong.
 *
 * IT DELIBERATELY MIRRORS `server/src/agent/test/render.js`, section for
 * section and sentence for sentence. The markdown transcript and this panel are
 * two presentations of ONE result; if they drift, a reader can be told two
 * different things about the same run, which is worse than having only one of
 * them. When render.js changes, this changes with it.
 *
 * THE INCONCLUSIVE SENTENCE IS THE POINT OF THE FILE. §39 makes it mandatory,
 * and the way it is kept here is structural rather than editorial: it is
 * rendered from `status`, so it cannot be lost by a statement that happened not
 * to contain it. FAIL is the mirror image — it establishes that an effect is
 * missing and says, in as many words, that it does not establish why. The
 * Doctor handoff sits UNDER that sentence rather than in place of it, because
 * an investigation is a next step and not an answer.
 *
 * Reuses the existing `ev-*` block/section furniture so this sits inside the
 * current visual language rather than introducing a second one.
 */

/* The three assertion outcomes and the five results. Named here because the
 * client cannot import from `server/`; they are COMPARED, never computed. */
const PASS = 'PASS';
const FAIL = 'FAIL';
const UNAVAILABLE = 'UNAVAILABLE';

const RESULTS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
};

/**
 * The verdict's colour, and what each colour is allowed to mean.
 *
 * INCONCLUSIVE is deliberately NOT red. It is not a failure — it is the honest
 * third answer §4 exists to make sayable — so it gets the quiet dashed
 * treatment `.dx-unknown` already uses for a gap in the evidence. Painting it
 * as an error would teach people to read "I could not establish this" as "this
 * is broken", which is the exact confusion this phase was built to remove.
 */
const VERDICT_CLASS = {
  [RESULTS.PASS]: 'nowtest-verdict-pass',
  [RESULTS.FAIL]: 'nowtest-verdict-fail',
  [RESULTS.INCONCLUSIVE]: 'nowtest-verdict-inconclusive',
  [RESULTS.BLOCKED]: 'nowtest-verdict-blocked',
  [RESULTS.CANCELLED]: 'nowtest-verdict-cancelled',
};

const MARK = { pass: '✓', fail: '✗', none: '–' };

/**
 * Execution states in English.
 *
 * A transliteration of `readable()` in `result.js`, and display-only: an
 * unrecognised state falls through to the raw token exactly as the server's
 * version does, so a state this build has not been taught about is shown as
 * itself rather than guessed at.
 */
const READABLE = {
  EXECUTION_WAITING: 'waiting',
  EXECUTION_RUNNING: 'still running',
  EXECUTION_PAUSED: 'paused',
  EXECUTION_COMPLETE: 'complete',
  EXECUTION_ERROR: 'in error',
  EXECUTION_CANCELLED: 'cancelled',
  EXECUTION_INTERRUPTED: 'interrupted',
  EXECUTION_UNKNOWN: 'in a state this build does not recognise',
  NO_EXECUTION_FOUND: 'absent',
};
const readable = (state) => READABLE[state] ?? String(state ?? 'unknown');

const secs = (ms) => Math.round((ms ?? 0) / 1000);

/** One claim, with the glyph that says how it went. */
function Line({ tone = 'none', children }) {
  return (
    <div className="nowtest-line">
      <span className={`nowtest-mark nowtest-${tone}`} aria-hidden="true">{MARK[tone]}</span>
      <span className="nowtest-text">{children}</span>
    </div>
  );
}

/** A sub-line hanging off the claim above it — never a claim of its own. */
const Detail = ({ children }) => <div className="nowtest-detail">{children}</div>;

/**
 * §36 — cleanup is a section, never a footnote.
 *
 * The wording is `cleanupLine()` from render.js verbatim. A run that left a
 * record on the instance says so in the same words in both places, because the
 * two are the same finding and a reader who compares them must not find a
 * difference to interpret.
 */
function CleanupLine({ cleanup }) {
  if (!cleanup) return <Line tone="none">Cleanup was not recorded.</Line>;
  switch (cleanup.status) {
    case 'NOT_NEEDED':
      return <Line tone="none">Nothing was created, so nothing needed removing.</Line>;
    case 'PASS':
      return (
        <Line tone="pass">
          {cleanup.records_deleted} of {cleanup.records_created} test record(s) deleted and verified gone.
        </Line>
      );
    case 'REFUSED':
      return <Line tone="fail">Cleanup was not authorised. {cleanup.note}</Line>;
    case 'FAILED':
      return <Line tone="fail">Cleanup failed. {cleanup.note}</Line>;
    default:
      return <Line tone="fail">Cleanup outcome unknown. {cleanup.note ?? ''}</Line>;
  }
}

/**
 * The verdict block: the word, the server's statement, the §39 sentence the
 * word alone cannot carry, and the failure classes.
 *
 * §42 — "TEST FAILED" is not an acceptable answer, so the classes are shown.
 * The next action after FIXTURE_SETUP_FAILED and after EXPECTED_EFFECT_MISSING
 * are entirely different jobs, and only the second is evidence about the flow.
 */
function Verdict({ result, onInvestigate }) {
  return (
    <div className="ev-block">
      <span className={`nowtest-verdict ${VERDICT_CLASS[result.status] ?? ''}`}>{result.status}</span>
      {result.statement && <p className="nowtest-statement">{result.statement}</p>}

      {/* §39 — mandatory, and rendered from the status rather than from prose,
          so it cannot be lost by a statement that happened not to include it. */}
      {result.status === RESULTS.INCONCLUSIVE && (
        <p className="nowtest-claim">
          No claim is made about whether the expected effect would eventually occur.
        </p>
      )}
      {result.status === RESULTS.FAIL && (
        <p className="nowtest-claim">
          This establishes that an expected effect is missing. It does not establish why.
        </p>
      )}

      {result.failures?.length > 0 && (
        <p className="nowtest-tags">
          <span className="nowtest-tags-label">Classified as</span>
          {result.failures.map((f) => <span className="nowtest-tag" key={f}>{f}</span>)}
        </p>
      )}

      {/* §40 — OFFERED, never launched. Starting an investigation automatically
          would blur the very line the sentence above draws, as well as spending
          a model call nobody asked for. The request is shown so the person
          clicking can see what they are about to ask. */}
      {result.doctor?.available && (
        <div className="nowtest-doctor">
          <button
            type="button"
            className="btn sm"
            onClick={() => onInvestigate?.(result.doctor.request)}
          >
            Investigate with Doctor
          </button>
          <span className="nowtest-doctor-note">{result.doctor.request}</span>
        </div>
      )}
    </div>
  );
}

export default function TestPanel({ test, onInvestigate }) {
  if (!test) return null;
  const name = test.flow?.name ?? test.artifact?.name ?? null;

  const header = (
    <div className="ev-block">
      <div className="ev-section">NowTest{name ? ` — ${name}` : ''}</div>
    </div>
  );

  /*
   * A run that never started says so and stops.
   *
   * There is no setup, execution or assertion section here because there was no
   * setup, execution or assertion — and four empty sections would read as
   * "everything was checked and nothing was found", which is the opposite of
   * what happened.
   */
  if (test.status === RESULTS.BLOCKED && test.stopped) {
    return (
      <div className="nowtest">
        {header}
        <div className="ev-block">
          <div className="ev-section">Not run</div>
          <p className="nowtest-statement">
            {test.stopped.note ?? test.statement ?? 'The test did not run.'}
          </p>
          {/* §6 — an ambiguous name stops rather than guessing, so the
              candidates are the answer and not a consolation. */}
          {test.stopped.candidates?.length > 0 && (
            <>
              <div className="nowtest-detail">Candidates:</div>
              <ul className="ev-list">
                {test.stopped.candidates.slice(0, 10).map((c) => (
                  <li key={c.sys_id}>
                    {c.name} <span className="nowtest-id">{c.sys_id}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {test.stopped.unsupported?.length > 0 && (
            <ul className="ev-list">
              {test.stopped.unsupported.map((u) => (
                <li key={u.term}>
                  <span className="nowtest-id">{u.term}</span> {u.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Verdict result={test} onInvestigate={onInvestigate} />
        <div className="ev-block">
          <div className="ev-section">Cleanup</div>
          <CleanupLine cleanup={test.cleanup} />
        </div>
      </div>
    );
  }

  const f = test.fixture;
  const written = Object.entries(f?.data ?? {}).filter(([k]) => k !== f?.marker_field);
  const derived = test.contract?.trigger?.derived ?? [];
  const e = test.execution;
  const head = e?.executions?.[0] ?? null;
  const executionOk = Boolean(e?.settled) && head?.state === 'EXECUTION_COMPLETE';
  const lintFindings = test.lint?.findings ?? [];

  return (
    <div className="nowtest">
      {header}

      {/* ---- setup ---- */}
      <div className="ev-block">
        <div className="ev-section">Test setup</div>
        {f?.created ? (
          <>
            <Line tone="pass">
              Created a disposable {f.table} <span className="nowtest-id">{f.sys_id}</span>
            </Line>
            {f.marker && (
              <Detail>marked <span className="nowtest-id">{f.marker}</span> in {f.marker_field}</Detail>
            )}
            {written.length > 0 && (
              <Detail>set {written.map(([k, v]) => `${k}=${v}`).join(', ')} to satisfy the trigger</Detail>
            )}
            {/* §15 — a field the platform COMPUTES was not written, and saying
                so is the difference between a fixture a person can reproduce
                and one they would build wrong by hand. */}
            {derived.map((d) => (
              <Detail key={d.field}>
                {d.field} was driven from {d.from.join(' + ')} rather than written — the platform computes it
              </Detail>
            ))}
          </>
        ) : (
          <Line tone="fail">No test record was created{f?.error ? `: ${f.error}` : ''}</Line>
        )}

        {/* §45/§56 — the record was created and STILL did not match the
            trigger. Without this line the assertions below would be measuring a
            flow that was never asked to run, and nothing on screen would say
            so. */}
        {test.trigger_check && !test.trigger_check.satisfied && (
          <div className="nowtest-group">
            {(test.trigger_check.failed ?? []).map((c) => (
              <Line tone="fail" key={c.field}>
                {c.field} read back as &quot;{c.actual}&quot;, but the trigger needs &quot;{c.expected}&quot;
              </Line>
            ))}
          </div>
        )}
      </div>

      {/* ---- execution ---- */}
      <div className="ev-block">
        <div className="ev-section">Execution</div>
        {!e && <Line tone="none">The execution history was not read.</Line>}
        {e && !e.found && (
          <Line tone="fail">No execution of this flow was recorded within {secs(e.waited_ms)}s</Line>
        )}
        {e && e.found && (
          <>
            <Line tone="pass">Flow triggered</Line>
            <Line tone={executionOk ? 'pass' : 'fail'}>
              Execution {readable(head?.state ?? e.state)}
              {e.waited_ms ? ` after ${(e.waited_ms / 1000).toFixed(1)}s` : ''}
            </Line>
            {head?.error && <Detail>{head.error}</Detail>}
            {head?.sys_id && (
              <Detail>execution <span className="nowtest-id">{head.sys_id}</span></Detail>
            )}
            {/* §26 — other executions against the same record are reported and
                EXCLUDED, rather than silently folded into the one being judged. */}
            {e.other_executions > 0 && (
              <Detail>
                {e.other_executions} other execution(s) ran against this record and are not counted here
              </Detail>
            )}
          </>
        )}
      </div>

      {/* ---- assertions ---- */}
      <div className="ev-block">
        <div className="ev-section">Assertions</div>
        {!test.assertions?.length ? (
          <Line tone="none">
            Nothing about this flow could be checked by reading the record it was triggered by.
          </Line>
        ) : (
          test.assertions.map((a) => (
            <div className="nowtest-assertion" key={a.id}>
              <Line tone={a.status === PASS ? 'pass' : a.status === FAIL ? 'fail' : 'none'}>
                {a.description}
              </Line>
              {a.status === FAIL && (
                <>
                  <Detail>
                    expected{' '}
                    {a.expected === null
                      ? 'a change'
                      : <span className="nowtest-id">{String(a.expected)}</span>}
                  </Detail>
                  <Detail>
                    observed{' '}
                    {a.actual === '' || a.actual === null || a.actual === undefined
                      ? '(empty)'
                      : <span className="nowtest-id">{String(a.actual)}</span>}
                    {a.actual_display ? ` (${a.actual_display})` : ''}
                  </Detail>
                </>
              )}
              {/* §13/§46 — UNAVAILABLE is not a failure, and its reason is the
                  whole of its content: "there was no evidence" and "the value
                  was wrong" are different findings and must never be rendered
                  alike. */}
              {a.status === UNAVAILABLE && (
                <Detail>{a.note ?? 'no evidence was available to decide this'}</Detail>
              )}
              {a.status !== FAIL && a.status !== UNAVAILABLE && a.note && <Detail>{a.note}</Detail>}
              {/* §43 — WHICH READ DECIDED THIS. An assertion whose evidence
                  cannot be traced back to a named step is one nobody can repeat
                  by hand, and this line is what makes repeating it possible. */}
              {a.source && (
                <Detail>
                  <span className="nowtest-source">
                    read by {a.source.step} ({a.source.tool})
                  </span>
                  {a.source.table && (
                    <span className="nowtest-source">
                      {a.source.table}{a.source.sys_id ? ` ${a.source.sys_id}` : ''}
                    </span>
                  )}
                </Detail>
              )}
            </div>
          ))
        )}
      </div>

      {/* ---- cleanup ---- */}
      <div className="ev-block">
        <div className="ev-section">Cleanup</div>
        <CleanupLine cleanup={test.cleanup} />
      </div>

      {/* ---- the verdict, last, because it is meaningless above the lines that
              earned it ---- */}
      <Verdict result={test} onInvestigate={onInvestigate} />

      {/* §28 — what the flow also did. Reported beside the verdict and never
          folded into it: a flow that stamps a field nobody asked about is
          behaving in a way somebody should see, and is not thereby failing. */}
      {test.unexpected_effects?.length > 0 && (
        <div className="ev-block">
          <div className="ev-section">Also changed (not part of what was tested)</div>
          <ul className="ev-list nowtest-limits">
            {test.unexpected_effects.map((u) => (
              <li key={u.field}>
                <span className="nowtest-source">{u.field}</span>
                {' '}
                &quot;
                {u.from || '(empty)'}
                &quot; → &quot;
                {u.to || '(empty)'}
                &quot;
                {u.display ? ` (${u.display})` : ''}
              </li>
            ))}
          </ul>
          <div className="nowtest-note">These are reported as a risk. They did not decide the result.</div>
        </div>
      )}

      {/* §13 — what this run did NOT establish, beside what it did. A test that
          reports only its coverage looks complete; one that names its holes can
          be trusted with the parts it did check. */}
      {test.limitations?.length > 0 && (
        <div className="ev-block">
          <div className="ev-section">Not covered by this test</div>
          <ul className="ev-list nowtest-limits">
            {test.limitations.map((l, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}

      {/* §41 — lint findings sit BESIDE the test and never gate it. The two
          answer different questions, and the caveat says so rather than leaving
          a reader to assume a clean lint means a passing flow. */}
      {lintFindings.length > 0 && (
        <div className="ev-block">
          <div className="ev-section">NowLint also found</div>
          <ul className="ev-list">
            {lintFindings.slice(0, 5).map((finding) => (
              <li key={finding.id ?? finding.rule_id}>
                <span className="nowtest-source">{finding.rule_id}</span>
                {finding.title} ({finding.status})
              </li>
            ))}
          </ul>
          <p className="dx-caveat">
            Lint and runtime testing answer different questions; these did not gate the test.
          </p>
        </div>
      )}
    </div>
  );
}
