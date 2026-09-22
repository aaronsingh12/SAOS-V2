import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  AGENT_CHATS_SLOT_ID, AGENT_SKILLS_SLOT_ID,
  AGENT_ACTIONS_SLOT_ID, AGENT_NEWCHAT_SLOT_ID, bumpNavLayout,
} from './agentRail.js';

/*
 * THE GLOBAL NAVIGATION. One implementation, every route.
 *
 * Adapted from React Bits' Card Nav rather than copied from it. What is taken
 * is the INTERACTION: one control that collapses the whole thing, a size
 * transition rather than a pop, grouped rounded surfaces, and contents that
 * stagger in behind the transition instead of appearing all at once.
 *
 * What is deliberately NOT taken is its shape. Card Nav is a horizontal bar
 * that opens into side-by-side cards with nested links under every heading.
 * This is vertical, grouped under three headings, and nests exactly one item —
 * Skills — because that is the only place where sub-items are real. Giving
 * every route an accordion would hide the app one level down for no gain.
 *
 * THREE LAYOUTS, one component:
 *   expanded  — icons and labels, sections and their contents.
 *   collapsed — a 68px icon rail. Not zero width: an icon rail keeps every
 *               destination one click away, which a hidden column does not.
 *   mobile    — below 900px the rail would still cost width the content needs,
 *               so it becomes an off-canvas drawer over the page instead.
 */

/* Inline strokes rather than an icon dependency. One weight, currentColor, so
   they inherit the same tokens every other control in the app already uses. */
const I = {
  chats: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.3-.6L3 21l1.8-5.1A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" /></>,
  tasks: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1.4 1.4L7 5" /><path d="m3 12 1.4 1.4L7 11" /><path d="m3 18 1.4 1.4L7 17" /></>,
  incidents: <><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></>,
  catalog: <><path d="m7.5 4.3 9 5.2" /><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><path d="m3.3 7 8.7 5 8.7-5M12 22V12" /></>,
  flows: <><circle cx="6" cy="19" r="3" /><circle cx="18" cy="5" r="3" /><path d="M9 19h4a4 4 0 0 0 4-4V9" /></>,
  sla: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  acl: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>,
  health: <><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></>,
  tables: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  meetings: <><rect x="3" y="4.5" width="18" height="17" rx="2" /><path d="M16 2.5v4M8 2.5v4M3 10h18" /></>,
  applications: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  /* Update Sets: three stacked layers — a set is a layer of changes over the
     instance, and moving one is moving a layer. The key stays `transport`
     because it is the route and the icon id; only the label is the user's. */
  transport: <><path d="m12 3 9 5-9 5-9-5 9-5z" /><path d="m3 12.5 9 5 9-5" /><path d="m3 17.5 9 5 9-5" /></>,
  audit: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h4" /></>,
  dashboard: <><path d="M3 13h8V3H3zM13 21h8V11h-8zM13 7h8V3h-8zM3 21h8v-4H3z" /></>,
  trash: <><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6" /></>,
  skills: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  agent: <><rect x="3" y="4" width="18" height="14" rx="3" /><path d="M8 10v2M16 10v2M12 18v3M9 21h6" /></>,
  chevron: <><path d="m9 18 6-6-6-6" /></>,
  panel: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
};

/* data-ic names the glyph so the stylesheet can give each one a hover motion
   that matches what it depicts — a gear turns, a clock's hands move, a flow
   travels its connector. The paths above are untouched: the CSS reaches their
   parts positionally, so there is one attribute here and no per-icon markup.
   See "ICON HOVER MOTION" in experience.css. */
const Icon = ({ name, size = 17 }) => (
  <svg className="nav-ic" data-ic={name} viewBox="0 0 24 24" width={size} height={size} fill="none"
    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">{I[name]}</svg>
);

/* Every route that already exists in the app. Nothing invented, nothing
   dropped: Transport and Audit are ServiceNow surfaces too, so they sit under
   the same heading rather than losing their entry. */
