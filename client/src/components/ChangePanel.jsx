/**
 * PHASE 18 — CHANGE INTELLIGENCE, on screen.
 *
 * §38 gives the order and §39 gives the shape of a single difference, and the
 * two are one argument: a comparison is read from the top, so what a reader
 * meets first has to be WHICH TWO STATES were compared. Leading with the diff —
 * which is what a diff viewer does — lets someone act on a list of changes
 * without ever learning that the "before" was a snapshot from three weeks ago,
 * or that half the artifact could not be read. So the sections run COMPARED →
 * PARTIAL → the counts → the changes themselves.
 *
 * THIS COMPONENT DECIDES NOTHING. `kind`, `risk`, `status`, every category,
 * every count and the overall risk arrive computed from `agent/change/` and are
 * rendered verbatim. It is the same rule LintPanel and TestPanel keep, for the
 * same reason: a client that re-derived a risk could disagree with the table
 * that actually read the two artifacts, and the version a person reads would be
 * the one that was wrong. There is no arithmetic anywhere below.
 *
 * IT DELIBERATELY MIRRORS `server/src/agent/change/render.js`, section for
 * section and sentence for sentence. The markdown transcript and this panel are
 * two presentations of ONE comparison; if they drift, a reader can be told two
 * different things about the same two states, which is worse than having only
 * one of them. When render.js changes, this changes with it.
 *
 * §39 IS THE POINT OF THE FILE, and it is a split rather than a style. A VALUE
 * change gets the `-`/`+` gutter, because two lines is the clearest thing in
 * the world for a field that used to say one thing and now says another. A
 * STRUCTURAL change — a step that moved, an action that appeared — gets a NAMED
 * line instead, because rendering a reorder as two lines of text is exactly how
 * a diff makes a shuffle look like a rewrite. They are different findings and
 * must never be rendered alike.
 *
 * NOTHING HERE DEPLOYS ANYTHING, and the last line of the panel says so
 * unconditionally (§32). The two buttons hand a STRING to the caller — an
 * ordinary planner goal, an ordinary NowTest request — and do nothing else;
 * both journeys then run through the gates they already had. A control that
 * quietly did the work itself would be a second, ungated path to a write.
 *
 * Reuses the existing `ev-*` block/section furniture so this sits inside the
 * current visual language rather than introducing a second one.
 */

/* The vocabularies, named here because the client cannot import from
 * `server/`. They are COMPARED against what arrived, never computed. */
const KINDS = {
  ADDED: 'ADDED',
  REMOVED: 'REMOVED',
  CHANGED: 'CHANGED',
  MOVED: 'MOVED',
  UNCHANGED: 'UNCHANGED',
};

const ELEMENTS = {
  HEADER: 'header',
  TRIGGER: 'trigger',
  CONDITION: 'condition',
  ACTION: 'action',
  BRANCH: 'branch',
  INPUT: 'input',
  OUTPUT: 'output',
  REFERENCE: 'reference',
  DEPENDENCY: 'dependency',
};

const RISK = {
  CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', UNKNOWN: 'UNKNOWN',
};

const STATUS = { CONFIRMED: 'CONFIRMED', LIKELY: 'LIKELY', POSSIBLE: 'POSSIBLE', UNKNOWN: 'UNKNOWN' };

/**
 * The grouping order, which is `GROUPS` in render.js and is not alphabetical.
 *
 * It runs from the most consequential thing a flow edit can do to the least:
 * WHEN it runs, then WHICH records, then WHAT it does, then the paperwork. A
 * reader who stops after the first group has still seen the changes most likely
 * to matter.
 */
const GROUPS = [
  [ELEMENTS.TRIGGER, 'Trigger'],
  [ELEMENTS.CONDITION, 'Conditions'],
  [ELEMENTS.ACTION, 'Actions'],
  [ELEMENTS.BRANCH, 'Branches'],
  [ELEMENTS.REFERENCE, 'References'],
  [ELEMENTS.INPUT, 'Inputs'],
  [ELEMENTS.OUTPUT, 'Outputs'],
  [ELEMENTS.DEPENDENCY, 'Dependencies'],
  [ELEMENTS.HEADER, 'Flow properties'],
];

