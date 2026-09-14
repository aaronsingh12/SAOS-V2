import { useEffect, useState } from 'react';
import { AGENT_PREFS_SLOT_ID } from '../components/agentRail.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { DisconnectedBanner } from '../components/states.jsx';

const HINTS = {
  anthropic: { model: 'claude-sonnet-4-6', baseUrl: 'api.anthropic.com (fixed)', key: true },
  openai: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', key: true },
  ollama: { model: 'llama3.1 (tool-capable model required)', baseUrl: 'http://localhost:11434/v1', key: false },
  // No default model: OpenRouter fronts hundreds of vendor/model ids and one
  // has to be chosen. The picker below loads them live rather than shipping a
  // list that goes stale.
  openrouter: { model: 'vendor/model — pick from the live list', baseUrl: 'https://openrouter.ai/api/v1', key: true },
  // Neither the model nor the base URL has a default, and the placeholders say
  // so rather than showing an address that would be a guess about the
  // operator's own network. "OpenCode-compatible" is a wire format (OpenAI
  // /chat/completions), not a hosted service, so the server refuses to send
  // anything until both are set. The key field is shown but OPTIONAL — a
  // self-hosted gateway may or may not want a bearer token, and the adapter
  // only sends an Authorization header when one is set; hiding the field would
  // make a token-protected gateway unusable.
  opencode: { model: 'required — whatever your gateway serves', baseUrl: 'required — e.g. http://localhost:4096/v1', key: true },
};

export default function Settings() {
  const [llm, setLlm] = useState({ provider: 'anthropic', apiKey: '', baseUrl: '', model: '', embedModel: '' });
  const [memory, setMemory] = useState(null);
  const [saved, setSaved] = useState(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // OpenRouter's catalogue, fetched only when that provider is selected.
  const [orModels, setOrModels] = useState(null);

  useEffect(() => {
    api.get('/system/settings').then((s) => {
      setSaved(s);
      setLlm({ provider: s.llm.provider, apiKey: '', baseUrl: s.llm.baseUrl, model: s.llm.model, embedModel: s.llm.embedModel || '' });
      setAutoApprove(s.agent.autoApprove);
    }).catch((e) => setError(e.message));
    api.get('/agent/memory/status').then(setMemory).catch(() => {});
  }, []);

  // Loaded only when OpenRouter is the selected provider, and only once —
  // it is ~400 entries and irrelevant to every other provider.
  useEffect(() => {
    if (llm.provider !== 'openrouter' || orModels) return;
    api.get('/agent/openrouter/models').then(setOrModels)
      .catch((e) => setOrModels({ ok: false, models: [], error: e.message }));
  }, [llm.provider, orModels]);

  const hint = HINTS[llm.provider];

  const save = async () => {
    setSaving(true); setError('');
    try {
      const s = await api.post('/system/settings', { llm, agent: { autoApprove } });
      setSaved(s);
      setLlm((l) => ({ ...l, apiKey: '' }));
      toast.success('Settings saved.');
    } catch (e) { setError(e.message); toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="stack">
      <DisconnectedBanner />
      <div className="grid2">
      <div className="card">
        <div className="card-title">LLM provider — bring your own model</div>
        <div className="field">
          <label className="label">Provider</label>
          <select className="select" value={llm.provider} onChange={(e) => setLlm({ ...llm, provider: e.target.value, baseUrl: '', model: '' })}>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
            <option value="ollama">Ollama (local)</option>
            <option value="openrouter">OpenRouter</option>
            <option value="opencode">OpenCode-compatible (self-hosted)</option>
          </select>
        </div>
        {hint.key && (
          <div className="field">
            <label className="label">API key {saved?.llm.hasApiKey ? '· saved' : ''}</label>
            <input className="input mono" type="password" placeholder={saved?.llm.hasApiKey ? '••••••••••••' : 'sk-…'}
              value={llm.apiKey} onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })} />
          </div>
        )}
        {llm.provider !== 'anthropic' && (
          <div className="field">
            <label className="label">Base URL</label>
            <input className="input mono" placeholder={hint.baseUrl} value={llm.baseUrl}
              onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })} />
          </div>
        )}
        <div className="field">
          <label className="label">
            Model
            {llm.provider === 'openrouter' && orModels?.ok && (
              <span className="badge green" style={{ marginLeft: 8 }}>{orModels.count} available</span>
            )}
          </label>
          <input className="input mono" placeholder={hint.model} value={llm.model}
            list={llm.provider === 'openrouter' ? 'openrouter-models' : undefined}
            onChange={(e) => setLlm({ ...llm, model: e.target.value })} />
          {/*
            A datalist rather than a select: OpenRouter's catalogue is large and
            changes, and typing an id that the list has not caught up with must
            still work. The list is a convenience, never a constraint.
          */}
          {llm.provider === 'openrouter' && orModels?.ok && (
            <datalist id="openrouter-models">
              {orModels.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </datalist>
          )}
          {llm.provider === 'openrouter' && orModels && !orModels.ok && (
            <div className="hint">{orModels.error}</div>
          )}
        </div>
        <div className="field">
          <label className="label">
            Embedding model — semantic recall
            {memory && (
              <span className={`badge ${memory.degraded ? 'amber' : 'green'}`} style={{ marginLeft: 8 }}>
                {memory.degraded ? 'keyword only' : `semantic · ${memory.dim}d`}
              </span>
            )}
          </label>
          <input className="input mono" placeholder="nomic-embed-text" value={llm.embedModel}
            onChange={(e) => setLlm({ ...llm, embedModel: e.target.value })} />
          {memory?.degraded && (
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Not pulled, so chat search matches words rather than meaning. Fix with{' '}
              <span className="mono">{memory.command}</span>
            </span>
          )}
        </div>
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
          Auto-approve agent mutations (skip the amber gate)
        </label>
        <button className="btn primary" onClick={save} aria-busy={saving} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>

      {/*
        * AGENT BEHAVIOUR — the two switches that used to sit in the navigation.
        *
        * Relocated, not reimplemented. The slot below is filled by AgentChat
        * through the same portal seam the chat list and skills already use, so
        * these are the SAME checkboxes bound to the SAME capture/autoApprove
        * state and the same handlers that talk to the same endpoints. Nothing
        * about approval or capture logic changed; only where they are drawn.
        */}
      <div className="card">
        <div className="card-title">Agent behaviour</div>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--muted)' }}>
          How the agent treats changes it makes on your behalf. Both apply to the
          next turn; a turn already running keeps the settings it started with.
        </p>
        <div id={AGENT_PREFS_SLOT_ID} className="prefs-slot" />
      </div>

      </div>
    </div>
  );
}