const AUTOMATIONS = [
  /* The playground itself. It was missing from this list, which left /agent
     reachable only through the chat rail — navigating away from it was a
     one-way trip. Same route, same AgentChat; only the entry point is new. */
  ['/agent', 'Agent', 'agent'],
  ['/incidents', 'Incidents', 'incidents'],
  ['/catalog', 'Catalog', 'catalog'],
  ['/flows', 'Flows', 'flows'],
  ['/sla', 'SLA', 'sla'],
  ['/access', 'ACL', 'acl'],
  ['/health', 'Health Assist', 'health'],
  ['/tables', 'Tables', 'tables'],
  ['/meetings', 'Meetings', 'meetings'],
  ['/applications', 'Applications', 'applications'],
  ['/transport', 'Update Sets', 'transport'],
];

const COLLAPSE_KEY = 'nowhelpassist.sidebarCollapsed';
const SECTIONS_KEY = 'nowhelpassist.navSections';
const MOBILE_Q = '(max-width: 900px)';

function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false),
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

/** A nav row that is a route. */
function NavItem({ to, end, label, icon, collapsed, onNavigate }) {
  return (
    <NavLink to={to} end={end} className="nav-item" onClick={onNavigate}
      title={collapsed ? label : undefined}>
      <Icon name={icon} />
      <span className="nav-label">{label}</span>
    </NavLink>
  );
}

/**
 * A collapsible SECTION of the navigation.
 *
 * Distinct from collapsing the sidebar itself: this hides one group's items
 * while the column stays whatever width it already was, and the two states are
 * independent. Collapsed, only the heading and its control remain — the
 * section never disappears, so you can always find it again.
 *
 * The open/close is a grid-rows transition (0fr -> 1fr). That animates to the
 * content's natural height without anyone measuring it in JavaScript, which is
 * what keeps it smooth and free of the jump a height:auto swap produces.
 */