const RISK_CLASS = {
  [RISK.CRITICAL]: 'change-risk-critical',
  [RISK.HIGH]: 'change-risk-high',
  [RISK.MEDIUM]: 'change-risk-medium',
  [RISK.LOW]: 'change-risk-low',
  [RISK.UNKNOWN]: 'change-risk-unknown',
};

/** An absence is one word, so an empty string and a null cannot be told apart
 *  by a reader who would draw a different conclusion from each. */
const fmt = (v) => (v === null || v === undefined || v === '' ? '(empty)' : String(v));

/** `steps[<uuid>].inputs.values` reads badly; the uuid is not what a person is
 *  looking at. A transliteration of `short()` in render.js — the step keeps a
 *  short identity so two steps stay distinguishable, and the rest of the path
 *  is left alone. */
const short = (path) => String(path).replace(/steps\[([0-9a-f-]{8})[0-9a-f-]*\]/i, 'step $1');

/** A sub-line hanging off the line above it — never a finding of its own. */
const Detail = ({ children }) => <div className="change-detail">{children}</div>;

/**
 * The risk chip, shown only above LOW.
 *
 * §24's table puts most edits at LOW, so a chip on every line would be noise
 * that trains people to stop reading chips. Its absence is not a claim that
 * nothing could go wrong — the Risk section below carries the assessment for
 * the comparison as a whole.
 */
function RiskChip({ risk }) {
  if (!risk || risk === RISK.LOW) return null;
  return <span className={`change-risk ${RISK_CLASS[risk] ?? ''}`}>{risk}</span>;
}

/**
 * §25 — a difference this build READ but whose effect it could not establish.
 *
 * Rendered from `status` rather than from prose, so it cannot be lost by a note
 * that happened not to mention it. "I saw this change and do not know what it
 * does" is a different answer from "this change is harmless", and the second is
 * the one a reader will assume if nothing says otherwise.
 */
function Uncertain({ status }) {
  if (status !== STATUS.UNKNOWN) return null;
  return <span className="change-uncertain">(effect not established)</span>;
}

/**
 * One difference — the whole of §39.
 *
 * A transliteration of `renderChange()` in render.js, including which branch
 * wins: MOVED first, then an ACTION that appeared or vanished, then everything
 * else as a value. The order matters, because an ADDED action is also a value
 * change on paper, and rendering it as `+ Update Record` under a uuid path
 * would bury the one fact worth reading.
 */
function Change({ x }) {
  if (x.kind === KINDS.MOVED) {
    return (
      <div className="change-entry">
        <div className="change-structural">
          <span className="change-kind">MOVED</span> {short(x.path)}
          <RiskChip risk={x.risk} />
          <Uncertain status={x.status} />
        </div>
        <Detail>{x.note ? x.note : `${fmt(x.before)} → ${fmt(x.after)}`}</Detail>
      </div>
    );
  }

  if (x.element === ELEMENTS.ACTION && (x.kind === KINDS.ADDED || x.kind === KINDS.REMOVED)) {
    return (
      <div className="change-entry">
        <div className="change-structural">
          <span className="change-kind">{x.kind} ACTION</span> {fmt(x.after ?? x.before)}
          <RiskChip risk={x.risk} />
          <Uncertain status={x.status} />
        </div>
        {x.detail?.order !== undefined && <Detail>at position {x.detail.order}</Detail>}
      </div>
    );
  }

  /* A value. The gutter is the finding: one line leaves, one line arrives, and
   * the colour says which without the reader parsing a word. */
  return (
    <div className="change-entry">
      <div className="change-path">
        {short(x.path)}
        <RiskChip risk={x.risk} />
        <Uncertain status={x.status} />
      </div>
      {x.before !== null && (
        <div className="change-line change-removed">
          <span className="change-gutter" aria-hidden="true">-</span>
          <span className="change-value">
            {fmt(x.before)}
            {x.before_display && x.before_display !== x.before && (
              <span className="change-display">({x.before_display})</span>
            )}
          </span>
        </div>
      )}
      {x.after !== null && (
        <div className="change-line change-added">
          <span className="change-gutter" aria-hidden="true">+</span>
          <span className="change-value">
            {fmt(x.after)}
            {x.after_display && x.after_display !== x.after && (
              <span className="change-display">({x.after_display})</span>
            )}
          </span>
        </div>
      )}
      {x.note && <Detail>{x.note}</Detail>}
      {/* The reason for the chip above, and only where there is a chip. A risk a
          person cannot argue with is a risk they cannot check. */}
      {x.why && x.risk && x.risk !== RISK.LOW && <Detail>{x.why}</Detail>}
    </div>
  );
}

