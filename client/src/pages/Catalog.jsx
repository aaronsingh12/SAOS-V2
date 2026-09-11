import { useEffect, useState } from 'react';
import DataTable from '../components/DataTable.jsx';
import RecordDrawer from '../components/RecordDrawer.jsx';
import { api, val, disp } from '../api.js';
import ReferenceField, { TableField } from '../components/ReferenceField.jsx';
import VariableEditor from '../components/VariableEditor.jsx';
import PolicyBuilder from '../components/PolicyBuilder.jsx';
import { confirmDestructive, CONSEQUENCE } from '../components/confirm.js';
import { toast } from '../components/toast.js';
import { SkeletonRows, LoadingRegion, EmptyState } from '../components/states.jsx';
import ScopeBadge from '../components/ScopeBadge.jsx';
import { useScopeLabels } from '../hooks/useScopeLabels.js';

const CHOICE_TYPES = [3, 5, 18, 22];
const REF_TYPES = [8, 21];

/* ── Shared variable builder ── */
/* Columns for the three catalog lists. `text` sorts and filters; `cell`
   only draws, so the badges stay badges while sorting compares real values. */
const itemColumns = (itemScopes) => [
  { key: 'name', header: 'Name', width: 300, text: (r) => disp(r, 'name') },
  { key: 'class', header: 'Class', width: 190, text: (r) => val(r, 'sys_class_name'),
    cell: (r) => <span className="mono" style={{ fontSize: 11 }}>{val(r, 'sys_class_name')}</span> },
  { key: 'scope', header: 'Scope', width: 160, text: (r) => disp(r, 'sys_scope'),
    cell: (r) => <ScopeBadge scope={itemScopes[val(r, 'sys_scope')] || val(r, 'sys_scope')} name={disp(r, 'sys_scope')} /> },
  { key: 'active', header: 'Active', width: 110, text: (r) => (val(r, 'active') === 'true' ? 'active' : 'off'),
    cell: (r) => <span className={`badge ${val(r, 'active') === 'true' ? 'green' : ''}`}>{val(r, 'active') === 'true' ? 'active' : 'off'}</span> },
];

const SET_COLUMNS = [
  { key: 'title', header: 'Title', width: 320, text: (r) => disp(r, 'title') },
  { key: 'internal', header: 'Internal name', width: 260, text: (r) => disp(r, 'internal_name'),
    cell: (r) => <span className="mono" style={{ fontSize: 11 }}>{disp(r, 'internal_name')}</span> },
];

const GUIDE_COLUMNS = [
  { key: 'name', header: 'Name', width: 320, text: (r) => disp(r, 'name') },
  { key: 'two_step', header: 'Two-step', width: 130, text: (r) => (val(r, 'two_step') === 'true' ? 'yes' : 'no') },
  { key: 'active', header: 'Active', width: 120, text: (r) => (val(r, 'active') === 'true' ? 'active' : 'off'),
    cell: (r) => <span className={`badge ${val(r, 'active') === 'true' ? 'green' : ''}`}>{val(r, 'active') === 'true' ? 'active' : 'off'}</span> },
];

