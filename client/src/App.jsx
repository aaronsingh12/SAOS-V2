import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { useHealth } from './hooks/useHealth.js';
import { useBinding } from './hooks/useBinding.js';
import { describeHeaderStatus, describeScope } from './components/headerStatus.js';
import { logToServer } from './logging.js';
import Dashboard from './pages/Dashboard.jsx';
import AgentChat from './pages/AgentChat.jsx';
import Incidents from './pages/Incidents.jsx';
import Catalog from './pages/Catalog.jsx';
import Flows from './pages/Flows.jsx';
import Sla from './pages/Sla.jsx';
import Access from './pages/Access.jsx';
import HealthAssist from './pages/HealthAssist.jsx';
import TablesPage from './pages/Tables.jsx';
import Meetings from './pages/Meetings.jsx';
import Applications from './pages/Applications.jsx';
import Transport from './pages/Transport.jsx';
import Audit from './pages/Audit.jsx';
import Settings from './pages/Settings.jsx';
import Toasts from './components/Toasts.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import MeetingDock from './components/MeetingDock.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { RequiresInstance } from './components/states.jsx';
import Sidebar from './components/Sidebar.jsx';
import PlaygroundBackground from './components/PlaygroundBackground.jsx';

const TITLES = {
  '/': 'Dashboard',
  '/agent': 'Agent',
  '/incidents': 'Incident Management',
  '/catalog': 'Catalog Management',
  '/flows': 'Flow Designer',
  '/sla': 'SLA Definitions',
  '/access': 'Access Control',
  '/tables': 'Database Administration',
  '/meetings': 'Meeting Intelligence',
  '/applications': 'Applications',
  '/transport': 'Transport',
  '/audit': 'Audit',
  '/settings': 'Settings',
};