/**
 * §32 — the one thing this never did, said in the same words every time.
 *
 * It renders on every path, including the ones that stopped, and it is not
 * conditional on anything: a sentence that appears only sometimes is one a
 * reader learns to stop looking for.
 */
function NotDeployed({ deployment, onPrepare }) {
  return (
    <div className="ev-block change-foot">
      <p className="change-deployed">No changes have been deployed.</p>
      {deployment?.available ? (
        <div className="change-handoff">
          <button type="button" className="btn sm" onClick={() => onPrepare?.(deployment.goal)}>
            Prepare Change
          </button>
          <span className="change-handoff-note">
            hands the goal below to the ordinary planner, which shows you what it will do and waits
            for your approval before anything runs.
          </span>
          <p className="change-goal">{deployment.goal}</p>
        </div>
      ) : (
        deployment?.note ? <p className="change-note">{deployment.note}</p> : null
      )}
    </div>
  );
}

/**
 * One side of the Compared table.
 *
 * `derived` is shown because a version this build WORKED OUT and a version the
 * platform stated are not the same evidence, and §4's whole argument is that a
 * baseline has to say where it came from.
 */
function StateRow({ label, state }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{state?.source ?? '—'}</td>
      <td>
        <span className="change-id">{state?.version?.id ?? '—'}</span>
        {state?.version?.derived ? <span className="change-derived">(derived)</span> : null}
      </td>
      <td><span className="change-id">{state?.sys_id ?? '—'}</span></td>
    </tr>
  );
}

