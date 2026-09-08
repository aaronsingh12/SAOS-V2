/**
 * PHASE 20 — THE APPLICATION BUILDER, on screen.
 *
 * §41 lists what a person must see before approving a build, and §70 shows the
 * shape. The ordering is the design: architecture, components, dependencies,
 * then CAPABILITY — which sits in the middle deliberately, because a reader who
 * has understood what would be built needs to learn immediately whether any of
 * it can be, before reading a risk assessment for work that will not happen.
 *
 * THE HEADLINE IS THE OUTCOME AND IT IS NEVER SOFTENED. §28 forbids reporting
 * APPLICATION CREATED when a component is unsupported, and the panel's last
 * line on any blocked run is the same sentence the server renders: no changes
 * were made.
 *
 * The client derives nothing. Status, outcome and verification are rendered
 * verbatim from the server, for the reason LintPanel and KnowledgePanel do the
 * same: a status this component computed could disagree with the evidence, and
 * the version a person reads would be the one that was wrong.
 */
import { useState } from 'react';

const STATUS_CLASS = {
  SUPPORTED: 'ab-supported',
  REQUIRES_ELEVATION: 'ab-elevation',
  REQUIRES_SDK: 'ab-sdk',
  REQUIRES_SOURCE_CONTROL: 'ab-sdk',
  REQUIRES_MANUAL_ACTION: 'ab-manual',
  UNSUPPORTED: 'ab-unsupported',
};

const OUTCOME_TITLE = {
  ARCHITECTURE_READY_BUILD_BLOCKED: 'ARCHITECTURE READY — BUILD BLOCKED',
  APPLICATION_VERIFIED: 'APPLICATION VERIFIED',
  APPLICATION_PARTIALLY_VERIFIED: 'APPLICATION BUILT — PARTIALLY VERIFIED',
  PARTIAL_BUILD: 'PARTIAL BUILD',
  BUILD_FAILED: 'BUILD FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
};

const OUTCOME_CLASS = {
  APPLICATION_VERIFIED: 'ab-ok',
  APPLICATION_PARTIALLY_VERIFIED: 'ab-partial',
  ARCHITECTURE_READY_BUILD_BLOCKED: 'ab-blocked',
  PARTIAL_BUILD: 'ab-partial',
  BUILD_FAILED: 'ab-bad',
  BLOCKED: 'ab-blocked',
  CANCELLED: 'ab-blocked',
};