function Topbar({ title }) {
  // One poller for the whole app (D-3). This used to be the topbar's private
  // 20s interval, while four other places answered the same question from
  // three other sources and disagreed with it.
  const { connected, instanceUrl, loading, serverDown } = useHealth();
  // The scope and the sync verdict come from their own slower poller: they cost
  // a read of the instance, and /health is the gate every page waits on.
  const bindingSnap = useBinding();
  const host = instanceUrl
    ? instanceUrl.replace(/^https?:\/\//, '')
    : (serverDown ? 'server not responding' : 'no instance bound');
  const scope = describeScope(bindingSnap.scope);
  const status = describeHeaderStatus(bindingSnap);
  return (
    <div className="topbar">
      <h1>{title}</h1>
      {/* Bound instance — unchanged, still the first thing read. */}
      <span className="instance-pill" title={instanceUrl || ''}>
        <span className={`dot ${connected ? 'on' : ''}`} />
        {loading ? 'checking…' : host}
      </span>
      {/* Active scope. The NAME is the address; the app label is the tooltip. */}
      <span className={`badge mono${scope.known ? ' blue' : ''}`} title={scope.title}>
        {scope.text}
      </span>
      {/* Connection + source/instance sync, in one truthful word. */}
      <span className={`instance-pill status-${status.tone}`} title={status.title}>
        <span className={`dot ${status.dotClass}`} />
        {status.label}
      </span>
    </div>
  );
}

/**
 * Everything that needs router context lives here rather than in App, which
 * renders the router itself — `useLocation` one level up throws, and that is
 * exactly the class of render error the boundary below now contains.
 */
function Shell() {
  const { pathname } = useLocation();
  const title = TITLES[pathname] || 'NowHelpAssist';
  /*
   * The Agent page is the one immersive route: no topbar, no content padding,
   * so the playground background reaches every edge of the area beside the
   * sidebar.
   *
   * The Topbar COMPONENT is untouched and still renders on all twelve other
   * routes — this decides where it is drawn, not what it does. Its readouts
   * come from useHealth and useBinding, which are module-level shared stores
   * with refcounted subscribers: not mounting one subscriber here changes
   * nothing about the binding, and AgentChat is itself a useHealth subscriber,
   * so the health poller keeps running on this route regardless.
   */
  const immersive = pathname === '/agent';

  // D-4 — the tab says which page you left open. With eight routes behind one
  // title, a pinned NowHelpAssist tab was unidentifiable among its own siblings.
  useEffect(() => {
    document.title = pathname === '/' ? 'NowHelpAssist — Agentic ServiceNow Studio' : `${title} — NowHelpAssist`;
    // Navigation in the terminal, so a later error has somewhere to belong.
    logToServer('info', `page ${title}`);
  }, [pathname, title]);

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        {/*
          * THE SHARED PLAYGROUND BACKGROUND.
          *
          * One instance for the whole application, mounted here rather than
          * inside any page, so it is a property of the shell and not of a
          * route. Navigating cannot remount it: the waves keep running while
          * the content above them swaps, which is what makes the background
          * read as constant.
          *
          * It is a LAYER, not a wrapper. Absolutely placed, so it takes no
          * space in .main's flex flow and no page had to be restructured to
          * sit "inside" it; pointer-events: none, so it can never take a click
          * meant for a form, a table row or a button above it.
          */}
        <PlaygroundBackground />
        {!immersive && <Topbar title={title} />}
        <div className="content" hidden={immersive}>
          {/* Keyed on the path so navigating away clears a caught error — a
              boundary that latches means one bad page bricks the session. */}
          <ErrorBoundary key={pathname} where={title}>
            {/* The instance gate is a ROUTE wrapper, not something a page
                wraps around its own JSX. Gating the returned markup gates what
                a page draws, not what it does: the component is mounted by
                then and its load effect has already fired. Measured — the
                disconnected sweep logged fourteen 400s that way. Here, React
                never mounts the page at all.

                Dashboard, Agent and Settings are deliberately NOT gated: you
                connect an instance on one, configure a model on another, and
                the agent is still worth reading offline. Those show the
                banner instead. */}
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/incidents" element={<RequiresInstance what="Incident Management"><Incidents /></RequiresInstance>} />
              <Route path="/catalog" element={<RequiresInstance what="Catalog Management"><Catalog /></RequiresInstance>} />
              <Route path="/flows" element={<RequiresInstance what="Flow Designer"><Flows /></RequiresInstance>} />
              <Route path="/sla" element={<RequiresInstance what="SLA definitions"><Sla /></RequiresInstance>} />
              <Route path="/access" element={<RequiresInstance what="Access control"><Access /></RequiresInstance>} />
              <Route path="/health" element={<RequiresInstance what="Health Assist"><HealthAssist /></RequiresInstance>} />
              <Route path="/tables" element={<RequiresInstance what="Database administration"><TablesPage /></RequiresInstance>} />
              {/* Deliberately NOT gated. Capturing a meeting and reviewing what
                  was said needs no ServiceNow instance at all — only BUILDING
                  from it does, and that gate belongs on the build action rather
                  than on the page. Gating here would mean you cannot review
                  last night's meeting on a plane. */}
              <Route path="/meetings" element={<Meetings />} />
              <Route path="/applications" element={<RequiresInstance what="Applications"><Applications /></RequiresInstance>} />
              <Route path="/transport" element={<RequiresInstance what="Transport"><Transport /></RequiresInstance>} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </ErrorBoundary>
        </div>

        {/*
          * THE AGENT PAGE IS MOUNTED ONCE, FOR THE WHOLE SESSION.
          *
          * Its chats, tasks, skills, history and the two turn switches are
          * required to be in the global sidebar on EVERY route, and all of
          * that state lives here — the session id, the loaded list, the search
          * hits, the running flag that makes rows inert mid-turn, the capture
          * and auto-approve values re-read on every session switch. The
          * alternative was hoisting the entire turn engine, SSE callbacks and
          * all, into a provider: a rewrite of working code to change where a
          * panel is drawn.
          *
          * So the component simply never unmounts. Only its VISIBILITY is
          * routed. Nothing inside it changed; its portals keep filling the
          * sidebar from wherever you are, and a turn started on /agent now
          * survives a trip to Incidents instead of being torn down mid-stream.
          *
          * Its own boundary, because it is no longer inside the routed one —
          * and unkeyed, because latching is the right behaviour here: this
          * subtree is not remounted by navigation, so clearing it on a path
          * change would clear an error nothing had fixed.
          */}
        <div className="agent-host" hidden={!immersive}>
          <ErrorBoundary where="Agent">
            <AgentChat />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Shell />
      {/* Mounted once, outside the routed content: a toast raised by a page
          that is navigating away must still be readable, the dialog must
          outlive the row that opened it, and neither may be unmounted by the
          error boundary catching a page. */}
      <Toasts />
      <ConfirmDialog />
      {/* M6 — the meeting capture control, deliberately app-wide. You start
          recording BEFORE you go and look at meetings, so a button that lives
          on the Meetings page is one you reach too late. Mounted here for the
          same reason as the two above: it must survive navigation and must not
          be unmounted by the boundary catching a page. It renders nothing at
          all when this build does not ship the capture agent. */}
      <MeetingDock />
    </BrowserRouter>
  );
}
