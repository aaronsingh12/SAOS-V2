import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { LoadingRegion } from './states.jsx';
import { toSources, asText, hostOf } from './sourceModel.js';

/**
 * SOURCES — what informed this turn.
 *
 * SAME ENDPOINT, SAME DATA. It reads `GET /agent/plan/:taskId/evidence`, which
 * is untouched; `sourceModel.js` maps that projection onto the three headings.
 * Nothing here recomputes a verdict and nothing here invents an item — an
 * empty category says it is empty.
 *
 * NOTHING RAW REACHES JSX. Every value goes through `asText`/`unwrap` first,
 * because the projection wraps some scalars as `{ value, source }` and printing
 * one of those directly is what previously threw "Objects are not valid as a
 * React child".
 *
 * THE DRAWER IS THE ACTIVITY DRAWER. `SourcesDrawer` below renders the same
 * `.act-drawer` / `.act-drawer-inner` shell ActivityDock renders, so the open
 * animation, the width transition, the layering, the mobile sheet behaviour and
 * the close button are the same implementation rather than a lookalike.
 */

/* ── The link preview ────────────────────────────────────────────────────
 * Aceternity's Link Preview as a behaviour, written here in our own CSS: a
 * card that springs up under the pointer on hover and eases out when it
 * leaves. What it shows is the source itself — type, title, snippet, host —
 * because this app is offline-first and cannot fetch a screenshot of a page
 * it may not even be able to reach.
 *
 * FIXED, not absolute. The drawer is ~326px wide and clips its own overflow,
 * so a card positioned inside it would be cut off. Anchoring to the item's
 * viewport rect lets the card sit over the conversation to the left, which is
 * also where the reference puts it, and keeps it clear of the panel edge.
 *
 * A source with nothing to preview gets no card at all — the item still
 * renders and still behaves, which is the graceful fallback.
 */
function useLinkPreview() {
  const [preview, setPreview] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const show = useCallback((item, el) => {
    if (!item || !el) return;
    // Nothing worth previewing: no snippet, no link, no longer detail.
    if (!item.snippet && !item.url && !item.detail) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const W = 280;
      /*
       * Anchored to the DRAWER's left edge, not the row's.
       *
       * Measured: anchoring to the row put the card's right edge exactly on the
       * drawer's left edge, and the row is inset from the panel — so the card
       * sat on top of the panel it belongs to. The drawer's own rect is the
       * boundary that matters, so the clearance is computed from that.
       */
      const panel = el.closest('.act-drawer');
      const rightLimit = (panel ? panel.getBoundingClientRect().left : r.left) - 14;
      const left = Math.max(12, Math.min(rightLimit - W, window.innerWidth - W - 12));
      // A provisional top; the card clamps it properly once it knows its own
      // height (see LinkPreviewCard), which cannot be known before it mounts.
      setPreview({ item, left, top: Math.max(12, r.top - 8), w: W });
    }, 90);
  }, []);

  const hide = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPreview(null), 110);
  }, []);

  return { preview, show, hide };
}

function LinkPreviewCard({ preview }) {
  /* Mounted closed, then opened on the next frame, so the entrance transition
     has two states to move between. Without it the card would appear already
     at its end state and never animate. */
  const [open, setOpen] = useState(false);
  const [top, setTop] = useState(preview?.top ?? 0);
  const ref = useRef(null);

  useEffect(() => {
    if (!preview) return undefined;
    /*
     * Clamp against the card's REAL height, which only exists once it is in the
     * DOM. A fixed guess was measured overflowing the bottom of the window on a
     * source with a long snippet; the element knows its own height, so it is
     * asked rather than assumed.
     */
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(12, Math.min(preview.top, window.innerHeight - h - 12)));
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, [preview]);

  if (!preview) return null;
  const { item, left, w } = preview;
  const host = item.url ? hostOf(item.url) : null;
  /*
   * PORTALLED TO THE BODY, and that is load-bearing rather than tidiness.
   *
   * `.act-drawer-inner` carries a backdrop-filter, and a filtered element
   * becomes the containing block for its `position: fixed` descendants. Left
   * inside the drawer the card was therefore positioned against the DRAWER,
   * not the viewport: measured at 1440px it landed at x=1849 — 409px past the
   * right edge of the window — for a computed left of 770. Rendering it at the
   * body escapes that containing block, so `fixed` means the viewport again.
   */
  return createPortal((
    <div
      ref={ref}
      className={`src-preview${open ? ' is-open' : ''}`}
      style={{ left, top, width: w }}
      role="presentation"
      aria-hidden="true"
    >
      <div className="src-preview-top">
        <span className="src-chip">{asText(item.type) ?? 'Source'}</span>
        {item.date && <span className="src-preview-date">{item.date}</span>}
      </div>
      <div className="src-preview-title">{asText(item.title)}</div>
      {(item.detail || item.snippet) && (
        <p className="src-preview-body">{asText(item.detail) ?? asText(item.snippet)}</p>
      )}
      {host && <div className="src-preview-host">{host}</div>}
    </div>
  ), document.body);
}

