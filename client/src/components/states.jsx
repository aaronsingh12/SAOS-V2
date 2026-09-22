import { Link } from 'react-router-dom';
import { useHealth } from '../hooks/useHealth.js';
import { describeInstanceState, skeletonWidth, skeletonLineWidth } from './instanceState.js';

/**
 * D-3 — the three things a page can be showing instead of data: loading,
 * empty, or not connected. All three used to be the same grey sentence, or
 * nothing at all.
 *
 * The decisions live in ./instanceState.js so the offline suite can assert
 * them; what is left here is the markup. Everything composes existing tokens —
 * no new colour, font or radius.
 */

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/**
 * Skeleton rows for a table. Shaped like the table it stands in for — `cols`
 * matches the real header — because a skeleton that does not predict the
 * layout produces the reflow it was meant to prevent.
 */
export function SkeletonRows({ rows = 5, cols = 4 }) {
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}><span className="skeleton" style={{ width: `${skeletonWidth(r, c)}%` }} /></td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/** The same idea outside a table: a card body, a rail, a detail pane. */
export function SkeletonLines({ lines = 3 }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: `${skeletonLineWidth(i)}%` }} />
      ))}
    </div>
  );
}

/**
 * The accessible half of a skeleton. Screen readers get one polite "loading"
 * rather than a stack of decorative bars, which is why every skeleton above
 * is aria-hidden.
 */
export function LoadingRegion({ label = 'Loading' }) {
  return <span className="sr-only" role="status" aria-live="polite">{label}…</span>;
}

/* ------------------------------------------------------------------ *
 * Empty
 * ------------------------------------------------------------------ */

/**
 * A designed empty state: one line saying why it is empty, and the next
 * action as a button. "No items found." on its own tells someone nothing
 * about what to do next, which on a first run is the entire question.
 */
export function EmptyState({ title, hint, to, onAction, actionLabel, icon = '·' }) {
  return (
    <div className="empty-state">
      <div className="empty-mark" aria-hidden="true">{icon}</div>
      <div className="empty-title">{title}</div>
      {hint && <p className="empty-hint">{hint}</p>}
      {actionLabel && to && <Link className="btn primary sm" to={to}>{actionLabel}</Link>}
      {actionLabel && !to && onAction && (
        <button className="btn primary sm" onClick={onAction}>{actionLabel}</button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Not connected
 * ------------------------------------------------------------------ */

/**
 * Wraps a page that cannot do anything without a bound instance, so that
 * "nothing matched" only ever means nothing matched.
 */
export function RequiresInstance({ children, what = 'This page' }) {
  const s = describeInstanceState(useHealth(), what);
  if (s.kind === 'children') return children;
  if (s.kind === 'waiting') {
    // Deliberately holds the children back rather than rendering them
    // optimistically: mounting them mounts their fetches, and a page that
    // asks an unbound instance for data logs a 400 nobody can act on.
    return (
      <div className="card">
        <SkeletonLines lines={4} />
        <LoadingRegion label="Checking the instance connection" />
      </div>
    );
  }
  return <EmptyState icon={s.icon} title={s.title} hint={s.hint} to={s.to} actionLabel={s.actionLabel} />;
}

/**
 * The banner form, for pages that stay useful while disconnected — Settings
 * and the Agent, which can be configured and read back offline.
 */
export function DisconnectedBanner() {
  const h = useHealth();
  const s = describeInstanceState(h);
  // A banner has nothing useful to say while the answer is still unknown.
  if (s.kind === 'children' || s.kind === 'waiting') return null;
  return (
    <div className="note warn" style={{ marginBottom: 12 }}>
      {s.kind === 'server'
        ? <>The SAOS server is not responding (<span className="mono">{h.error}</span>). Anything that touches the instance will fail until it is back.</>
        : <>No instance is bound, so anything that reads or writes ServiceNow will fail. <Link to="/">Connect one on the Dashboard</Link>.</>}
    </div>
  );
}
