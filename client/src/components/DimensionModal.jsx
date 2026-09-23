import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { toast } from './toast.js';
import DimensionIcon from './DimensionIcon.jsx';
import { DimensionTile, TypeBadge } from './DimensionViews.jsx';

/*
 * CREATE / EDIT / VIEW A FINDING DIMENSION — a three-step dialog.
 *
 *   1 Details       name and description
 *   2 Define rules  select rules · smart match · AI assist
 *   3 Review        what will be saved, and what it would show today
 *
 * A dimension groups RULES; findings inherit it when the page reads them. Every
 * tool here works on the rule CATALOGUE, never on findings; nothing is saved
 * until Save, and the server re-checks every rule id it is sent. Dimensions are
 * GLOBAL — there is deliberately no scope step: the same rule means the same
 * thing on every instance.
 *
 * Built-in and Unclassified open read-only ("view" mode): their rules can be
 * read here, not changed.
 */

const NAME_MAX = 80;
const DESCRIPTION_MAX = 1000;
const RULES_SHOWN = 200;
const STEPS = [
  { key: 1, title: 'Details', sub: 'Name and description' },
  { key: 2, title: 'Define rules', sub: 'Choose how to add rules' },
  { key: 3, title: 'Review', sub: 'Preview and confirm' },
];
const METHODS = [
  { key: 'select', icon: 'listChecks', title: 'Select rules', sub: 'Pick rules from the catalogue' },
  { key: 'match', icon: 'sliders', title: 'Smart match', sub: 'Match rules by their metadata' },
  { key: 'ai', icon: 'sparkles', title: 'AI assist', sub: 'Let the model suggest rules' },
];
const MODULES = [['', 'All modules'], ['cmdb', 'CMDB'], ['itom', 'ITOM'], ['itsm', 'ITSM'], ['platform', 'Platform']];
const QUALITY_DIMENSIONS = [
  ['D1', 'Completeness'], ['D2', 'Correctness'], ['D3', 'Uniqueness'], ['D4', 'Identification'], ['D5', 'Reconciliation'],
  ['D6', 'Relationships'], ['D7', 'Freshness'], ['D8', 'Lifecycle'], ['D9', 'Ownership'], ['D10', 'Consumption'],
];
const EMPTY_MATCHER = { module: '', prefix: '', group: '', qualityDimension: '', domain: '', sourceTable: '', keyword: '' };
const SOURCE_LABEL = { manual: 'selected', matcher: 'matched', ai: 'AI', builtin: 'built in', fallback: 'no dimension' };

/* The catalogue is the same for every dialog — read once per page load. */
let catalogueCache = null;
function loadCatalogue() {
  if (!catalogueCache) {
    catalogueCache = api.get('/health/dimensions/rules').then((r) => r.rules || []).catch((e) => { catalogueCache = null; throw e; });
  }
  return catalogueCache;
}

function RuleRow({ r, checked, onToggle, reason, disabled }) {
  return (
    <li className={`hx-rrow${checked ? ' is-on' : ''}`}>
      <label>
        <input type="checkbox" checked={checked} onChange={() => onToggle(r)} disabled={disabled} />
        <span className="hx-rrow-main">
          <span className="hx-rrow-top"><code>{r.ruleId}</code><span className="hx-rrow-title">{r.title}</span></span>
          <span className="hx-rrow-meta">
            {[r.module?.toUpperCase(), r.groupName, r.qualityDimension && `${r.qualityDimension} ${r.qualityDimensionLabel || ''}`.trim()].filter(Boolean).join(' · ')}
          </span>
          {reason && <span className="hx-rrow-reason"><DimensionIcon name="sparkles" size={13} /> {reason}</span>}
        </span>
      </label>
    </li>
  );
}