export default function ChangePanel({ change, onPrepare, onRunTest }) {
  if (!change) return null;
  const c = change;
  const name = c.artifact?.name ?? null;

  const header = (
    <div className="ev-block">
      <div className="ev-section">Change Intelligence{name ? ` — ${name}` : ''}</div>
    </div>
  );

  /*
   * A run that never compared anything says why and stops.
   *
   * There is no Compared table, no counts and no Risk section here because
   * there were no two states — and empty sections would read as "both were read
   * and nothing differs", which is the opposite of what happened. §4 makes "no
   * trustworthy baseline exists" a required answer rather than an error.
   */
  if (c.stopped) {
    return (
      <div className="change">
        {header}
        <div className="ev-block">
          <div className="ev-section">No comparison</div>
          <p className="change-statement">{c.stopped.note ?? 'The comparison did not run.'}</p>
          {c.stopped.candidates?.length > 0 && (
            <>
              <div className="change-detail">Candidates:</div>
              <ul className="ev-list">
                {c.stopped.candidates.slice(0, 10).map((x) => (
                  <li key={x.sys_id}>
                    {x.name} <span className="change-id">{x.sys_id}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <NotDeployed deployment={null} />
      </div>
    );
  }

  const s = c.summary ?? {};
  /* §19/§26 — a display-only entry is carried WITH the changes and is not one,
   * so it is filtered out here exactly as `summarise` filters it out of the
   * totals. Two places must not disagree about what counts. */
  const real = (c.changes ?? []).filter((x) => !x.display_only && x.kind !== KINDS.UNCHANGED);
  const labels = (c.changes ?? []).filter((x) => x.display_only);
  const counts = [
    s.added ? `${s.added} addition${s.added === 1 ? '' : 's'}` : null,
    s.removed ? `${s.removed} removal${s.removed === 1 ? '' : 's'}` : null,
    s.changed ? `${s.changed} modification${s.changed === 1 ? '' : 's'}` : null,
    s.moved ? `${s.moved} move${s.moved === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(', ');
  const lintFindings = c.lint?.findings ?? [];
  const scope = c.lint?.scope ?? null;
  const evaluated = scope?.evaluated ?? [];
  const showImpact = Boolean(
    c.impact?.length || c.dependencies?.added?.length || c.dependencies?.removed?.length,
  );

  return (
    <div className="change">
      {header}

      {/* ---- the two states, named before anything is said about them ---- */}
      <div className="ev-block">
        <div className="ev-section">Compared</div>
        <table className="change-compared">
          <thead>
            <tr>
              <th aria-label="state" />
              <th>Source</th>
              <th>Version</th>
              <th>Read</th>
            </tr>
          </thead>
          <tbody>
            <StateRow label="Baseline" state={c.baseline} />
            <StateRow label="Current" state={c.current} />
          </tbody>
        </table>
      </div>

      {/* §41 — a partial comparison says so BEFORE its findings. A reader who
          stops at the first heading must not come away thinking they saw the
          whole picture. */}
      {c.complete === false && (
        <div className="ev-block change-partial">
          <div className="ev-section">PARTIAL</div>
          <p className="change-statement">
            Part of this artifact could not be read, so what follows is not a complete comparison.
          </p>
          {c.unreadable?.length > 0 && (
            <ul className="ev-list change-unreadable">
              {c.unreadable.map((u) => <li key={u}>{u}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* ---- the counts, verbatim (§26) ---- */}
      <div className="ev-block">
        {!s.total ? (
          <>
            <div className="ev-section">No semantic changes</div>
            <p className="change-statement">
              {c.complete
                ? `The two states are identical. ${s.unchanged ?? 0} element(s) were compared and every one matches.`
                : 'Nothing differs in the sections that could be read.'}
            </p>
            {s.display_only ? (
              <p className="change-note">
                {s.display_only} label(s) differ while the identity behind them does not. That is not
                a change to what the flow does.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="ev-section">{s.total} change{s.total === 1 ? '' : 's'}</div>
            <p className="change-statement">{counts}</p>
          </>
        )}
      </div>

      {/* ---- the changes, grouped by element (§39) ---- */}
      {GROUPS.map(([element, label]) => {
        const group = real.filter((x) => x.element === element);
        if (!group.length) return null;
        return (
          <div className="ev-block" key={element}>
            <div className="ev-section">{label}</div>
            {group.map((x, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <Change x={x} key={`${x.kind}:${x.path}:${i}`} />
            ))}
          </div>
        );
      })}

      {/* ---- §19 — shown, and never counted as a change ---- */}
      {labels.length > 0 && (
        <div className="ev-block">
          <div className="ev-section">Labels only</div>
          {labels.map((x, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div className="change-entry" key={`${x.path}:${i}`}>
              <div className="change-line change-cosmetic">
                <span className="change-gutter" aria-hidden="true">~</span>
                <span className="change-value">
                  {x.path}: &quot;{x.before_display ?? ''}&quot; → &quot;{x.after_display ?? ''}&quot;
                </span>
              </div>
              <Detail>
                the identity is unchanged (<span className="change-id">{x.after}</span>), so nothing
                the flow does changed
              </Detail>
            </div>
          ))}
        </div>
      )}

      {/* ---- impact (§20) ---- */}
      {showImpact && (
        <div className="ev-block">
          <div className="ev-section">Impact</div>
          {(c.impact ?? []).map((f, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div className="change-impact" key={`${f.kind}:${f.path}:${i}`}>
              <div className="change-impact-head">
                <span className={`change-status change-status-${String(f.status).toLowerCase()}`}>
                  {f.status}
                </span>
                <span className="change-impact-text">{f.statement}</span>
              </div>
              {f.why_it_matters && <Detail>{f.why_it_matters}</Detail>}
            </div>
          ))}
        </div>
      )}

      {/* ---- risk (§24, §25) ---- */}
      <div className="ev-block">
        <div className="ev-section">Risk</div>
        <span className={`change-verdict ${RISK_CLASS[c.risk] ?? ''}`}>{c.risk}</span>
        {c.risk_reason && <p className="change-statement">{c.risk_reason}</p>}
        {/* §25 — differences that were READ but not understood are named beside
            the assessment and excluded from it, rather than quietly rounded
            down into the word above. */}
        {c.risk_unknown_changes ? (
          <p className="change-claim">
            {c.risk_unknown_changes} difference(s) have an effect this build could not establish.
            They are listed above and are not counted in the assessment.
          </p>
        ) : null}
      </div>

      {/* ---- NowLint on the CURRENT artifact (§22) ---- */}
      <div className="ev-block">
        <div className="ev-section">NowLint</div>
        {!c.lint && <p className="change-statement">Not run.</p>}
        {c.lint?.error && <p className="change-statement">Could not run: {c.lint.error}</p>}
        {c.lint && !c.lint.error && (
          <>
            <p className="change-statement">
              {lintFindings.length
                ? `${lintFindings.length} finding${lintFindings.length === 1 ? '' : 's'} on the current artifact.`
                : 'No findings on the current artifact from the rules that ran.'}
            </p>
            {lintFindings.length > 0 && (
              <ul className="ev-list">
                {lintFindings.slice(0, 5).map((f) => (
                  <li key={f.id ?? f.rule_id}>
                    <span className="change-source">{f.rule_id}</span>
                    {f.title} ({f.status}/{f.severity})
                  </li>
                ))}
              </ul>
            )}
            {/* §22 — "do not claim lint clean if an important rule was not
                evaluated". Both halves are stated, because which one applies is
                the difference between a complete answer and a scoped one, and a
                reader cannot infer it from the findings. */}
            {scope?.relevant?.length > 0 && (
              <>
                <p className="change-note">
                  Rules relevant to what changed: {scope.relevant.join(', ')}.
                </p>
                {scope.not_evaluated?.length > 0 ? (
                  <p className="change-note">
                    Not evaluated: {scope.not_evaluated.join(', ')} — nothing above says those pass.
                  </p>
                ) : evaluated.length > 0 ? (
                  <p className="change-note">
                    All {evaluated.length} rules were evaluated against the current artifact, so the
                    findings above are not scoped.
                  </p>
                ) : null}
              </>
            )}
          </>
        )}
      </div>

      {/* ---- NowTest (§23) ---- */}
      <div className="ev-block">
        <div className="ev-section">NowTest</div>
        {c.test?.recommended ? (
          <>
            <p className="change-statement">Available. {c.test.reason}</p>
            {/* OFFERED, never launched. NowTest WRITES, so a comparison that
                started one by itself would turn a read-only question into a
                record on a real instance. The request is shown so the person
                clicking can see what they are about to ask for. */}
            <div className="change-handoff">
              <button type="button" className="btn sm" onClick={() => onRunTest?.(c.test.request)}>
                Run NowTest
              </button>
              <span className="change-handoff-note">{c.test.request}</span>
            </div>
          </>
        ) : (
          <p className="change-statement">{c.test?.reason ?? 'Not assessed.'}</p>
        )}
      </div>

      <NotDeployed deployment={c.deployment} onPrepare={onPrepare} />
    </div>
  );
}
