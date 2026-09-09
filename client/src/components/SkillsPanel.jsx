import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { toast } from './toast.js';

/**
 * SKILLS, AS A FIRST-CLASS PART OF THE WORKSPACE (§28–§46).
 *
 * §82's second question — "what skills does this agent have?" — is what this
 * answers, and §32/§43 decide how: by showing what a skill can actually READ
 * and actually CHANGE, computed by the server from the capability taxonomy and
 * the live tool registry.
 *
 * THE PERMISSION LISTS ARE NOT WRITTEN HERE, AND CANNOT BE. They arrive on the
 * skill object as `permissions.can_read` / `permissions.can_change`, derived
 * server-side from the same map the planner selects tools with. §79.13 makes a
 * display that disagrees with the actual capability a release blocker, and the
 * way that is made impossible is that this component has nothing to disagree
 * WITH — it renders the server's answer and holds no opinion of its own.
 *
 * §75 — every action here is on the allowed list: enable, disable, install,
 * remove, look. There is no path from this panel to a tool, a mutation or an
 * approval.
 */

const TRUST_LABEL = {
  built_in: 'Built-in',
  verified: 'Verified',
  user_installed: 'User-installed',
  unverified: 'Unverified',
};

const STATE_TONE = {
  enabled: 'ok',
  disabled: 'idle',
  blocked: 'bad',
  unsupported: 'warn',
};

export default function SkillsPanel({ onChanged = null, disabled = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get('/skills'));
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (skill, next) => {
    setBusy(skill.identity);
    try {
      await api.patch(`/skills/${encodeURIComponent(skill.identity)}`, { enabled: next });
      await load();
      onChanged?.();
      toast.success(`${skill.name} ${next ? 'enabled' : 'disabled'}`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (skill) => {
    setBusy(skill.identity);
    try {
      await api.del(`/skills/${encodeURIComponent(skill.identity)}`);
      await load();
      onChanged?.();
      toast.success(`${skill.name} removed`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    let manifest;
    try {
      manifest = JSON.parse(draft);
    } catch {
      toast.error('That is not valid JSON.');
      return;
    }
    setBusy('install');
    try {
      const res = await api.post('/skills', { manifest });
      setDraft('');
      setAdding(false);
      await load();
      onChanged?.();
      toast.success(`${res.skill.name} installed`);
    } catch (err) {
      /*
       * §33/§34 — the server's validation errors, in full and verbatim. A
       * manifest is refused for a specific reason (an unknown capability, a
       * tool the registry does not have, a permission claim that disagrees with
       * what its capabilities grant) and the person can only fix what they can
       * read.
       */
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="sk-empty">Skills unavailable — {error}</div>;
  if (!data) return <div className="sk-empty">Loading skills…</div>;

  return (
    <section className="sk" aria-label="Skills">
      <header className="sk-head">
        <span className="sk-title">Skills</span>
        <span className="sk-count">{data.counts.enabled}/{data.counts.total}</span>
      </header>

      <ul className="sk-list">
        {data.skills.map((s) => {
          const isOpen = open === s.identity;
          const blocked = s.state === 'blocked';
          return (
            <li key={s.identity} className={`sk-item sk-${STATE_TONE[s.state] ?? 'idle'}`}>
              <div className="sk-row">
                <label className="sk-toggle" title={blocked ? 'This skill is blocked and cannot be enabled.' : undefined}>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={disabled || blocked || busy === s.identity}
                    onChange={(e) => toggle(s, e.target.checked)}
                    aria-label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
                  />
                  <span className="sk-name">{s.name}</span>
                </label>
                <button
                  type="button"
                  className="sk-info"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : s.identity)}
                  title="What this skill can do"
                >
                  {isOpen ? '−' : '+'}
                </button>
              </div>
              <div className="sk-meta">
                <span className="sk-version">{s.version}</span>
                <span className="sk-trust">{TRUST_LABEL[s.trust] ?? s.trust}</span>
                {/* §69 — listed is not the same as runnable. */}
                {blocked && <span className="sk-blocked">blocked</span>}
              </div>

              {isOpen && (
                <div className="sk-detail">
                  <p className="sk-desc">{s.description}</p>

                  {/* §37 — a conflict names the other claimant and chooses neither. */}
                  {s.errors.length > 0 && (
                    <ul className="sk-errors">
                      {s.errors.map((e) => <li key={e}>{e}</li>)}
                    </ul>
                  )}

                  <div className="sk-perm">
                    <div className="sk-perm-head">Can read</div>
                    {s.permissions.can_read.length
                      ? <div className="sk-tools">{s.permissions.can_read.join(', ')}</div>
                      : <div className="sk-none">nothing</div>}
                  </div>
                  <div className="sk-perm">
                    <div className="sk-perm-head">Can change</div>
                    {s.permissions.can_change.length
                      ? <div className="sk-tools sk-mutating">{s.permissions.can_change.join(', ')}</div>
                      : <div className="sk-none">nothing</div>}
                  </div>
                  {/*
                    * §32/§43 — the same for every skill, and true of every skill.
                    * Rendered from the server's constant rather than typed here,
                    * so it cannot drift from what the platform enforces.
                    */}
                  <div className="sk-perm">
                    <div className="sk-perm-head">Cannot</div>
                    <div className="sk-never">{data.never.join(' · ')}</div>
                  </div>
                  {s.manifest.permissions.note && (
                    <p className="sk-note">{s.manifest.permissions.note}</p>
                  )}

                  {s.trust !== 'built_in' && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={disabled || busy === s.identity}
                      onClick={() => remove(s)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* §34 — Add Skill. A manifest is DATA: there is no URL field and nothing is fetched. */}
      {adding ? (
        <div className="sk-add">
          <textarea
            className="textarea sk-draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={'{\n  "id": "cmdb-investigator",\n  "name": "CMDB Investigator",\n  "version": "1.0.0",\n  "description": "Read CIs and their relationships.",\n  "capabilities": ["record_read", "dependency_analysis"],\n  "permissions": { "read": ["cmdb_ci"], "change": [] }\n}'}
            aria-label="Skill manifest JSON"
          />
          <p className="sk-hint">
            A manifest is data — capabilities, rules and knowledge references. It cannot contain code,
            reach credentials, or grant itself anything the platform does not already permit.
          </p>
          <div className="row">
            <button type="button" className="btn primary sm" disabled={!draft.trim() || busy === 'install'} onClick={install}>
              Install
            </button>
            <button type="button" className="btn ghost sm" onClick={() => { setAdding(false); setDraft(''); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="sk-addbtn" onClick={() => setAdding(true)} disabled={disabled}>
          + Add skill
        </button>
      )}
    </section>
  );
}
