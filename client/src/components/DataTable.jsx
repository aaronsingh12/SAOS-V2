import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/*
 * THE SERVICENOW RECORD TABLE.
 *
 * One component behind every ServiceNow list, so sorting, filtering, paging,
 * selection and column resizing are implemented once rather than per page.
 *
 * HEADLESS BY CHOICE, AND NO NEW DEPENDENCY. The reference design is a
 * TanStack table in a card frame; TanStack is not in this project and the six
 * behaviours it would provide are, together, the ~180 lines below. Adding a
 * table library to get them would have been a dependency for something the app
 * can already express, and the brief asked for none unless truly necessary.
 * What IS taken from the reference is the shape: a card frame with a toolbar,
 * a clearly separated header, quiet rows, and a compact footer.
 *
 * IT OWNS NO DATA. Rows arrive as props, already fetched by the page's own
 * loader against its own endpoint. Sorting and filtering operate on what was
 * handed over — nothing here calls an API, and nothing here invents a record.
 *
 * COLUMNS
 *   key       stable id, also the resize/sort key
 *   header    column label
 *   text(r)   the plain-text value: what sorting compares and filtering matches
 *   cell(r)   optional JSX for display; falls back to text(r)
 *   width     starting px width
 *   sortable  default true
 *   align     'right' for numerics
 */

const SORT_CYCLE = { none: 'asc', asc: 'desc', desc: 'none' };