function SourceItem({ item, onEnter, onLeave }) {
  const ref = useRef(null);
  const previewable = Boolean(item.snippet || item.url || item.detail);
  const body = (
    <>
      <div className="src-item-top">
        <span className="src-chip">{asText(item.type) ?? 'Source'}</span>
      </div>
      <div className="src-item-title">{asText(item.title) ?? 'Untitled source'}</div>
      {(item.date || item.snippet) && (
        <div className="src-item-meta">
          {item.date && <span className="src-item-date">{item.date}</span>}
          {item.date && item.snippet && <span className="src-dot"> — </span>}
          {item.snippet && <span className="src-item-snippet">{asText(item.snippet)}</span>}
        </div>
      )}
      {item.meta && <div className="src-item-note">{asText(item.meta)}</div>}
    </>
  );

  const shared = {
    ref,
    className: `src-item${previewable ? ' is-previewable' : ''}`,
    onMouseEnter: () => previewable && onEnter(item, ref.current),
    onMouseLeave: onLeave,
    onFocus: () => previewable && onEnter(item, ref.current),
    onBlur: onLeave,
  };

  /* A real link stays a real link — it opens in a new tab and keeps its
     affordance. Everything else is a plain, non-interactive row. */
  return item.url
    ? <a {...shared} href={item.url} target="_blank" rel="noreferrer">{body}</a>
    : <div {...shared}>{body}</div>;
}

export function SourcesPanel({ taskId, embedded = false }) {
  const [ev, setEv] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const { preview, show, hide } = useLinkPreview();

  const load = useCallback(async () => {
    if (!taskId) return;
    setBusy(true);
    setErr(null);
    try {
      setEv(await api.get(`/agent/plan/${encodeURIComponent(taskId)}/evidence`));
    } catch (e) {
      // A task that does not exist is a real answer, not an empty panel that
      // reads as "this turn used nothing".
      setErr(e.message || 'The sources could not be loaded.');
      setEv(null);
    } finally {
      setBusy(false);
    }
  }, [taskId]);

  /*
   * ONE TURN AT A TIME. The task id changes the moment the next turn starts
   * (`task_started`), and the previous turn's evidence must not stay on
   * screen until the new fetch lands — that overlap is exactly how a Catalog
   * turn's documents appeared under a Flow answer. The state is emptied first,
   * then loaded; a reader sees "loading", never a stale list.
   */
  useEffect(() => { setEv(null); setErr(null); load(); }, [load]);

  if (!taskId) return null;

  const categories = toSources(ev);
  const total = categories.reduce((n, c) => n + c.items.length, 0);

  return (
    <div className={`src${embedded ? ' src-embedded' : ''}`}>
      {err && <div className="src-error">{err}</div>}
      {busy && !ev && <LoadingRegion label="Reading what this turn used" />}

      {ev && categories.map((cat) => (
        <section className="src-cat" key={cat.key}>
          <header className="src-cat-head">
            <span className="src-cat-name">{cat.label}</span>
            {cat.items.length > 0 && <span className="src-cat-count">{cat.items.length}</span>}
          </header>
          {cat.items.length === 0 ? (
            /* An honest empty: nothing is filled in from a default list. For
               Online Docs that is a statement about THIS response — the
               retrieval either returned documents for it or it did not. */
            <p className="src-cat-empty">
              {cat.key === 'docs' ? 'No online sources were used for this response.' : 'Nothing from here.'}
            </p>
          ) : (
            <div className="src-list">
              {cat.items.map((item) => (
                <SourceItem key={item.id} item={item} onEnter={show} onLeave={hide} />
              ))}
            </div>
          )}
        </section>
      ))}

      {ev && total === 0 && (
        <p className="src-none">
          This turn recorded no sources. It answered from the conversation alone.
        </p>
      )}

      {ev && (
        <button type="button" className="btn ghost sm src-refresh" onClick={load} disabled={busy}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      )}

      <LinkPreviewCard preview={preview} />
    </div>
  );
}

/**
 * The drawer, built out of the Activity drawer's own shell.
 *
 * Every class here is ActivityDock's, so the width transition, the scale-and-
 * fade of the inner surface, the z-index, the `inert` while closed and the
 * mobile sheet all come from the rules that already govern Activity. Only the
 * body differs.
 */
export function SourcesDrawer({ open, taskId, onClose }) {
  return (
    <aside
      className={`act-drawer src-drawer${open ? ' is-open' : ''}`}
      aria-hidden={!open}
      aria-label="Sources"
    >
      <div className="act-drawer-inner" inert={open ? undefined : ''}>
        <header className="act-drawer-head">
          <span className="act-drawer-title">Sources</span>
          <button type="button" className="act-drawer-close" onClick={onClose} aria-label="Close sources">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="act-drawer-body">
          {open && <SourcesPanel taskId={taskId} />}
        </div>
      </div>
    </aside>
  );
}

export default SourcesPanel;
