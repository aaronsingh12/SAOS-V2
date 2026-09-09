import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { confirmDestructive, CONSEQUENCE } from '../components/confirm.js';
import { toast } from '../components/toast.js';
import { EmptyState } from '../components/states.jsx';
import { refreshHealth } from '../hooks/useHealth.js';
import { refreshBinding } from '../hooks/useBinding.js';

export default function Dashboard() {
  const [conn, setConn] = useState({ instanceUrl: '', authType: 'basic', username: '', password: '', clientId: '', clientSecret: '' });
  const [saved, setSaved] = useState(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [test, setTest] = useState(null);
  const [error, setError] = useState('');
  const [stats, setStats] = useState(null);

  const loadStats = () => api.get('/incidents/stats').then(setStats).catch(() => setStats(null));

  useEffect(() => {
    api.get('/system/settings').then((s) => {
      setSaved(s);
      setConn((c) => ({ ...c, instanceUrl: s.connection.instanceUrl, authType: s.connection.authType, username: s.connection.username, clientId: s.connection.clientId }));
      if (s.connection.instanceUrl) loadStats();
    }).catch(() => {});
  }, []);

  const save = async () => {
    setSaving(true); setError('');
    try {
      const s = await api.post('/system/settings', { connection: conn });
      setSaved(s);
      setConn((c) => ({ ...c, password: '', clientSecret: '' })); // stored; stop holding it in the form
      setTest(null);
      toast.success('Connection saved. Test it to confirm the credentials work.');
      refreshHealth();   // the topbar pill and every RequiresInstance gate read this
      refreshBinding();  // scope + sync are per-binding; a new instance must not wear the old verdict
    } catch (e) { setError(e.message); toast.error(e.message); }
    finally { setSaving(false); }
  };

  const runTest = async () => {
    setTesting(true); setError(''); setTest(null);
    try {
      const r = await api.post('/system/connection/test');
      setTest(r);
      loadStats();
    } catch (e) { setError(e.message); }
    finally { setTesting(false); }
  };

  const disconnect = async () => {
    const ok = await confirmDestructive({
      action: 'Disconnect from',
      subject: saved?.connection?.instanceUrl || 'this instance',
      detail: CONSEQUENCE.connection,
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
    setDisconnecting(true); setError(''); setTest(null);
    try {
      const s = await api.post('/system/connection/disconnect');
      setSaved(s);
      setConn({ instanceUrl: '', authType: 'basic', username: '', password: '', clientId: '', clientSecret: '' });
      setStats(null);
      toast.info('Disconnected. The stored credentials are cleared.');
      refreshHealth();
      refreshBinding();
    } catch (e) { setError(e.message); toast.error(e.message); }
    finally { setDisconnecting(false); }
  };

  const warnings = saved?.connection?.warnings || [];
  const connected = Boolean(saved?.connection?.instanceUrl && saved?.connection?.hasPassword);

  return (
    <div className="stack">
      <div className="grid2">
        <div className="card">
          <div className="card-title">PDI connection</div>
          <div className="field">
            <label className="label">Instance URL</label>
            <input className="input mono" placeholder="https://<your-instance>.service-now.com" value={conn.instanceUrl}
              onChange={(e) => setConn({ ...conn, instanceUrl: e.target.value.trim() })} />
          </div>
          <div className="field">
            <label className="label">Auth type</label>
            <select className="select" value={conn.authType} onChange={(e) => setConn({ ...conn, authType: e.target.value })}>
              <option value="basic">Basic (username + password)</option>
              <option value="oauth">OAuth 2.0 (password grant)</option>
            </select>
          </div>
          <div className="grid2">
            <div className="field">
              <label className="label">Username</label>
              <input className="input" value={conn.username} onChange={(e) => setConn({ ...conn, username: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">Password {saved?.connection.hasPassword ? '· saved' : ''}</label>
              <input className="input" type="password" placeholder={saved?.connection.hasPassword ? '••••••••' : ''} value={conn.password}
                onChange={(e) => setConn({ ...conn, password: e.target.value })} />
            </div>
          </div>
          {conn.authType === 'oauth' && (
            <div className="grid2">
              <div className="field">
                <label className="label">Client ID</label>
                <input className="input mono" value={conn.clientId} onChange={(e) => setConn({ ...conn, clientId: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">Client secret {saved?.connection.hasClientSecret ? '· saved' : ''}</label>
                <input className="input" type="password" value={conn.clientSecret} onChange={(e) => setConn({ ...conn, clientSecret: e.target.value })} />
              </div>
            </div>
          )}
          <div className="row">
            <button className="btn primary" onClick={save} aria-busy={saving} disabled={saving}>
              {saving ? 'Saving…' : 'Save connection'}
            </button>
            <button className="btn" onClick={runTest} disabled={testing}>{testing ? 'Testing…' : 'Test connection'}</button>
            {connected && (
              <button className="btn amber" onClick={disconnect} aria-busy={disconnecting} disabled={disconnecting}
                style={{ marginLeft: 'auto' }}>
                {disconnecting ? 'Disconnecting…' : 'Log out'}
              </button>
            )}
          </div>

          {warnings.length > 0 && (
            <div className="note warn" style={{ marginTop: 10 }}>
              <b>Check the saved credentials.</b>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 0' }}>
                Re-enter the password and save — leading and trailing spaces are stripped automatically, but
                spaces in the middle are kept, because they might be real.
              </p>
            </div>
          )}

          {test && <p className="ok-text">Connected. Sample user: <span className="mono">{test.sampleUser || 'n/a'}</span>{test.build ? <> · build <span className="mono">{test.build}</span></> : null}</p>}
          {error && <p className="error-text">{error}</p>}
        </div>

        <div className="card">
          <div className="card-title">Incident pulse</div>
          {stats ? (
            <div className="grid2">
              <div className="stat"><b>{stats.open}</b><span>open incidents</span></div>
              <div className="stat"><b style={{ color: 'var(--red)' }}>{stats.critical}</b><span>priority 1</span></div>
              <div className="stat"><b style={{ color: 'var(--amber)' }}>{stats.unassigned}</b><span>unassigned</span></div>
              <div className="stat"><b>{stats.new}</b><span>state: new</span></div>
            </div>
          ) : (
            <EmptyState
              icon="○"
              title="No counts yet."
              hint={connected
                ? 'Run Test connection to confirm the credentials, and the pulse fills in.'
                : 'Save your PDI URL and admin credentials on the left, then test the connection.'}
              actionLabel="Test connection"
              onAction={runTest}
            />
          )}
          <div className="note" style={{ marginTop: 14 }}>
            Counts come from the Aggregate API on your bound instance. The Agent, Incidents, Catalog, and Flows
            modules all run against this same connection.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">What this platform does</div>
        <div className="grid3">
          <div>
            <h3 style={{ fontSize: 14, marginBottom: 6 }}>Incidents</h3>
            <p style={{ color: 'var(--muted)', margin: 0, fontSize: 13 }}>Full CRUD with schema-aware choice lists and reference pickers for caller, group, and assignee.</p>
          </div>
          <div>
            <h3 style={{ fontSize: 14, marginBottom: 6 }}>Catalog</h3>
            <p style={{ color: 'var(--muted)', margin: 0, fontSize: 13 }}>Items, all variable types with choices, variable sets, order guides, and record producers.</p>
          </div>
          <div>
            <h3 style={{ fontSize: 14, marginBottom: 6 }}>Flows</h3>
            <p style={{ color: 'var(--muted)', margin: 0, fontSize: 13 }}>Read any flow top-to-bottom, watch executions, and design new automations with AI blueprints.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