const Chevron = ({ dir }) => (
  <svg className={`dt-sort dt-sort-${dir}`} viewBox="0 0 24 24" width="11" height="11"
    fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">
    {dir === 'desc' ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
  </svg>
);

export default function DataTable({
  columns,
  rows = [],
  getRowId,
  onRowClick = null,
  activeId = null,
  loading = false,
  error = null,
  empty = null,
  title = null,
  toolbar = null,
  /* The card's PRIMARY action — New incident, New item, New producer. It sits
     on the title row, top-right, and its presence is what splits the header
     into two bands: identity and action above, controls below. Tables without
     one keep the single-row header they already had, so nothing else moves. */
  action = null,
  /* Row selection is opt-in: most of these lists are "click to open", and a
     checkbox column on a list nobody bulk-acts on is a column of noise. */
  selectable = false,
  onSelectionChange = null,
  filterPlaceholder = 'Filter records…',
  pageSize: initialPageSize = 12,
  className = '',
}) {
  const [sort, setSort] = useState({ key: null, dir: 'none' });
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [widths, setWidths] = useState({});
  // The checkbox column's rendered width, captured with the others on the
  // first drag — it has no key in `widths`, so it needs its own home.
  const checkW = useRef(38);
  const [selected, setSelected] = useState(() => new Set());
  const drag = useRef(null);

  const idOf = useCallback((r, i) => (getRowId ? getRowId(r) : String(i)), [getRowId]);
  const textOf = useCallback((col, r) => {
    const v = col.text ? col.text(r) : '';
    return v === null || v === undefined ? '' : String(v);
  }, []);

  /* Filter first, then sort, then slice: the count in the footer has to be the
     count of what the filter matched, not of everything fetched. */
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => columns.some((c) => textOf(c, r).toLowerCase().includes(q)));
  }, [rows, filter, columns, textOf]);

  const sorted = useMemo(() => {
    if (!sort.key || sort.dir === 'none') return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const x = textOf(col, a);
      const y = textOf(col, b);
      const nx = Number(x);
      const ny = Number(y);
      // Numeric columns compare as numbers so 10 sorts after 9, not before it.
      if (x !== '' && y !== '' && !Number.isNaN(nx) && !Number.isNaN(ny)) return (nx - ny) * dir;
      return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });
  }, [filtered, sort, columns, textOf]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => sorted.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [sorted, safePage, pageSize],
  );

  // A filter that shortens the list must not leave you stranded on page 9.
  useEffect(() => { setPage(0); }, [filter, pageSize, rows]);

  const toggleSort = (key) => setSort((cur) => (
    cur.key === key ? { key, dir: SORT_CYCLE[cur.dir] } : { key, dir: 'asc' }
  ));

  const toggleRow = (id) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      onSelectionChange?.([...next]);
      return next;
    });
  };
  const allOnPage = pageRows.length > 0 && pageRows.every((r, i) => selected.has(idOf(r, i)));
  const toggleAll = () => {
    setSelected((cur) => {
      const next = new Set(cur);
      pageRows.forEach((r, i) => (allOnPage ? next.delete(idOf(r, i)) : next.add(idOf(r, i))));
      onSelectionChange?.([...next]);
      return next;
    });
  };

  /*
   * Column resizing. Widths land in a <colgroup>, so a drag changes one column
   * and never reflows the row markup; the table keeps its own minimum width and
   * the wrapper scrolls horizontally, which is what keeps a wide table from
   * pushing the whole page sideways.
   */
  const startResize = (e, key, current) => {
    e.preventDefault();
    e.stopPropagation();
    /*
     * SEED EVERY COLUMN FROM WHAT IS ON SCREEN, on the first drag only.
     *
     * The table switches from proportional to absolute sizing the moment any
     * width is set (see the note below). Without this, the untouched columns
     * would jump from their rendered width to their declared one at the same
     * instant — measured: a column sitting at 180px snapped to 130px when a
     * different column was dragged. Capturing the current widths first means a
     * drag moves exactly the column under the cursor and nothing else.
     */
    const head = e.currentTarget.closest('thead');
    if (head && Object.keys(widths).length === 0) {
      const cells = [...head.querySelectorAll('th')];
      const offset = selectable ? 1 : 0;
      if (selectable && cells[0]) checkW.current = Math.round(cells[0].getBoundingClientRect().width);
      const seeded = {};
      columns.forEach((c, i) => {
        const th = cells[i + offset];
        if (th) seeded[c.key] = Math.round(th.getBoundingClientRect().width);
      });
      setWidths(seeded);
      current = seeded[key] ?? current;
    }
    drag.current = { key, startX: e.clientX, startW: current };
    const move = (ev) => {
      if (!drag.current) return;
      // Read the drag NOW, not inside the updater. React runs updaters later,
      // in a batch — and a quick drag ends (pointerup nulls the ref) before
      // the last pointermove's updater has run. Reading drag.current there
      // threw mid-render and took the whole page down with it.
      const { key, startX, startW } = drag.current;
      const w = Math.max(70, startW + (ev.clientX - startX));
      setWidths((cur) => ({ ...cur, [key]: w }));
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /*
   * WHY THE TABLE SWITCHES SIZING MODE ON FIRST RESIZE.
   *
   * At width:100% with table-layout:fixed the browser treats <col> widths as
   * ratios and rescales them to fill the container — measured: dragging a
   * 180px column +90px left it at 180px, because the others simply gave up
   * proportional room. Widths only become authoritative once the table stops
   * being told to fill.
   *
   * So: until someone drags, the table fills the card (the good default). From
   * the first drag it is sized to the sum of its columns, every width is
   * honoured exactly, and anything past the card scrolls inside .dt-scroll —
   * which is where a wide table is supposed to overflow.
   */
  const resized = Object.keys(widths).length > 0;
  const totalWidth = columns.reduce((n, c) => n + (widths[c.key] ?? c.width ?? 150), selectable ? checkW.current : 0);

  const from = sorted.length === 0 ? 0 : safePage * pageSize + 1;
  const to = Math.min(sorted.length, (safePage + 1) * pageSize);

  return (
    <section className={`dt ${className}`.trim()}>
      <header className={`dt-top${action ? ' dt-top-stacked' : ''}`}>
        {action && (
          <div className="dt-top-row dt-top-head">
            {title && <h2 className="dt-title">{title}</h2>}
            <div className="dt-action">{action}</div>
          </div>
        )}
        {!action && title && <h2 className="dt-title">{title}</h2>}
        {/* The filter and the page's own controls are one band. It is
            display:contents in a single-row header — so those tables lay out
            exactly as they always did — and a real flex row once the header
            stacks, which is what keeps .dt-filter's `flex-basis: 200px` on the
            horizontal axis. In a column container that basis is a HEIGHT, and
            the filter came out 220px tall. */}
        <div className="dt-top-controls">
          <div className="dt-filter">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              className="dt-filter-input"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={filterPlaceholder}
              aria-label={filterPlaceholder}
            />
            {filter && (
              <button type="button" className="dt-filter-clear" onClick={() => setFilter('')}
                aria-label="Clear filter">×</button>
            )}
          </div>
          {toolbar && <div className="dt-tools">{toolbar}</div>}
        </div>
      </header>

      {error && <p className="error-text dt-error">{error}</p>}

      {/* The one place a wide table is allowed to scroll sideways. */}
      <div className="dt-scroll">
        <table className="dt-table" style={resized ? { width: totalWidth, minWidth: totalWidth } : undefined}>
          <colgroup>
            {selectable && <col style={{ width: resized ? checkW.current : 38 }} />}
            {columns.map((c) => (
              <col key={c.key} style={{ width: widths[c.key] ?? c.width ?? undefined }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {selectable && (
                <th className="dt-check">
                  <input type="checkbox" checked={allOnPage} onChange={toggleAll}
                    aria-label="Select all rows on this page" />
                </th>
              )}
              {columns.map((c) => {
                const active = sort.key === c.key && sort.dir !== 'none';
                const sortable = c.sortable !== false;
                return (
                  <th key={c.key} className={`${c.align === 'right' ? 'dt-right' : ''}${active ? ' is-sorted' : ''}`}>
                    <span className="dt-th">
                      {sortable ? (
                        <button type="button" className="dt-th-btn" onClick={() => toggleSort(c.key)}
                          aria-label={`Sort by ${c.header}`}>
                          {c.header}
                          {active && <Chevron dir={sort.dir} />}
                        </button>
                      ) : <span className="dt-th-btn as-text">{c.header}</span>}
                      {/* Grab handle. pointer events, so it works with a mouse
                          or a pen and does not select text while dragging. */}
                      <span
                        className="dt-resize"
                        role="separator"
                        aria-orientation="vertical"
                        onPointerDown={(e) => startResize(
                          e, c.key,
                          widths[c.key] ?? e.currentTarget.closest('th').getBoundingClientRect().width,
                        )}
                      />
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => {
              const id = idOf(r, i);
              const isSel = selected.has(id);
              return (
                <tr
                  key={id}
                  className={`${onRowClick ? 'dt-click' : ''}${activeId && activeId === id ? ' is-active' : ''}${isSel ? ' is-selected' : ''}`}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                >
                  {selectable && (
                    <td className="dt-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={isSel} onChange={() => toggleRow(id)}
                        aria-label="Select row" />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={c.align === 'right' ? 'dt-right' : undefined}>
                      {c.cell ? c.cell(r) : textOf(c, r)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Empty and loading are the page's own components, passed through, so a
          list says what it has always said when it has nothing. */}
      {loading && <div className="dt-state">Loading…</div>}
      {!loading && sorted.length === 0 && (
        <div className="dt-state">
          {filter ? `Nothing matches “${filter}”.` : (empty ?? 'No records.')}
        </div>
      )}

      <footer className="dt-foot">
        <span className="dt-count">
          {sorted.length === 0 ? 'No records' : `${from}–${to} of ${sorted.length}`}
          {selected.size > 0 && <> · <span className="dt-selcount">{selected.size} selected</span></>}
        </span>
        <label className="dt-size">
          Rows
          <select className="select" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {[10, 12, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div className="dt-pager">
          <button type="button" className="dt-page-btn" disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)} aria-label="Previous page">‹</button>
          <span className="dt-page-now">{safePage + 1} / {pageCount}</span>
          <button type="button" className="dt-page-btn" disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)} aria-label="Next page">›</button>
        </div>
      </footer>
    </section>
  );
}