export default function DimensionModal({ open, mode = 'create', dimensionId = null, initialStep = 1, scope = 'all', bands = [], onClose, onSaved, onViewFindings }) {
  const panelRef = useRef(null);
  const [step, setStep] = useState(1);
  const [reached, setReached] = useState(1);
  const [loaded, setLoaded] = useState(null);       // the dimension being edited or viewed
  const [catalogue, setCatalogue] = useState([]);
  const [catErr, setCatErr] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [picked, setPicked] = useState(() => new Map());   // ruleId → manual | matcher | ai
  const [method, setMethod] = useState('select');
  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [matcher, setMatcher] = useState(EMPTY_MATCHER);
  const [matched, setMatched] = useState(null);
  const [ai, setAi] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null);
  const [touched, setTouched] = useState(false);

  const readOnly = mode === 'view';

  /* Open: reset, then load the catalogue and (for edit/view) the dimension. */
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setStep(readOnly ? 2 : initialStep); setReached(readOnly ? 3 : (dimensionId ? 3 : initialStep));
    setName(''); setDescription(''); setPicked(new Map()); setMethod('select'); setSearch(''); setModuleFilter('');
    setMatcher(EMPTY_MATCHER); setMatched(null); setAi(null); setErr(''); setPreview(null); setLoaded(null); setTouched(false);
    loadCatalogue().then((c) => { if (alive) setCatalogue(c); }).catch((e) => { if (alive) setCatErr(`Unable to load the rule catalogue. ${e.message}`); });
    if (dimensionId) {
      api.get(`/health/dimensions/${encodeURIComponent(dimensionId)}`)
        .then(({ dimension }) => {
          if (!alive) return;
          setLoaded(dimension);
          setName(dimension.name);
          setDescription(dimension.description || '');
          setPicked(new Map(dimension.rules.map((r) => [r.ruleId, r.mapping_source || 'manual'])));
        })
        .catch((e) => { if (alive) setErr(`Unable to open the dimension. ${e.message}`); });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dimensionId, mode]);

  /* Escape closes; focus moves in, and back out to whatever opened it. */
  useEffect(() => {
    if (!open) return undefined;
    const restore = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    document.addEventListener('keydown', onKey);
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
      if (restore instanceof HTMLElement) restore.focus();
    };
  }, [open, onClose]);

  /* Preview: what the chosen rules would show over the findings in view. */
  const seq = useRef(0);
  useEffect(() => {
    if (!open || readOnly) return undefined;
    const rules = [...picked.keys()];
    const s = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const p = await api.post('/health/dimensions/preview', { rules, scope });
        if (s === seq.current) setPreview(p);
      } catch (e) { if (s === seq.current) setPreview({ error: e.message }); }
    }, 250);
    return () => clearTimeout(t);
  }, [picked, open, readOnly, scope]);

  const byRule = useMemo(() => new Map(catalogue.map((r) => [r.ruleId, r])), [catalogue]);
  const filtered = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return catalogue.filter((r) => (!moduleFilter || r.module === moduleFilter)
      && (!terms.length || terms.every((t) => `${r.ruleId} ${r.title} ${r.groupName || ''} ${r.module} ${r.domain || ''}`.toLowerCase().includes(t))));
  }, [catalogue, search, moduleFilter]);

  if (!open) return null;

  const toggle = (r, source = 'manual') => setPicked((cur) => {
    const next = new Map(cur);
    if (next.has(r.ruleId)) next.delete(r.ruleId); else next.set(r.ruleId, source);
    return next;
  });
  const addAll = (rules, source) => setPicked((cur) => {
    const next = new Map(cur);
    for (const r of rules) if (!next.has(r.ruleId)) next.set(r.ruleId, source);
    return next;
  });
  const removeAll = (rules) => setPicked((cur) => {
    const next = new Map(cur);
    for (const r of rules) next.delete(r.ruleId);
    return next;
  });

  const nameErr = !name.trim() ? 'Give the dimension a name.' : '';
  const descErr = !description.trim() ? 'Describe what the dimension covers.' : '';
  const detailsOk = !nameErr && !descErr;

  const go = (n) => {
    /* A message belongs to the step it was raised on. */
    setErr('');
    if (n > 1 && !detailsOk && !readOnly) { setTouched(true); setStep(1); return; }
    setStep(n);
    setReached((r) => Math.max(r, n));
  };

  const runMatch = async () => {
    setBusy('match'); setErr('');
    try {
      const m = Object.fromEntries(Object.entries(matcher).filter(([, v]) => String(v).trim())
        .map(([k, v]) => [k, String(v).split(',').map((x) => x.trim()).filter(Boolean)]));
      if (!Object.keys(m).length) { setErr('Fill at least one field to match on.'); return; }
      setMatched((await api.post('/health/dimensions/match', { matcher: m })).rules || []);
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  const runAi = async () => {
    setBusy('ai'); setErr(''); setAi(null);
    try {
      const r = await api.post('/health/dimensions/suggest', { name, description });
      setAi({ ...r, keep: new Set(r.rules.map((x) => x.ruleId)) });
    } catch (e) {
      setErr(e.message || 'Unable to generate AI suggestions.');
    } finally { setBusy(''); }
  };

  const save = async () => {
    if (!detailsOk) { setTouched(true); setStep(1); return; }
    setBusy('save'); setErr('');
    const body = { name, description, rules: [...picked].map(([ruleId, source]) => ({ ruleId, source })) };
    try {
      const r = dimensionId
        ? await api.patch(`/health/dimensions/${encodeURIComponent(dimensionId)}`, body)
        : await api.post('/health/dimensions', body);
      toast.success(`Saved “${r.dimension.name}” — ${r.dimension.rule_count} rule${r.dimension.rule_count === 1 ? '' : 's'}.`);
      onSaved?.(r.dimension);
      onClose?.();
    } catch (e) {
      setErr(`Dimension could not be saved. ${e.message}`);
    } finally { setBusy(''); }
  };

  const pickedRules = [...picked.keys()].map((id) => byRule.get(id) || { ruleId: id, title: id });
  const title = readOnly ? (loaded?.name || 'Dimension') : dimensionId ? 'Edit dimension' : 'Create dimension';

  /* ── Step bodies ───────────────────────────────────────────────────── */

  const details = (
    <div className="hx-step">
      <h3 className="hx-step-title">Dimension details</h3>
      <p className="hx-step-sub">Give your dimension a clear name and description. This helps you and others understand what it covers.</p>
      <label className="hx-field">
        <span className="hx-label">Dimension name <em>*</em></span>
        <input className={`input hx-input${touched && nameErr ? ' is-bad' : ''}`} value={name} maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)} placeholder="e.g. Executive Ownership Gaps" autoFocus />
        <span className="hx-field-foot">{touched && nameErr ? <span className="error-text">{nameErr}</span> : <span />}<span>{name.length}/{NAME_MAX}</span></span>
      </label>
      <label className="hx-field">
        <span className="hx-label">Description <em>*</em></span>
        <textarea className={`textarea hx-input${touched && descErr ? ' is-bad' : ''}`} value={description} maxLength={DESCRIPTION_MAX} rows={5}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Which kind of problem this dimension collects — e.g. records where ownership or accountability is missing or assigned to the wrong party." />
        <span className="hx-field-foot">{touched && descErr ? <span className="error-text">{descErr}</span> : <span />}<span>{description.length}/{DESCRIPTION_MAX}</span></span>
      </label>
      <div className="hx-note">
        <DimensionIcon name="info" size={16} />
        <span>Dimensions are global: a rule means the same thing on every instance, so this dimension applies wherever its rules produce findings.</span>
      </div>
    </div>
  );

  const selectedPanel = (
    <div className="hx-picked">
      <div className="hx-picked-head">
        <span>Rules in this dimension <b>{picked.size}</b></span>
        {picked.size > 0 && !readOnly && <button type="button" className="hx-link" onClick={() => setPicked(new Map())}>Clear all</button>}
      </div>
      {pickedRules.length === 0 ? (
        <p className="hx-muted">No rules chosen yet. A dimension with no rules shows no findings.</p>
      ) : (
        <ul className="hx-chiplist">
          {pickedRules.map((r) => (
            <li key={r.ruleId} className="hx-rchip" title={r.title}>
              <code>{r.ruleId}</code>
              <span className="hx-rchip-src">{SOURCE_LABEL[picked.get(r.ruleId)] || picked.get(r.ruleId)}</span>
              {!readOnly && (
                <button type="button" onClick={() => toggle(r)} aria-label={`Remove ${r.ruleId}`}><DimensionIcon name="x" size={12} /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="hx-preview" aria-live="polite">
        {preview?.error
          ? <span className="error-text">Preview unavailable: {preview.error}</span>
          : preview && (
            <><b>{preview.findings.toLocaleString()}</b> finding{preview.findings === 1 ? '' : 's'} in the current view
              {preview.findings > 0 && <span className="hx-muted"> — {bands.filter((b) => preview.severity[b.key]).map((b) => `${b.label} ${preview.severity[b.key].toLocaleString()}`).join(' · ')}</span>}
            </>
          )}
      </div>
    </div>
  );

  const defineRules = (
    <div className="hx-step">
      <h3 className="hx-step-title">Define rules</h3>
      <p className="hx-step-sub">Choose the rules whose findings belong in this dimension. Every finding those rules produce will appear under it.</p>
      <div className="hx-methods" role="tablist" aria-label="How to add rules">
        {METHODS.map((m) => (
          <button key={m.key} type="button" role="tab" aria-selected={method === m.key}
            className={`hx-method${method === m.key ? ' is-on' : ''}`} onClick={() => { setMethod(m.key); setErr(''); }}>
            <span className="hx-method-ic"><DimensionIcon name={m.icon} size={18} /></span>
            <span><b>{m.title}</b><em>{m.sub}</em></span>
          </button>
        ))}
      </div>
      {catErr && <p className="error-text">{catErr}</p>}

      {method === 'select' && (
        <div className="hx-method-body">
          <div className="hx-rtools">
            <label className="hx-search">
              <DimensionIcon name="search" size={15} />
              <input type="search" className="input" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search rules — ID, title, group, module or domain" aria-label="Search rules" />
            </label>
            <select className="select hx-select" value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)} aria-label="Filter rules by module">
              {MODULES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="hx-rtools-sub">
            <span>{filtered.length.toLocaleString()} of {catalogue.length.toLocaleString()} rules{filtered.length > RULES_SHOWN ? ` · first ${RULES_SHOWN} shown — narrow the search to see more` : ''}</span>
            <span>
              <button type="button" className="hx-link" onClick={() => addAll(filtered.slice(0, RULES_SHOWN), 'manual')} disabled={!filtered.length}>Select shown</button>
              <button type="button" className="hx-link" onClick={() => removeAll(filtered.slice(0, RULES_SHOWN))} disabled={!filtered.length}>Clear shown</button>
            </span>
          </div>
          {filtered.length === 0 ? <p className="hx-muted">No rule matches that search.</p> : (
            <ul className="hx-rlist">
              {filtered.slice(0, RULES_SHOWN).map((r) => (
                <RuleRow key={r.ruleId} r={r} checked={picked.has(r.ruleId)} onToggle={(x) => toggle(x, 'manual')} />
              ))}
            </ul>
          )}
        </div>
      )}

      {method === 'match' && (
        <div className="hx-method-body">
          <p className="hx-fine">Match rules by their definition. Separate several values with commas; every field you fill must match.</p>
          <div className="hx-form2">
            <label className="hx-field"><span className="hx-label">Module</span>
              <select className="select hx-input" value={matcher.module} onChange={(e) => setMatcher({ ...matcher, module: e.target.value })}>
                {MODULES.map(([k, l]) => <option key={k} value={k}>{k ? l : 'Any'}</option>)}
              </select>
            </label>
            <label className="hx-field"><span className="hx-label">Rule ID prefix</span>
              <input className="input hx-input" value={matcher.prefix} placeholder="CMDB-, MID-" onChange={(e) => setMatcher({ ...matcher, prefix: e.target.value })} />
            </label>
            <label className="hx-field"><span className="hx-label">Group</span>
              <input className="input hx-input" value={matcher.group} placeholder="Ownership" onChange={(e) => setMatcher({ ...matcher, group: e.target.value })} />
            </label>
            <label className="hx-field"><span className="hx-label">CMDB quality dimension (D1–D10)</span>
              <select className="select hx-input" value={matcher.qualityDimension} onChange={(e) => setMatcher({ ...matcher, qualityDimension: e.target.value })}>
                <option value="">Any</option>
                {QUALITY_DIMENSIONS.map(([k, l]) => <option key={k} value={k}>{k} · {l}</option>)}
              </select>
            </label>
            <label className="hx-field"><span className="hx-label">Domain</span>
              <input className="input hx-input" value={matcher.domain} placeholder="INCIDENT, MID_SERVER" onChange={(e) => setMatcher({ ...matcher, domain: e.target.value })} />
            </label>
            <label className="hx-field"><span className="hx-label">Source table</span>
              <input className="input hx-input" value={matcher.sourceTable} placeholder="cmdb_ci" onChange={(e) => setMatcher({ ...matcher, sourceTable: e.target.value })} />
            </label>
            <label className="hx-field hx-span2"><span className="hx-label">Words in the rule</span>
              <input className="input hx-input" value={matcher.keyword} placeholder="owner" onChange={(e) => setMatcher({ ...matcher, keyword: e.target.value })} />
            </label>
          </div>
          <div className="hx-actions-row">
            <button type="button" className="btn" onClick={runMatch} disabled={busy === 'match'}>
              <DimensionIcon name="search" size={15} /> {busy === 'match' ? 'Matching…' : 'Find matching rules'}
            </button>
            {matched?.length > 0 && <button type="button" className="btn ghost" onClick={() => addAll(matched, 'matcher')}>Add all {matched.length}</button>}
            <button type="button" className="hx-link" onClick={() => { setMatcher(EMPTY_MATCHER); setMatched(null); }}>Reset</button>
          </div>
          {matched && (matched.length === 0
            ? <p className="hx-muted">No rule matches — loosen a field.</p>
            : <ul className="hx-rlist">{matched.map((r) => <RuleRow key={r.ruleId} r={r} checked={picked.has(r.ruleId)} onToggle={(x) => toggle(x, 'matcher')} />)}</ul>)}
        </div>
      )}

      {method === 'ai' && (
        <div className="hx-method-body">
          <div className="hx-note hx-note-ai">
            <DimensionIcon name="shield" size={16} />
            <span>
              The model reads only the rule catalogue — rule IDs, titles and what each rule means — and your dimension name
              and description. It never sees your findings or records. Its suggestions are checked against the catalogue,
              and nothing is saved until you review them and press Save.
            </span>
          </div>
          <div className="hx-actions-row">
            <button type="button" className="btn" onClick={runAi} disabled={busy === 'ai' || (!name.trim() && !description.trim())}>
              <DimensionIcon name="sparkles" size={15} /> {busy === 'ai' ? 'Asking the model…' : 'Suggest rules with AI'}
            </button>
            {!name.trim() && !description.trim() && <span className="hx-muted">Add a name or description in step 1 first.</span>}
          </div>
          {ai && (
            <div className="hx-ai">
              <p className="hx-fine">{ai.label}</p>
              {ai.suggestedName && ai.suggestedName !== name && (
                <div className="hx-suggest"><span>Suggested name</span><b>{ai.suggestedName}</b>
                  <button type="button" className="btn ghost sm" onClick={() => setName(ai.suggestedName)}>Use it</button></div>
              )}
              {ai.suggestedDescription && ai.suggestedDescription !== description && (
                <div className="hx-suggest"><span>Suggested description</span><p>{ai.suggestedDescription}</p>
                  <button type="button" className="btn ghost sm" onClick={() => setDescription(ai.suggestedDescription)}>Use it</button></div>
              )}
              {ai.rules.length === 0 ? (
                <p className="hx-muted">The model found no rule that fits. Try a more specific description, or choose rules yourself.</p>
              ) : (
                <>
                  <ul className="hx-rlist">
                    {ai.rules.map((r) => (
                      <RuleRow key={r.ruleId} r={r} checked={ai.keep.has(r.ruleId)} reason={r.reason}
                        onToggle={(x) => setAi((cur) => { const keep = new Set(cur.keep); if (keep.has(x.ruleId)) keep.delete(x.ruleId); else keep.add(x.ruleId); return { ...cur, keep }; })} />
                    ))}
                  </ul>
                  <div className="hx-actions-row">
                    <button type="button" className="btn" onClick={() => addAll(ai.rules.filter((r) => ai.keep.has(r.ruleId)), 'ai')} disabled={ai.keep.size === 0}>
                      Add {ai.keep.size} kept rule{ai.keep.size === 1 ? '' : 's'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {selectedPanel}
    </div>
  );

  const sevTotal = preview && !preview.error ? preview.findings : 0;
  const review = (
    <div className="hx-step">
      <h3 className="hx-step-title">Review</h3>
      <p className="hx-step-sub">Check what will be saved. Existing findings appear under the dimension the moment it is saved — none of them is changed.</p>
      <div className="hx-review">
        <div className="hx-review-row"><span>Dimension name</span><b>{name || '—'}</b></div>
        <div className="hx-review-row"><span>Description</span><p>{description || '—'}</p></div>
        <div className="hx-review-stats">
          <div><b>{picked.size}</b><span>Rules selected</span></div>
          <div><b>{preview && !preview.error ? preview.findings.toLocaleString() : '…'}</b><span>Findings in the current view</span></div>
        </div>
        {sevTotal > 0 && (
          <div className="hx-review-sev">
            <span className="hx-label">Severity distribution</span>
            <span className="hx-seg-bar hx-seg-bar-lg">
              {bands.map((b) => (preview.severity[b.key] ? <i key={b.key} className={`tone-${b.tone}`} style={{ flexGrow: preview.severity[b.key] }} /> : null))}
            </span>
            <span className="hx-legend-inline">
              {bands.map((b) => <span key={b.key} className={`tone-${b.tone}`}><i />{b.label} {(preview.severity[b.key] || 0).toLocaleString()}</span>)}
            </span>
          </div>
        )}
        <div className="hx-review-rules">
          <span className="hx-label">Rules included</span>
          {pickedRules.length === 0 ? <p className="hx-muted">No rules — the dimension will show no findings until you add some.</p> : (
            <ul className="hx-rlist hx-rlist-ro">
              {pickedRules.map((r) => (
                <li key={r.ruleId} className="hx-rrow"><span className="hx-rrow-main">
                  <span className="hx-rrow-top"><code>{r.ruleId}</code><span className="hx-rrow-title">{r.title}</span>
                    <span className="hx-rchip-src">{SOURCE_LABEL[picked.get(r.ruleId)]}</span></span>
                </span></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );

  /* ── Read-only view of a built-in or the fallback ──────────────────── */
  const viewBody = loaded && (
    <div className="hx-step">
      <div className="hx-view-head">
        <DimensionTile dimension={loaded} size="lg" />
        <div>
          <h3 className="hx-step-title">{loaded.name} <TypeBadge type={loaded.type} /></h3>
          <p className="hx-step-sub">{loaded.description}</p>
        </div>
      </div>
      <div className="hx-note">
        <DimensionIcon name="info" size={16} />
        <span>
          {loaded.type === 'system'
            ? 'Unclassified holds every rule no dimension claims — including rules added after the taxonomy was reviewed. Their findings work exactly as any other.'
            : 'System dimensions are part of the product taxonomy and cannot be edited. Create a custom dimension to group rules your own way.'}
        </span>
      </div>
      <div className="hx-picked-head"><span>Rules in this dimension <b>{loaded.rules.length}</b></span></div>
      {loaded.rules.length === 0 ? <p className="hx-muted">No rules.</p> : (
        <ul className="hx-rlist hx-rlist-ro">
          {loaded.rules.map((r) => (
            <li key={r.ruleId} className="hx-rrow"><span className="hx-rrow-main">
              <span className="hx-rrow-top"><code>{r.ruleId}</code><span className="hx-rrow-title">{r.title}</span></span>
              <span className="hx-rrow-meta">{[r.module?.toUpperCase(), r.groupName].filter(Boolean).join(' · ')}</span>
            </span></li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="hx-modal" role="presentation">
      <div className="hx-modal-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="hx-modal-panel" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panelRef}>
        <header className="hx-modal-head">
          <h2>{title}</h2>
          <button type="button" className="hx-modal-x" onClick={onClose} aria-label="Close"><DimensionIcon name="x" size={18} /></button>
        </header>

        {readOnly ? (
          <div className="hx-modal-main hx-modal-main-solo">{viewBody || <p className="hx-muted">{err || 'Loading…'}</p>}</div>
        ) : (
          <div className="hx-modal-main">
            <nav className="hx-stepper" aria-label="Steps">
              <ol>
                {STEPS.map((s) => {
                  const done = s.key < step;
                  return (
                    <li key={s.key} className={`hx-stepper-item ${step === s.key ? 'is-active' : done ? 'is-done' : ''}`}>
                      <button type="button" onClick={() => (s.key <= reached ? go(s.key) : null)} disabled={s.key > reached} aria-current={step === s.key ? 'step' : undefined}>
                        <span className="hx-stepper-n">{done ? <DimensionIcon name="check" size={14} strokeWidth={2.4} /> : s.key}</span>
                        <span className="hx-stepper-t"><b>{s.title}</b><em>{s.sub}</em></span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              <div className="hx-tip">
                <DimensionIcon name="bulb" size={16} />
                <div><b>Tip</b><p>Be specific in the description. You can add rules by hand, match them by metadata, or get AI suggestions in the next step.</p></div>
              </div>
            </nav>
            <div className="hx-modal-body">
              {err && <p className="error-text">{err}</p>}
              {step === 1 && details}
              {step === 2 && defineRules}
              {step === 3 && review}
            </div>
          </div>
        )}

        <footer className="hx-modal-foot">
          {readOnly ? (
            <>
              <button type="button" className="btn ghost" onClick={onClose}>Close</button>
              {loaded && onViewFindings && (
                <button type="button" className="btn primary" onClick={() => { onViewFindings(loaded.id); onClose?.(); }}>
                  View findings <DimensionIcon name="arrowRight" size={15} />
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={onClose} disabled={busy === 'save'}>Cancel</button>
              <span className="hx-foot-right">
                {step > 1 && <button type="button" className="btn" onClick={() => go(step - 1)} disabled={busy === 'save'}><DimensionIcon name="arrowLeft" size={15} /> Back</button>}
                {step < 3
                  ? <button type="button" className="btn primary" onClick={() => go(step + 1)}>Next <DimensionIcon name="arrowRight" size={15} /></button>
                  : <button type="button" className="btn primary" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save dimension'}</button>}
              </span>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
