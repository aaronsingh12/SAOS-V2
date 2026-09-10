import { useEffect, useRef } from 'react';

/*
 * THE RECORD DETAIL DRAWER.
 *
 * Replaces the permanent right-hand column that every ServiceNow list used to
 * reserve. That column cost 380px whether or not anything was selected, and
 * spent it on the words "Nothing selected" — so the list, which is the thing
 * people came to read, ran in a third of the page.
 *
 * IT HOLDS NO RECORD LOGIC. Each page passes the detail markup it already had
 * as children: same fields, same handlers, same save and delete. This adds a
 * surface, a way out of it, and nothing else.
 *
 * Dismissible three ways — Escape, the close button, and the backdrop —
 * because a panel that covers the page needs to be leavable without hunting
 * for the one control that closes it.
 */
export default function RecordDrawer({ open, title = null, onClose, children, width = 520 }) {
  const panelRef = useRef(null);
  const restoreTo = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
    document.addEventListener('keydown', onKey);
    // Move focus in, so the keyboard follows the panel that just opened.
    const raf = requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      document.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
      // And back out again to whatever opened it.
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="rd" role="presentation">
      <div className="rd-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="rd-panel"
        style={{ '--rd-w': `${width}px` }}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Record details'}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="rd-head">
          <h2 className="rd-title">{title}</h2>
          <button type="button" className="rd-close" onClick={onClose} aria-label="Close details">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        {/* The one scroller in here: a long record scrolls, the header does not
            go with it. */}
        <div className="rd-body">{children}</div>
      </aside>
    </div>
  );
}
