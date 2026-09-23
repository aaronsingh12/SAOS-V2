import { useEffect, useState } from 'react';

/**
 * FINDINGS BY SEVERITY — a donut, five slices, the total in the middle.
 *
 * Severity is a status scale, so every slice carries its word, its glyph and
 * its number in the legend beside it; the hue alone is never asked to tell
 * Critical from High. Click a slice or a legend row to filter the findings
 * below; the same one again, or "All", puts everything back.
 *
 * Drawn with one <circle> per slice on a 100-unit path, so a slice's length is
 * its share and its offset is the sum of the shares before it. The entrance
 * runs the dash from nothing to its length, in order around the ring, once.
 */
/*
 * `centerLabel` and `showAll` let the same donut sit under a dimension (where
 * the centre reads "findings" and there is no "All severities" row to pick);
 * the defaults are the dashboard's, unchanged.
 */
export default function SeverityDonut({ rows, total, active, onPick, centerLabel = 'Total findings', showAll = true, allLabel = 'All severities' }) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(t);
  }, []);
  const sum = rows.reduce((n, r) => n + r.count, 0);
  const nonZero = rows.filter((r) => r.count > 0).length;
  const GAP = nonZero > 1 ? 1 : 0;                       // a 2px surface gap between slices
  let cursor = 0;
  const slices = rows.map((r) => {
    const pct = sum ? (r.count / sum) * 100 : 0;
    const len = pct === 0 ? 0 : (pct > GAP * 2 ? pct - GAP : pct / 2);
    const s = { ...r, pct, len, start: cursor };
    cursor += pct;
    return s;
  });
  return (
    <div className="hd-donut-wrap">
      <div className="hd-donut">
        <svg viewBox="0 0 100 100" role="img"
          aria-label={`Findings by severity: ${rows.map((r) => `${r.label} ${r.count.toLocaleString()}`).join(', ')}`}>
          <circle className="hd-donut-track" cx="50" cy="50" r="40" />
          <g transform="rotate(-90 50 50)">
          {slices.filter((s) => s.len > 0).map((s) => (
            <circle
              key={s.key}
              className={`hd-donut-seg tone-${s.tone}${active === s.key ? ' is-on' : ''}${active && active !== s.key ? ' is-off' : ''}`}
              cx="50" cy="50" r="40" pathLength="100"
              strokeDasharray={drawn ? `${s.len} ${100 - s.len}` : '0 100'}
              strokeDashoffset={-(s.start + GAP / 2)}
              style={{ transitionDelay: drawn ? `${s.start * 7}ms` : '0ms' }}
              onClick={() => onPick(s.key)}
              tabIndex={0}
              role="button"
              aria-pressed={active === s.key}
              aria-label={`${s.label}: ${s.count.toLocaleString()} (${s.pct.toFixed(1)}%)`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(s.key); } }}
            >
              <title>{`${s.label} · ${s.count.toLocaleString()} (${s.pct.toFixed(1)}%)`}</title>
            </circle>
          ))}
          </g>
        </svg>
        <div className="hd-donut-center">
          <span>{centerLabel}</span>
          <b>{total.toLocaleString()}</b>
        </div>
      </div>
      <ul className={`hd-legend${drawn ? ' is-in' : ''}`}>
        {slices.map((s, i) => (
          <li key={s.key} style={{ '--hd-delay': `${120 + i * 60}ms` }}>
            <button type="button"
              className={`hd-legend-row tone-${s.tone}${active === s.key ? ' is-on' : ''}${active && active !== s.key ? ' is-off' : ''}`}
              onClick={() => onPick(s.key)} aria-pressed={active === s.key} title={s.blurb}>
              <i aria-hidden="true" />
              <span className="hd-legend-label"><span className="hs-glyph" aria-hidden="true">{s.glyph}</span>{s.label}</span>
              <b>{s.count.toLocaleString()}</b>
              <em>{sum ? `${s.pct < 1 && s.pct > 0 ? '<1' : Math.round(s.pct)}%` : '—'}</em>
            </button>
          </li>
        ))}
        {showAll && <li style={{ '--hd-delay': `${120 + slices.length * 60}ms` }}>
          <button type="button" className={`hd-legend-row hd-legend-all${!active ? ' is-on' : ''}`}
            onClick={() => onPick(null)} aria-pressed={!active}>
            <i aria-hidden="true" />
            <span className="hd-legend-label">{allLabel}</span>
            <b>{sum.toLocaleString()}</b>
            <em />
          </button>
        </li>}
      </ul>
    </div>
  );
}
