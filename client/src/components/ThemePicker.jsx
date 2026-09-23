import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { THEMES, THEME_INFO, preloadTheme, useTheme } from '../theme.js';
import './ThemePicker.css';

/*
 * The theme dropdown in Preferences: Original, ServiceNow, ROBOTIC.
 *
 * A select-only listbox rather than a native <select>, because each option
 * carries a miniature of the theme it names — a native select can only show
 * text. It keeps the native control's keyboard contract: Enter/Space or the
 * arrows open it, the arrows move, Home/End jump, Enter/Space choose, Escape
 * closes and returns focus, Tab leaves. The digits 1–3 choose directly, and a
 * letter jumps to the theme it starts.
 */

function Preview({ theme }) {
  const [side, ground, accent] = THEME_INFO[theme].swatch;
  return (
    <span
      className="tp-preview"
      data-preview={theme}
      style={{ '--tp-side': side, '--tp-ground': ground, '--tp-accent': accent }}
      aria-hidden="true"
    >
      <span className="tp-preview-side"><i /><i /><i /></span>
      <span className="tp-preview-main"><i className="tp-preview-bar" /><i className="tp-preview-card" /></span>
    </span>
  );
}

export default function ThemePicker() {
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => THEMES.indexOf(theme));
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const listRef = useRef(null);
  const highlightRef = useRef(null);
  const optionRefs = useRef([]);
  const id = useId();
  const listId = `${id}-list`;
  const optId = (i) => `${id}-opt-${i}`;

  const openList = (index = THEMES.indexOf(theme)) => {
    THEMES.forEach(preloadTheme);
    // Open upward when the space below would not hold the list.
    const r = buttonRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setDropUp(below < 280 && r.top > below);
    setActive(index);
    setOpen(true);
  };

  const close = (refocus) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const choose = (index, event) => {
    let origin;
    if (event && event.clientX !== undefined) origin = { x: event.clientX, y: event.clientY };
    else {
      const r = optionRefs.current[index]?.getBoundingClientRect();
      if (r) origin = { x: r.left + 30, y: r.top + r.height / 2 };
    }
    close(true);
    setTheme(THEMES[index], origin);
  };

  useEffect(() => {
    if (open) listRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // The highlight is one element that slides to the active option.
  useLayoutEffect(() => {
    const el = optionRefs.current[active];
    const hl = highlightRef.current;
    if (!el || !hl) return;
    hl.style.transform = `translateY(${el.offsetTop}px)`;
    hl.style.height = `${el.offsetHeight}px`;
  }, [active, open]);

  const onButtonKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const here = THEMES.indexOf(theme);
      openList(e.key === 'ArrowUp' ? (here - 1 + THEMES.length) % THEMES.length : here);
    }
  };

  const onListKey = (e) => {
    const n = THEMES.length;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((i) => (i + 1) % n); break;
      case 'ArrowUp': e.preventDefault(); setActive((i) => (i - 1 + n) % n); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(n - 1); break;
      case 'Enter':
      case ' ': e.preventDefault(); choose(active); break;
      case 'Escape': e.preventDefault(); close(true); break;
      case 'Tab': setOpen(false); break;
      default: {
        if (e.key.length !== 1) break;
        const digit = Number(e.key);
        if (digit >= 1 && digit <= n) { e.preventDefault(); choose(digit - 1); break; }
        const hit = THEMES.findIndex((t) => THEME_INFO[t].label.toLowerCase().startsWith(e.key.toLowerCase()));
        if (hit >= 0) setActive(hit);
      }
    }
  };

  const info = THEME_INFO[theme];
  return (
    <div ref={rootRef} className={`tp${open ? ' is-open' : ''}${dropUp ? ' drop-up' : ''}`}>
      <button
        ref={buttonRef}
        type="button"
        className="tp-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Theme: ${info.label}`}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onButtonKey}
      >
        <Preview theme={theme} />
        <span className="tp-trigger-text">
          <span className="tp-trigger-label" key={theme}>{info.label}</span>
          <span className="tp-trigger-hint">{info.blurb}</span>
        </span>
        <svg className="tp-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="tp-pop">
        <span ref={highlightRef} className="tp-highlight" aria-hidden="true" />
        <ul
          ref={listRef}
          id={listId}
          className="tp-list"
          role="listbox"
          tabIndex={-1}
          aria-label="Theme"
          aria-activedescendant={open ? optId(active) : undefined}
          onKeyDown={onListKey}
        >
          {THEMES.map((t, i) => (
            <li
              key={t}
              id={optId(i)}
              ref={(el) => { optionRefs.current[i] = el; }}
              role="option"
              aria-selected={t === theme}
              className={`tp-opt${i === active ? ' is-active' : ''}`}
              onPointerMove={() => { if (i !== active) setActive(i); }}
              onClick={(e) => choose(i, e)}
            >
              <Preview theme={t} />
              <span className="tp-opt-text">
                <span className="tp-opt-label">{THEME_INFO[t].label}</span>
                <span className="tp-opt-blurb">{THEME_INFO[t].blurb}</span>
              </span>
              <svg className="tp-check" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M4 9.5l3.2 3.2L14 5.8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <kbd className="tp-key">{i + 1}</kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