export default function AppBuildPanel({ build }) {
  const [showDeps, setShowDeps] = useState(false);
  if (!build) return null;

  const {
    outcome, architecture, capability, graph, change, verification,
    created = [], testPlan = [], untestable = [], limitations = [],
    remediation = [], stopped, plan, knowledge, fingerprint,
  } = build;

  if (stopped && !architecture) {
    return (
      <div className="appbuild">
        <div className="ev-block">
          <div className="ev-section">Application Architecture</div>
          <p className="dx-statement">{stopped.note}</p>
          {(stopped.problems ?? []).map((p) => <p key={p.message} className="ab-problem">{p.message}</p>)}
          <p className="ab-nochange">No changes were made.</p>
        </div>
      </div>
    );
  }

  const counts = architecture?.counts ?? {};

  return (
    <div className="appbuild">
      <div className="ev-block">
        <div className="ev-section">Application Architecture</div>

        <div className="ab-head">
          <span className="ab-name">{architecture?.application?.name ?? 'Application'}</span>
          {architecture?.application?.scope
            ? <code className="ab-scope">{architecture.application.scope}</code>
            : null}
        </div>
        {architecture?.application?.purpose
          ? <p className="ab-purpose">{architecture.application.purpose}</p>
          : null}

        {/* ---- components ---- */}
        <div className="ab-section-head">Components</div>
        <div className="ab-counts">
          {Object.entries(counts).map(([type, n]) => (
            <span className="ab-count" key={type}>{n} {type}{n === 1 ? '' : 's'}</span>
          ))}
        </div>
        <ul className="ab-components">
          {(architecture?.components ?? []).map((c) => {
            const res = (capability?.resolutions ?? []).find((r) => r.component === c.id);
            return (
              <li key={c.id} className={c.collision ? 'ab-collision' : ''}>
                <span className="ab-type">{c.type}</span>
                <code>{c.name}</code>
                {res ? <span className={`ab-status ${STATUS_CLASS[res.status] ?? ''}`}>{res.status}</span> : null}
                {c.collision ? <span className="ab-status ab-manual">COLLISION</span> : null}
                {c.purpose ? <span className="ab-purpose-inline">{c.purpose}</span> : null}
              </li>
            );
          })}
        </ul>

        {/* ---- §7 reuse ---- */}
        {architecture?.reused?.length ? (
          <>
            <div className="ab-section-head">Already present — not rebuilt</div>
            <ul className="ab-components">
              {architecture.reused.map((r) => (
                <li key={r.identity}><code>{r.identity}</code><span className="ab-purpose-inline">{r.why}</span></li>
              ))}
            </ul>
          </>
        ) : null}

        {/* ---- dependencies, collapsed ---- */}
        {graph?.described?.length ? (
          <div className="ab-deps">
            <button type="button" className="ab-toggle" onClick={() => setShowDeps((v) => !v)}>
              {showDeps ? '▾' : '▸'} Dependencies ({graph.described.length})
            </button>
            {showDeps ? (
              <>
                <ul className="ab-dep-list">
                  {graph.described.map((d) => (
                    <li key={`${d.from}->${d.to}`}>
                      {d.from_label} → {d.to_label}
                      {d.external ? <span className="ab-external">already exists</span> : null}
                      <div className="ab-why">{d.why}</div>
                    </li>
                  ))}
                </ul>
                {graph.order?.length ? <p className="ab-order">Build order: {graph.order.join(' → ')}</p> : null}
              </>
            ) : null}
          </div>
        ) : null}

        {/* ---- §12 capability ---- */}
        <div className="ab-section-head">Capability</div>
        {capability?.executable ? (
          <p className="ab-ok-line">All requested components are supported on this instance.</p>
        ) : (
          <>
            <p className="ab-blocked-line">
              <strong>BUILD BLOCKED</strong> — {capability?.blocked?.length ?? 0} of {capability?.summary?.total ?? 0} component(s) cannot be built here.
            </p>
            <ul className="ab-blocked-list">
              {(capability?.blocked ?? []).map((b) => (
                <li key={b.component}>
                  <code>{b.component}</code>
                  <span className={`ab-status ${STATUS_CLASS[b.status] ?? ''}`}>{b.status}</span>
                  <div className="ab-why">{b.why}</div>
                </li>
              ))}
            </ul>
            {remediation.map((r) => (
              <p key={r.status} className="ab-remedy">
                <strong>{r.status}</strong> ({r.components.join(', ')}) — {r.what_would_unblock_it}
              </p>
            ))}
          </>
        )}

        {/* ---- §25 security ---- */}
        {architecture?.security?.length ? (
          <>
            <div className="ab-section-head">Security model</div>
            <table className="ab-security">
              <thead><tr><th>Table</th><th>Operation</th><th>Roles</th><th /></tr></thead>
              <tbody>
                {architecture.security.map((s) => (
                  <tr key={`${s.table}.${s.operation}`} className={s.restricted ? '' : 'ab-open'}>
                    <td><code>{s.table}</code></td>
                    <td>{s.operation}</td>
                    <td>{s.roles.join(', ') || '—'}</td>
                    <td className="ab-why">{s.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        {/* ---- §38 change ---- */}
        {change ? (
          <>
            <div className="ab-section-head">Change</div>
            <p>
              {change.total} component(s) would be added.
              {' '}Risk: <span className={`ab-risk ab-risk-${String(change.risk).toLowerCase()}`}>{change.risk}</span>
            </p>
            <p className="ab-why">{change.why}</p>
          </>
        ) : null}

        {/* ---- §39 knowledge ---- */}
        {knowledge?.panel && !knowledge.panel.empty ? (
          <>
            <div className="ab-section-head">Relevant knowledge</div>
            <ul className="ab-knowledge">
              {knowledge.panel.entries.slice(0, 4).map((e) => (
                <li key={`${e.title}-${e.ref}`}>
                  <span className="ab-klabel">{e.label}</span> {e.title}: {e.content}
                </li>
              ))}
            </ul>
            <p className="ab-why">{knowledge.panel.note}</p>
          </>
        ) : null}

        {/* ---- §35 test plan ---- */}
        {testPlan.length ? (
          <>
            <div className="ab-section-head">Test plan</div>
            <ol className="ab-testplan">
              {testPlan.map((t) => (
                <li key={t.id}>{t.criterion}<div className="ab-why">{t.note}</div></li>
              ))}
            </ol>
          </>
        ) : null}
        {untestable.length ? (
          <p className="ab-why">
            {untestable.length} stated criterion/criteria describe a quality rather than an observation,
            so nothing can establish them: {untestable.join('; ')}
          </p>
        ) : null}

        {/* ---- what was built, if anything ---- */}
        {created.length ? (
          <>
            <div className="ab-section-head">Created</div>
            <ul className="ab-components">
              {created.map((c) => {
                const v = (verification?.components_detail ?? []).find((x) => x.component === c.component);
                return (
                  <li key={c.component}>
                    <span className="ab-type">{c.type}</span>
                    <code>{c.component}</code>
                    <span className={`ab-status ${v?.state === 'VERIFIED' ? 'ab-supported' : 'ab-manual'}`}>
                      {v?.state ?? 'NOT_ATTEMPTED'}
                    </span>
                    {c.step_succeeded === false
                      ? <span className="ab-status ab-manual">step failed — artifact exists</span>
                      : null}
                  </li>
                );
              })}
            </ul>
            {verification?.behaviour ? (
              <p className="ab-why"><strong>Behaviour:</strong> {verification.behaviour.note}</p>
            ) : null}
          </>
        ) : null}

        {/* ---- the outcome ---- */}
        <div className={`ab-outcome ${OUTCOME_CLASS[outcome] ?? ''}`}>
          {OUTCOME_TITLE[outcome] ?? outcome}
        </div>
        {outcome === 'ARCHITECTURE_READY_BUILD_BLOCKED' || outcome === 'BLOCKED' ? (
          <p className="ab-nochange">No changes were made.</p>
        ) : null}
        {plan?.fingerprint ? (
          <p className="ab-why">Plan {plan.fingerprint.slice(0, 12)} · {plan.steps?.length ?? 0} step(s)</p>
        ) : null}
        {fingerprint ? <p className="ab-why">Architecture {fingerprint.slice(0, 12)}</p> : null}

        {limitations.length ? (
          <>
            <div className="ab-section-head">Known limitations</div>
            <ul className="ab-limitations">{limitations.map((l) => <li key={l}>{l}</li>)}</ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
