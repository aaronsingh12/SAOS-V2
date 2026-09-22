import ReferenceField from './ReferenceField.jsx';

/**
 * The two pieces of the remediation review that are the same whether one
 * finding is being fixed or twenty: the editable change list, and the
 * executor's per-record card.
 *
 * Lifted out of RemediationDrawer unchanged so that BulkFixDrawer is a second
 * CALLER of the same editor and the same card, not a second editor. The rules
 * they carry — a boolean gets two states, a reference is picked and never
 * typed, a removed change stays visible, a datetime says it is UTC — apply to a
 * batch exactly as they apply to one.
 */

/** Is a change executable as it stands? Same rule the server's `executableChanges` applies. */
export const isExecutable = (c) => c.status !== 'removed'
  && (c.fieldKind === 'delete' || String(c.proposedValue ?? '').trim() !== '');

/** The status a change takes after its value moved. */
export const statusFor = (c, value) => (c.fieldKind === 'delete' || String(value ?? '').trim() ? 'ready' : 'needs_value');

/**
 * The editable change list.
 *
 * `results` is the execution's per-record outcome once there is one; `settled`
 * turns the editors into plain text. `onSetValue(id, value, display)` and
 * `onToggleRemoved(id)` are the only two edits a reviewer can make — the
 * target is never editable, by design.
 */
export function ProposalChangeList({ changes, settled, results = null, onSetValue, onToggleRemoved }) {
  if (!changes?.length) {
    return (
      <p className="note">
        This rule has no single-field fix, so there is nothing to apply automatically. The manual steps on the
        finding are the remedy.
      </p>
    );
  }
  return (
    <ul className="rm-changes">
      {changes.map((c) => {
        const removed = c.status === 'removed';
        const result = results?.find((r) => r.sys_id === c.sys_id);
        return (
          <li key={c.id} className={`rm-change${removed ? ' is-removed' : ''}`}>
            <div className="rm-change-head">
              <span className="mono rm-target">{c.table} / {c.label}</span>
              {!settled && (
                <button type="button" className="btn ghost sm" onClick={() => onToggleRemoved(c.id)}>
                  {removed ? 'Put back' : 'Remove'}
                </button>
              )}
            </div>

            {c.field && (
              <div className="rm-field">
                <span className="rm-field-name mono">{c.field}</span>
                <div className="rm-vals">
                  <div>
                    <span className="rm-val-cap">Current</span>
                    <span className="rm-val mono">
                      {c.currentDisplay || c.currentValue || <em>(empty)</em>}
                    </span>
                  </div>
                  <span className="rm-arrow" aria-hidden="true">→</span>
                  <div>
                    <span className="rm-val-cap">Proposed</span>
                    {settled || removed ? (
                      <span className="rm-val mono">
                        {c.proposedDisplay || c.proposedValue || <em>(none)</em>}
                      </span>
                    ) : c.fieldKind === 'boolean' ? (
                      /* A boolean is two states, so it gets two states.
                         A free-text box here is how "True" ends up stored
                         where `true` was meant. */
                      <select
                        className="input"
                        value={c.proposedValue}
                        onChange={(e) => onSetValue(c.id, e.target.value)}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    ) : c.fieldKind === 'datetime' ? (
                      /* ServiceNow stores UTC. The control says so rather
                         than letting a reader assume their own zone — an
                         outage closed at the wrong hour is a wrong
                         availability figure, not a cosmetic slip. */
                      <input
                        className="input"
                        value={c.proposedValue}
                        onChange={(e) => onSetValue(c.id, e.target.value)}
                        placeholder="YYYY-MM-DD HH:MM:SS (UTC)"
                      />
                    ) : c.fieldKind === 'reference' && c.references ? (
                      /* The app's own reference picker — a sys_id is
                         never typed by hand here, for the same reason
                         the agent is told to resolve rather than invent. */
                      <ReferenceField
                        table={c.references}
                        value={c.proposedValue ? { id: c.proposedValue, label: c.proposedDisplay || c.proposedValue } : null}
                        onChange={(v) => onSetValue(c.id, v?.id || '', v?.label || '')}
                        placeholder={`Search ${c.references}…`}
                      />
                    ) : (
                      <input
                        className="input"
                        value={c.proposedValue}
                        onChange={(e) => onSetValue(c.id, e.target.value)}
                        placeholder="Value to set"
                      />
                    )}
                  </div>
                </div>
              </div>
            )}

            {c.fieldKind === 'delete' && (
              <p className="rm-note"><b>This record would be deleted.</b> Deletion cannot be undone.</p>
            )}

            {c.assumption && (
              <p className="rm-assume">
                <b>Assumed:</b> {c.assumption}
                {c.confidence != null && <span className="rm-conf"> · confidence {c.confidence}</span>}
                {c.resolvedFrom && <span className="rm-conf"> · matched “{c.resolvedFrom}”</span>}
              </p>
            )}
            {c.resolutionNote && <p className="rm-note">{c.resolutionNote}</p>}
            {c.status === 'needs_value' && !removed && !settled && (
              <p className="rm-note">No value proposed — supply one, or remove this change.</p>
            )}

            {/* After execution: what actually happened to THIS record. */}
            {result && (
              <p className={`rm-result tone-${result.ok ? 'ok' : 'bad'}`}>
                {result.ok ? '✓ applied' : '✗ not applied'}
                {result.verdict ? ` · read-back ${result.verdict}` : ''}
                {result.note ? ` · ${result.note}` : ''}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * THE EXECUTOR'S OWN CARD, one per write. What it shows is what will be sent —
 * the table, the record and the exact data. `change` is the proposal's change
 * for the record the card names, when the caller can find it.
 *
 * `onDecide(true|false)` answers it through POST /api/agent/approve in the
 * caller; `onStop` aborts the stream, which cancels the waiting gate.
 */
export function WriteGateCard({ gate, change = null, onDecide, onStop }) {
  if (!gate) return null;
  return (
    <div className="approval-card rm-gate">
      <div className="title">Confirm this write — it changes your instance</div>
      <p className="rm-lead">
        {change ? (
          <>
            {change.field ? 'Set ' : 'Delete '}
            {change.field && <b className="mono">{change.field}</b>}
            {change.field ? ' on ' : ''}
            <b>{change.table} / {change.label}</b>
            {change.field && <> to <b>{change.proposedDisplay || change.proposedValue}</b></>}
          </>
        ) : (gate.operation || gate.name)}
      </p>
      <pre className="mono">{JSON.stringify(gate.input ?? {}, null, 2)}</pre>
      {gate.warning && <p className="note">{gate.warning}</p>}
      <div className="row">
        <button
          type="button" className="btn primary sm" onClick={() => onDecide(true)}
          disabled={gate.sending !== undefined} aria-busy={gate.sending === true}
        >
          {gate.sending === true ? 'Sending…' : 'Apply this change'}
        </button>
        <button
          type="button" className="btn sm" onClick={() => onDecide(false)}
          disabled={gate.sending !== undefined} aria-busy={gate.sending === false}
        >
          {gate.sending === false ? 'Sending…' : 'Skip this record'}
        </button>
        <button type="button" className="btn ghost sm" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  );
}