function VariableForm({ types, onSubmit, busy }) {
  const [v, setV] = useState({ name: '', question_text: '', type: '6', mandatory: false, order: 100, refTable: null, choicesText: '' });
  const typeCode = Number(v.type);
  const submit = () => {
    const payload = {
      name: v.name,
      question_text: v.question_text || v.name,
      type: typeCode,
      mandatory: v.mandatory,
      order: v.order,
      reference_table: v.refTable?.id || '',
      choices: v.choicesText
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [text, value] = l.split('|').map((s) => s.trim());
          return { text, value: value || undefined };
        }),
    };
    onSubmit(payload, () => setV({ name: '', question_text: '', type: '6', mandatory: false, order: 100, refTable: null, choicesText: '' }));
  };
  return (
    <div>
      <div className="grid2">
        <div className="field">
          <label className="label">Internal name</label>
          <input className="input mono" placeholder="laptop_model" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Question text</label>
          <input className="input" placeholder="Which laptop model?" value={v.question_text} onChange={(e) => setV({ ...v, question_text: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Type</label>
          <select className="select" value={v.type} onChange={(e) => setV({ ...v, type: e.target.value })}>
            {types.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label">Order</label>
          <input className="input" type="number" value={v.order} onChange={(e) => setV({ ...v, order: Number(e.target.value) })} />
        </div>
      </div>
      {REF_TYPES.includes(typeCode) && (
        <div className="field">
          <label className="label">{typeCode === 21 ? 'List collector table' : 'Reference table'}</label>
          <TableField value={v.refTable} onChange={(t) => setV({ ...v, refTable: t })} />
        </div>
      )}
      {CHOICE_TYPES.includes(typeCode) && (
        <div className="field">
          <label className="label">Choices — one per line, "Display text | value"</label>
          <textarea className="textarea mono" placeholder={'MacBook Pro 14 | mbp14\nThinkPad X1 | x1'} value={v.choicesText} onChange={(e) => setV({ ...v, choicesText: e.target.value })} />
        </div>
      )}
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={v.mandatory} onChange={(e) => setV({ ...v, mandatory: e.target.checked })} /> Mandatory
        </label>
        <button className="btn primary sm" onClick={submit} aria-busy={busy} disabled={busy || !v.name}>Add variable</button>
      </div>
    </div>
  );
}

function VariableTable({ variables, typeLabel, onDelete }) {
  if (!variables?.length) {
    return <EmptyState title="No variables on this item yet." hint="Add one below — every variable type this instance actually supports is offered, read from its dictionary." />;
  }
  return (
    <table className="table">
      <thead><tr><th>Ord</th><th>Name</th><th>Question</th><th>Type</th><th>Ref</th><th /></tr></thead>
      <tbody>
        {variables.map((v) => (
          <tr key={val(v, 'sys_id')}>
            <td className="mono">{disp(v, 'order')}</td>
            <td className="mono">{disp(v, 'name')}</td>
            <td>{disp(v, 'question_text')}{val(v, 'mandatory') === 'true' && <span className="badge amber" style={{ marginLeft: 6 }}>req</span>}</td>
            <td>{typeLabel(val(v, 'type'))}</td>
            <td className="mono">{disp(v, 'reference') || disp(v, 'list_table') || '—'}</td>
            <td>{onDelete && <button className="btn danger sm" onClick={() => onDelete(val(v, 'sys_id'))}>✕</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ── Items tab ── */
function ItemsTab({ meta, categories, catalogs, typeLabel, openItemId, onOpened, onCategoriesChanged }) {
  const [items, setItems] = useState([]);
  const itemScopes = useScopeLabels(items.map((r) => val(r, 'sys_scope')));
  /* Still read by load(), so the request shape is unchanged; nothing writes it
     now that the search field is gone. */
  const [search] = useState('');
  const [selected, setSelected] = useState(null); // deep view
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', short_description: '', description: '', category: '', catalog: '' });
  const [sets, setSets] = useState([]);
  const [attachSet, setAttachSet] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [itemTab, setItemTab] = useState('variables');
  const [loading, setLoading] = useState(true);
  const [newCategory, setNewCategory] = useState(null);

  const load = () => {
    setLoading(true);
    return api.get(`/catalog/items?search=${encodeURIComponent(search)}`)
      .then(setItems)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); api.get('/catalog/variable-sets').then(setSets).catch(() => {}); /* eslint-disable-next-line */ }, []);

  // The producers tab hands an item over rather than duplicating the editor —
  // a record producer IS a catalog item, so managing its variables should not
  // mean finding it again by hand.
  useEffect(() => {
    if (!openItemId) return;
    openItem(openItemId);
    onOpened?.();
    /* eslint-disable-next-line */
  }, [openItemId]);

  const openItem = (sysId) => {
    setError('');
    api.get(`/catalog/items/${sysId}`).then(setSelected).catch((e) => setError(e.message));
  };

  const createItem = async () => {
    setBusy(true); setError('');
    try {
      const payload = { name: draft.name, short_description: draft.short_description, description: draft.description };
      if (draft.category) payload.category = draft.category;
      if (draft.catalog) payload.sc_catalogs = draft.catalog;
      const r = await api.post('/catalog/items', payload);
      setCreating(false);
      setDraft({ name: '', short_description: '', description: '', category: '', catalog: '' });
      load();
      openItem(val(r, 'sys_id'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const addVariable = async (payload, reset) => {
    setBusy(true); setError('');
    try {
      await api.post(`/catalog/items/${val(selected.item, 'sys_id')}/variables`, payload);
      reset();
      openItem(val(selected.item, 'sys_id'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const reload = () => openItem(val(selected.item, 'sys_id'));

  /** C-3: an item that cannot be switched off has to be deleted to be retired. */
  const toggleActive = async () => {
    const id = val(selected.item, 'sys_id');
    const next = val(selected.item, 'active') !== 'true';
    setBusy(true); setError('');
    try {
      await api.patch(`/catalog/items/${id}`, { active: String(next) });
      reload(); load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const createCategory = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/catalog/categories', { title: newCategory.title, sc_catalog: newCategory.sc_catalog });
      setNewCategory(null);
      onCategoriesChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const doAttach = async () => {
    if (!attachSet) return;
    setBusy(true); setError('');
    try {
      await api.post(`/catalog/variable-sets/${attachSet}/attach`, { cat_item: val(selected.item, 'sys_id') });
      setAttachSet('');
      openItem(val(selected.item, 'sys_id'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const deleteItem = async () => {
    const id = val(selected.item, 'sys_id');
    const ok = await confirmDestructive({
      action: 'Delete catalog item', subject: disp(selected.item, 'name'), sysId: id, detail: CONSEQUENCE.item,
    });
    if (!ok) return;
    try {
      await api.del(`/catalog/items/${id}`);
      setSelected(null); load();
      toast.success(`Deleted catalog item "${disp(selected.item, 'name')}".`);
    } catch (e) { setError(e.message); toast.error(e.message); }
  };

  return (
    <div className="page-full">
      {/* The toolbar card that used to stand here permanently — a heading, the
          New item button and a "Search items…" field — is gone. The heading and
          the button are the table's own header now, and the table's filter is
          the search. What is left is the create form, and it is only on screen
          while you are actually creating something. */}
      {creating && (
        <div className="card">
          <div className="card-title">New catalog item</div>
          <div className="field"><label className="label">Name</label>
            <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div className="field"><label className="label">Short description</label>
            <input className="input" value={draft.short_description} onChange={(e) => setDraft({ ...draft, short_description: e.target.value })} /></div>
          <div className="grid2">
            <div className="field">
              <div className="spread">
                <label className="label">Category</label>
                <button className="rail-btn" type="button"
                  onClick={() => setNewCategory(newCategory ? null : { title: '', sc_catalog: catalogs[0]?.sys_id || '' })}>
                  {newCategory ? 'cancel' : '+ new category'}
                </button>
              </div>
              <select className="select" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                <option value="">—</option>
                {categories.map((c) => <option key={val(c, 'sys_id')} value={val(c, 'sys_id')}>{disp(c, 'title')}</option>)}
              </select></div>
            <div className="field"><label className="label">Catalog</label>
              <select className="select" value={draft.catalog} onChange={(e) => setDraft({ ...draft, catalog: e.target.value })}>
                <option value="">—</option>
                {catalogs.map((c) => <option key={c.sys_id} value={c.sys_id}>{c.title}</option>)}
              </select></div>
          </div>
          {newCategory && (
            <div className="policy-card" style={{ marginBottom: 10 }}>
              <div className="field">
                <label className="label">New category title</label>
                <input className="input" value={newCategory.title} onChange={(e) => setNewCategory({ ...newCategory, title: e.target.value })} />
              </div>
              <div className="field">
                <label className="label">In catalog</label>
                <select className="select" value={newCategory.sc_catalog} onChange={(e) => setNewCategory({ ...newCategory, sc_catalog: e.target.value })}>
                  {catalogs.map((c) => <option key={c.sys_id} value={c.sys_id}>{c.title}</option>)}
                </select>
              </div>
              <button className="btn sm" onClick={createCategory} aria-busy={busy} disabled={busy || !newCategory.title}>Create category</button>
            </div>
          )}
          <button className="btn primary sm" onClick={createItem} aria-busy={busy} disabled={busy || !draft.name}>Create item</button>
        </div>
      )}

      {/* The catalog list, full width, with no column reserved beside it.
          openItem() is untouched — it still fetches the deep view. */}
      <DataTable
        title="Catalog items"
        action={(
          <button className="btn primary sm" onClick={() => setCreating(!creating)}>
            {creating ? 'Cancel' : 'New item'}
          </button>
        )}
        rows={items}
        loading={loading}
        error={error}
        getRowId={(r) => val(r, 'sys_id')}
        activeId={selected ? val(selected.item, 'sys_id') : null}
        onRowClick={(r) => openItem(val(r, 'sys_id'))}
        selectable
        filterPlaceholder="Filter loaded items…"
        empty="No catalog items match."
        columns={itemColumns(itemScopes)}
      />

      {/* The deep view — variables, choices, policies — in a drawer. */}
      <RecordDrawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? disp(selected.item, 'name') : 'Catalog item'}
        width={640}
      >
        {selected && (
          <>
            <div className="spread">
              <h3 style={{ fontSize: 16 }}>{disp(selected.item, 'name')}</h3>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" onClick={toggleActive} aria-busy={busy} disabled={busy}>
                  {val(selected.item, 'active') === 'true' ? 'Deactivate' : 'Activate'}
                </button>
                <button className="btn danger sm" onClick={deleteItem}>Delete item</button>
              </div>
            </div>
            <p style={{ color: 'var(--muted)', marginTop: 4 }}>{disp(selected.item, 'short_description')}</p>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className={`badge ${val(selected.item, 'active') === 'true' ? 'green' : ''}`}>
                {val(selected.item, 'active') === 'true' ? 'active' : 'inactive'}
              </span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>sys_id {val(selected.item, 'sys_id')}</span>
            </div>

            <div className="tabs" style={{ marginBottom: 12 }}>
              <button className={`tab ${itemTab === 'variables' ? 'active' : ''}`} onClick={() => setItemTab('variables')}>Variables</button>
              <button className={`tab ${itemTab === 'policies' ? 'active' : ''}`} onClick={() => setItemTab('policies')}>UI policies</button>
              <button className={`tab ${itemTab === 'sets' ? 'active' : ''}`} onClick={() => setItemTab('sets')}>Variable sets</button>
            </div>

            {itemTab === 'variables' && (
              <>
                <VariableEditor
                  catItemId={val(selected.item, 'sys_id')}
                  variables={selected.variables}
                  typeLabel={typeLabel}
                  onChanged={reload}
                />
                <div className="card-title" style={{ marginTop: 16 }}>Add variable</div>
                <VariableForm types={meta.variableTypes} onSubmit={addVariable} busy={busy} />
              </>
            )}

            {itemTab === 'policies' && (
              <PolicyBuilder catItemId={val(selected.item, 'sys_id')} meta={meta} />
            )}

            {itemTab === 'sets' && (
              <>
                {selected.variableSets.length === 0 && <div className="empty">No sets attached.</div>}
                {selected.variableSets.map((s) => (
                  <div key={val(s, 'sys_id')} style={{ marginBottom: 10 }}>
                    <div className="row"><span className="badge blue">{disp(s, 'title')}</span>
                      <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{disp(s, 'internal_name')}</span></div>
                    <VariableTable variables={s._variables} typeLabel={typeLabel} />
                  </div>
                ))}
                <div className="row">
                  <select className="select" style={{ maxWidth: 280 }} value={attachSet} onChange={(e) => setAttachSet(e.target.value)}>
                    <option value="">Attach existing set…</option>
                    {sets.map((s) => <option key={val(s, 'sys_id')} value={val(s, 'sys_id')}>{disp(s, 'title')}</option>)}
                  </select>
                  <button className="btn sm" onClick={doAttach} aria-busy={busy} disabled={!attachSet || busy}>Attach</button>
                </div>
              </>
            )}
          </>
        )}
      </RecordDrawer>
    </div>
  );
}

/* ── Variable sets tab ── */
function SetsTab({ meta, typeLabel }) {
  const [sets, setSets] = useState([]);
  const [selected, setSelected] = useState(null);
  const [vars, setVars] = useState([]);
  const [draft, setDraft] = useState({ title: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/catalog/variable-sets').then(setSets).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const loadSetVars = (setId) =>
    api.get(`/catalog/variable-sets/${setId}/variables`).then(setVars).catch(() => setVars([]));

  useEffect(() => { if (selected) loadSetVars(val(selected, 'sys_id')); /* eslint-disable-next-line */ }, [selected]);

  const create = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/catalog/variable-sets', draft);
      setDraft({ title: '', description: '' });
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const addVariable = async (payload, reset) => {
    setBusy(true); setError('');
    try {
      await api.post(`/catalog/variable-sets/${val(selected, 'sys_id')}/variables`, payload);
      reset();
      loadSetVars(val(selected, 'sys_id'));
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="page-full">
      <div className="card">
        <div className="card-title">Variable sets</div>
        <div className="field"><label className="label">Title</label>
          <input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
        <div className="field"><label className="label">Description</label>
          <input className="input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
        <button className="btn primary sm" onClick={create} aria-busy={busy} disabled={busy || !draft.title}>Create set</button>
      </div>

      <DataTable
        title="Variable sets"
        rows={sets}
        error={error}
        getRowId={(r) => val(r, 'sys_id')}
        activeId={selected ? val(selected, 'sys_id') : null}
        onRowClick={setSelected}
        filterPlaceholder="Filter sets…"
        empty="No variable sets yet."
        columns={SET_COLUMNS}
      />
      <RecordDrawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? disp(selected, 'title') : 'Variable set'}
        width={560}
      >
        {selected && (
          <>
            <div className="card-title">Variables in this set</div>
            <VariableTable variables={vars} typeLabel={typeLabel} />
            <div className="card-title" style={{ marginTop: 14 }}>Add variable</div>
            <VariableForm types={meta.variableTypes} onSubmit={addVariable} busy={busy} />
          </>
        )}
      </RecordDrawer>
    </div>
  );
}

/* ── Order guides tab ── */
function GuidesTab() {
  const [guides, setGuides] = useState([]);
  const [selected, setSelected] = useState(null);
  const [guideItems, setGuideItems] = useState([]);
  const [draft, setDraft] = useState({ name: '', short_description: '', two_step: true });
  const [addItem, setAddItem] = useState({ item: null, order: 100, condition: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/catalog/order-guides').then(setGuides).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const open = (g) => {
    setSelected(g); setError('');
    api.get(`/catalog/order-guides/${val(g, 'sys_id')}/items`).then(setGuideItems).catch((e) => { setGuideItems([]); setError(e.message); });
  };

  const create = async () => {
    setBusy(true); setError('');
    try { await api.post('/catalog/order-guides', draft); setDraft({ name: '', short_description: '', two_step: true }); load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const removeGuide = async (g) => {
    const ok = await confirmDestructive({
      action: 'Delete order guide', subject: disp(g, 'name'), sysId: val(g, 'sys_id'), detail: CONSEQUENCE.guide,
    });
    if (!ok) return;
    setError('');
    try {
      await api.del(`/catalog/order-guides/${val(g, 'sys_id')}`);
      if (selected && val(selected, 'sys_id') === val(g, 'sys_id')) setSelected(null);
      load();
    } catch (e) { setError(e.message); }
  };

  const addGuideItem = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/catalog/order-guides/${val(selected, 'sys_id')}/items`, {
        item: addItem.item?.id, order: addItem.order, condition: addItem.condition,
      });
      setAddItem({ item: null, order: 100, condition: '' });
      open(selected);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="page-full">
      <div className="card">
        <div className="card-title">Order guides</div>
        <div className="field"><label className="label">Name</label>
          <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
        <div className="field"><label className="label">Short description</label>
          <input className="input" value={draft.short_description} onChange={(e) => setDraft({ ...draft, short_description: e.target.value })} /></div>
        <label className="check" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={draft.two_step} onChange={(e) => setDraft({ ...draft, two_step: e.target.checked })} /> Two-step checkout
        </label>
        <button className="btn primary sm" onClick={create} aria-busy={busy} disabled={busy || !draft.name}>Create guide</button>
      </div>

      <DataTable
        title="Order guides"
        rows={guides}
        error={error}
        getRowId={(r) => val(r, 'sys_id')}
        activeId={selected ? val(selected, 'sys_id') : null}
        onRowClick={open}
        filterPlaceholder="Filter guides…"
        empty="No order guides yet."
        columns={GUIDE_COLUMNS}
      />
      <RecordDrawer
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? disp(selected, 'name') : 'Order guide'}
        width={560}
      >
        {selected && (
          <>
            <div className="spread">
              <span />
              <button className="btn danger sm" onClick={() => removeGuide(selected)}>Delete guide</button>
            </div>
            <div className="note warn" style={{ margin: '10px 0' }}>
              Rule-base entries write to <span className="mono">sc_cat_item_guide_items</span>. If adds fail on your
              release, verify the table name via Settings → table lookup and adjust GUIDE_RULE_TABLE in the server.
            </div>
            <div className="card-title">Included items</div>
            {guideItems.length === 0 && (
              <EmptyState title="This guide has no items." hint="Add one below — the guide orders them together as a rule base." />
            )}
            {guideItems.length > 0 && (
              <table className="table">
                <thead><tr><th>Ord</th><th>Item</th><th>Condition</th></tr></thead>
                <tbody>
                  {guideItems.map((gi) => (
                    <tr key={val(gi, 'sys_id')}>
                      <td className="mono">{disp(gi, 'order')}</td>
                      <td>{disp(gi, 'item')}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{disp(gi, 'condition') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="card-title" style={{ marginTop: 14 }}>Add item to guide</div>
            <div className="field"><label className="label">Catalog item</label>
              <ReferenceField table="sc_cat_item" value={addItem.item} onChange={(v) => setAddItem({ ...addItem, item: v })} /></div>
            <div className="grid2">
              <div className="field"><label className="label">Order</label>
                <input className="input" type="number" value={addItem.order} onChange={(e) => setAddItem({ ...addItem, order: Number(e.target.value) })} /></div>
              <div className="field"><label className="label">Condition (encoded query, optional)</label>
                <input className="input mono" value={addItem.condition} onChange={(e) => setAddItem({ ...addItem, condition: e.target.value })} /></div>
            </div>
            <button className="btn primary sm" onClick={addGuideItem} aria-busy={busy} disabled={busy || !addItem.item}>Add to guide</button>
          </>
        )}
      </RecordDrawer>
    </div>
  );
}

/* ── Record producers tab ── */

/* The producers list, in the shared column vocabulary. Actions live in their
   own unsortable column so a click on them never sorts the table. */
const producerColumns = (onOpenItem, onRemove) => [
  { key: 'name', header: 'Name', width: 280, text: (p) => disp(p, 'name') },
  { key: 'table', header: 'Target table', width: 220, text: (p) => disp(p, 'table_name'),
    cell: (p) => <span className="mono" style={{ fontSize: 11.5 }}>{disp(p, 'table_name')}</span> },
  { key: 'active', header: 'Active', width: 110, text: (p) => (val(p, 'active') === 'true' ? 'active' : 'off'),
    cell: (p) => <span className={`badge ${val(p, 'active') === 'true' ? 'green' : ''}`}>{val(p, 'active') === 'true' ? 'active' : 'off'}</span> },
  { key: 'actions', header: '', width: 210, sortable: false, text: () => '',
    cell: (p) => (
      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
        {/* A producer IS a catalog item, so managing its variables and
            policies is one click, not a second search. */}
        <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onOpenItem(val(p, 'sys_id')); }}>Variables &amp; policies</button>
        <button className="btn danger sm" onClick={(e) => { e.stopPropagation(); onRemove(p); }} aria-label="Delete producer">✕</button>
      </div>
    ) },
];
function ProducersTab({ onOpenItem }) {
  const [producers, setProducers] = useState([]);
  const [draft, setDraft] = useState({ name: '', table: null, short_description: '', script: '' });
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/catalog/record-producers').then(setProducers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const remove = async (p) => {
    const ok = await confirmDestructive({
      action: 'Delete record producer', subject: disp(p, 'name'), sysId: val(p, 'sys_id'), detail: CONSEQUENCE.producer,
    });
    if (!ok) return;
    setError('');
    try {
      await api.del(`/catalog/record-producers/${val(p, 'sys_id')}`); load();
      toast.success(`Deleted record producer "${disp(p, 'name')}".`);
    } catch (e) { setError(e.message); toast.error(e.message); }
  };

  const create = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post('/catalog/record-producers', {
        name: draft.name,
        table_name: draft.table?.id,
        short_description: draft.short_description,
        script: draft.script,
      });
      toast.success(`Created record producer "${disp(r, 'name')}" → ${draft.table?.id}`);
      setDraft({ name: '', table: null, short_description: '', script: '' });
      setCreating(false);
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="page-full">
      {/* Same shape as the Items tab: the form is a card only while you are
          creating one, and the list is the shared table. Nothing about create,
          delete or "Variables & policies" changed — only where they are drawn. */}
      {creating && (
        <div className="card">
          <div className="card-title">New record producer</div>
          <div className="field"><label className="label">Name</label>
            <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div className="field"><label className="label">Target table</label>
            <TableField value={draft.table} onChange={(t) => setDraft({ ...draft, table: t })} /></div>
          <div className="field"><label className="label">Short description</label>
            <input className="input" value={draft.short_description} onChange={(e) => setDraft({ ...draft, short_description: e.target.value })} /></div>
          <div className="field"><label className="label">Script (maps variables → record)</label>
            <textarea className="textarea mono" placeholder="current.short_description = producer.issue_summary;" value={draft.script} onChange={(e) => setDraft({ ...draft, script: e.target.value })} /></div>
          <button className="btn primary sm" onClick={create} aria-busy={busy} disabled={busy || !draft.name || !draft.table}>Create producer</button>
        </div>
      )}

      <DataTable
        title="Record producers"
        action={(
          <button className="btn primary sm" onClick={() => setCreating(!creating)}>
            {creating ? 'Cancel' : 'New producer'}
          </button>
        )}
        rows={producers}
        error={error}
        getRowId={(p) => val(p, 'sys_id')}
        filterPlaceholder="Filter producers…"
        empty="No record producers yet. A producer is a catalog item that creates a record on a table you choose."
        columns={producerColumns(onOpenItem, remove)}
      />
    </div>
  );
}

/* ── Page ── */
export default function Catalog() {
  const [tab, setTab] = useState('items');
  const [meta, setMeta] = useState({ variableTypes: [] });
  const [categories, setCategories] = useState([]);
  const [catalogs, setCatalogs] = useState([]);
  const [openItemId, setOpenItemId] = useState(null);

  const loadCategories = () => api.get('/catalog/categories').then(setCategories).catch(() => {});
  useEffect(() => {
    api.get('/catalog/meta').then(setMeta).catch(() => {});
    loadCategories();
    api.get('/catalog/catalogs').then(setCatalogs).catch(() => {});
  }, []);

  const openItem = (sysId) => { setOpenItemId(sysId); setTab('items'); };

  const typeLabel = (code) => meta.variableTypes.find((t) => String(t.code) === String(code))?.label || code;

  return (
    <div className="stack">
      <div className="tabs">
        <button className={`tab ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>Items & variables</button>
        <button className={`tab ${tab === 'sets' ? 'active' : ''}`} onClick={() => setTab('sets')}>Variable sets</button>
        <button className={`tab ${tab === 'guides' ? 'active' : ''}`} onClick={() => setTab('guides')}>Order guides</button>
        <button className={`tab ${tab === 'producers' ? 'active' : ''}`} onClick={() => setTab('producers')}>Record producers</button>
      </div>
      {/* The variable type codes come from the instance dictionary; when they
          could not be read the fallback list is stale enough to matter, so it
          is said rather than served quietly. */}
      {meta.variableTypeSource === 'fallback' && (
        <div className="note warn">
          Variable types could not be read from this instance ({meta.variableTypeFallbackReason}), so NowHelpAssist is
          showing its built-in list. Those codes drift between releases — spot-check any type you create.
        </div>
      )}
      {tab === 'items' && (
        <ItemsTab meta={meta} categories={categories} catalogs={catalogs} typeLabel={typeLabel}
          openItemId={openItemId} onOpened={() => setOpenItemId(null)} onCategoriesChanged={loadCategories} />
      )}
      {tab === 'sets' && <SetsTab meta={meta} typeLabel={typeLabel} />}
      {tab === 'guides' && <GuidesTab />}
      {tab === 'producers' && <ProducersTab onOpenItem={openItem} />}
    </div>
  );
}