function NavSection({ id, label, open, onToggle, collapsed, children }) {
  if (collapsed) {
    // In the icon rail there is no heading to click and no room for one; the
    // icons are shown flat rather than trying to nest a hierarchy in 72px.
    return <div className="nav-section">{children}</div>;
  }
  return (
    <div className={`nav-section${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="nav-section-label nav-section-toggle"
        onClick={() => onToggle(id)}
        aria-expanded={open}
      >
        <span>{label}</span>
        <svg className="nav-section-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none"
          stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <div className="nav-section-body" aria-hidden={!open}>
        <div className="nav-section-inner">{children}</div>
      </div>
    </div>
  );
}

/** A nav row that opens a panel underneath it instead of navigating. */
function NavGroup({ id, label, icon, open, onToggle, collapsed, slotId, children }) {
  return (
    <>
      <button
        type="button"
        className={`nav-item nav-toggle${open ? ' is-open' : ''}`}
        onClick={() => onToggle(id)}
        aria-expanded={open}
        title={collapsed ? label : undefined}
      >
        <Icon name={icon} />
        <span className="nav-label">{label}</span>
        <Icon name="chevron" size={13} />
      </button>
      {/*
        * The panel is only in the DOM while it is open, which is what keeps the
        * column short. AgentChat's portals re-target on every open/close —
        * bumpNavLayout() below is what tells them to.
        */}
      {open && !collapsed && (
        <div className="nav-panel">
          {slotId ? <div className="nav-slot" id={slotId} /> : children}
        </div>
      )}
    </>
  );
}

export default function Sidebar() {
  const isMobile = useMediaQuery(MOBILE_Q);
  const { pathname } = useLocation();

  /* Remembered across reloads: someone who collapses the column to read a wide
     table does not want it back on every navigation. Guarded — storage throws
     in a locked-down browser, and a nav that fails to render is worse than one
     that forgets. */
  const [collapsedPref, setCollapsedPref] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState('chats');
  /* Which top-level sections are open. Persisted, and deliberately NOT reset on
     navigation — a section you closed stays closed as you move around. */
  const [openSections, setOpenSections] = useState(() => {
    try {
      const raw = localStorage.getItem(SECTIONS_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through to the default */ }
    return { automations: true, settings: true };
  });
  const [skillsFlyout, setSkillsFlyout] = useState(false);
  const flyoutRef = useRef(null);

  // On mobile the column is a drawer, so "collapsed" does not apply to it.
  const collapsed = !isMobile && collapsedPref;

  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsedPref ? '1' : '0'); } catch { /* fine */ }
  }, [collapsedPref]);

  useEffect(() => {
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(openSections)); } catch { /* fine */ }
  }, [openSections]);

  const toggleSection = useCallback((id) => {
    setOpenSections((cur) => ({ ...cur, [id]: !cur[id] }));
  }, []);

  /* Any structural change means the portal targets moved. */
  useEffect(() => {
    bumpNavLayout();
  }, [openGroup, collapsed, isMobile, drawerOpen, skillsFlyout, openSections]);

  // Navigating on mobile closes the drawer — otherwise it sits over the page
  // you just asked for.
  useEffect(() => {
    setDrawerOpen(false);
    /* Route changes mount and unmount slots too — the Preferences page owns
       one — so the portals must re-resolve on navigation as well. */
    bumpNavLayout();
  }, [pathname]);

  useEffect(() => {
    if (!skillsFlyout) return undefined;
    const onDown = (e) => { if (!flyoutRef.current?.contains(e.target)) setSkillsFlyout(false); };
    const onKey = (e) => { if (e.key === 'Escape') setSkillsFlyout(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [skillsFlyout]);

  const toggleGroup = useCallback((id) => {
    // One panel at a time. Two open lists in a 272px column is a scrollbar.
    setOpenGroup((cur) => (cur === id ? null : id));
  }, []);

  const closeDrawer = () => { if (isMobile) setDrawerOpen(false); };

  const shellClass = [
    'sidebar',
    collapsed ? 'is-collapsed' : '',
    isMobile ? 'is-mobile' : '',
    isMobile && drawerOpen ? 'is-drawer-open' : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      {/* The way in on mobile. Fixed, so it stays reachable whatever the page
          beneath is doing with scroll. */}
      {isMobile && !drawerOpen && (
        <button type="button" className="nh-reopen" onClick={() => setDrawerOpen(true)}
          aria-label="Show navigation" aria-expanded="false">
          <span className="nh-burger" aria-hidden="true">
            <span className="nh-burger-line" /><span className="nh-burger-line" />
          </span>
        </button>
      )}
      {isMobile && drawerOpen && (
        <div className="nav-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}

      <aside className={shellClass} aria-label="Main navigation">
        <div className="sidebar-inner">
          {/* ── Branding ───────────────────────────────────────────────── */}
          <div className="nav-brand">
            {/*
              * COLLAPSED, THE MARK IS THE CONTROL.
              *
              * The rail is 72px wide; a separate toggle under the logo spent a
              * whole row on a second affordance. Collapsed, the mark itself
              * becomes the button — it swaps to the panel glyph on hover and
              * focus, so the target is obvious without costing any width. Both
              * glyphs sit in one fixed 26px box and cross-fade, so nothing
              * reflows and the rail width never moves.
              *
              * Expanded, this stays exactly what it was: a mark, the wordmark,
              * and the collapse button on the right.
              */}
            {collapsed ? (
              <button
                type="button"
                className="nav-mark-toggle"
                onClick={() => setCollapsedPref(false)}
                aria-label="Expand navigation"
                title="Expand navigation"
              >
                <img className="logomark" src="/favicon.svg" alt="" width="26" height="26" aria-hidden="true" />
                <Icon name="panel" size={18} />
              </button>
            ) : (
              <img className="logomark" src="/favicon.svg" alt="" width="26" height="26" aria-hidden="true" />
            )}
            <span className="nav-brand-text">
              <span className="nav-brand-name">SA<span className="assist">OS</span></span>
              <span className="nav-brand-sub">agentic servicenow studio</span>
            </span>
            <button
              type="button"
              className="nav-collapse"
              onClick={() => (isMobile ? setDrawerOpen(false) : setCollapsedPref((v) => !v))}
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              title={collapsed ? 'Expand' : 'Collapse'}
            >
              <Icon name="panel" size={16} />
            </button>
          </div>

          <div className="nav-scroll">
            {/* ── NEW CHAT ─────────────────────────────────────────────── */}
            {/* Above the Chats group, not inside it: starting a conversation is
                the first thing offered, and it should not require opening a
                list first. AgentChat portals its existing button in here.
                Collapsed, the rail has no room for a labelled button and the
                Agent row below already reaches the same page, so the slot is
                simply not rendered. */}
            {!collapsed && <div className="nav-slot nav-newchat" id={AGENT_NEWCHAT_SLOT_ID} />}

            {/* ── CHATS ────────────────────────────────────────────────── */}
            {/* One entry, no heading above it: "Chats" IS the heading. A section
                label over a single item of the same name said it twice. */}
            <div className="nav-section nav-section-bare">
              <NavGroup
                id="chats" label="Chats" icon="chats" collapsed={collapsed}
                open={openGroup === 'chats'} onToggle={toggleGroup}
                slotId={AGENT_CHATS_SLOT_ID}
              />
            </div>

            {/* ── SERVICENOW AUTOMATIONS ───────────────────────────────── */}
            <NavSection id="automations" label="Servicenow Automations"
              open={openSections.automations} onToggle={toggleSection} collapsed={collapsed}>
              {AUTOMATIONS.map(([to, label, icon]) => (
                <NavItem key={to} to={to} label={label} icon={icon}
                  collapsed={collapsed} onNavigate={closeDrawer} />
              ))}
            </NavSection>

            {/* ── SETTINGS ─────────────────────────────────────────────── */}
            <NavSection id="settings" label="Settings"
              open={openSections.settings} onToggle={toggleSection} collapsed={collapsed}>
              <NavItem to="/" end label="Dashboard" icon="dashboard"
                collapsed={collapsed} onNavigate={closeDrawer} />
              {/* Delete Chats. Portalled in by AgentChat, which owns the
                  handler and the session list it acts on. */}
              <div className="nav-slot nav-controls" id={AGENT_ACTIONS_SLOT_ID} />

              {/*
                * Skills, the one nested item. Expanded, the real SkillsPanel
                * renders inside — the server's own list, its toggles and its
                * permissions, not a copy. Collapsed, the same panel opens as a
                * flyout so the rail never grows sideways.
                */}
              {collapsed ? (
                <div className="nav-flyout-host" ref={flyoutRef}>
                  <button type="button" className={`nav-item nav-toggle${skillsFlyout ? ' is-open' : ''}`}
                    onClick={() => setSkillsFlyout((v) => !v)}
                    aria-expanded={skillsFlyout} title="Skills">
                    <Icon name="skills" />
                    <span className="nav-label">Skills</span>
                    <Icon name="chevron" size={13} />
                  </button>
                  {skillsFlyout && (
                    <div className="nav-flyout">
                      <div className="nav-flyout-title">Skills</div>
                      <div className="nav-slot" id={AGENT_SKILLS_SLOT_ID} />
                    </div>
                  )}
                </div>
              ) : (
                <NavGroup
                  id="skills" label="Skills" icon="skills" collapsed={collapsed}
                  open={openGroup === 'skills'} onToggle={toggleGroup}
                  slotId={AGENT_SKILLS_SLOT_ID}
                />
              )}

              {/* The SAME /audit route and the same Audit page — only the label
                  and the grouping changed. It is a record of what NHA did,
                  which is a settings concern rather than a ServiceNow surface. */}
              <NavItem to="/audit" label="SAOS Logs" icon="audit"
                collapsed={collapsed} onNavigate={closeDrawer} />
              <NavItem to="/settings" label="Preferences" icon="settings"
                collapsed={collapsed} onNavigate={closeDrawer} />
            </NavSection>
          </div>

          {/* ── Profile placeholder ──────────────────────────────────────
              Deliberately generic. This app has no user identity to show and
              inventing one would put a name on screen that means nothing. */}
          <div className="nav-user" title="Signed in locally">
            <span className="nav-user-avatar" aria-hidden="true"><Icon name="user" size={15} /></span>
            <span className="nav-user-text">
              <span className="nav-user-name">User</span>
              <span className="nav-user-sub">local workspace</span>
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
