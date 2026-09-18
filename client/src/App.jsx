import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation, useNavigate } from 'react-router-dom';
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
import { discoverHealthRun } from './components/healthRun.js';

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

/**
 * The page title, and nothing else.
 *
 * What stood here was a global connection bar: the instance host, the scope
 * id, a binding verdict and two status dots, on every route. It is gone — the
 * same four readouts already have a home on Settings and on the Dashboard,
 * where you go to act on them, and repeating them above every table spent a
 * strip of the playground on a status nobody was reading.
 *
 * This is deliberately not a component with a surface. No bar, no border, no
 * card: a heading at the top-left of the playground, in the app's own display
 * face, with the page content directly beneath it.
 */
function PageTitle({ title }) {
  return <h1 className="page-title">{title}</h1>;
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
   * The Agent page is the one immersive route: no page title, no content
   * padding, so the playground background reaches every edge of the area
   * beside the sidebar and the conversation owns the whole height.
   *
   * The health and binding pollers are module-level shared stores with
   * refcounted subscribers, so dropping the connection bar that used to
   * subscribe here changed nothing about either: RequiresInstance gates every
   * ServiceNow route on useHealth, AgentChat subscribes to it for the whole
   * session, and Tables subscribes to useBinding for the scope it reads.
   */
  const immersive = pathname === '/agent';
  const navigate = useNavigate();

  /* A desktop notification's click lands here: go to the page it was about,
     inside the app, without reloading and losing whatever else is running. */
  useEffect(() => {
    const go = (e) => { if (typeof e.detail === 'string') navigate(e.detail); };
    window.addEventListener('nha:navigate', go);
    return () => window.removeEventListener('nha:navigate', go);
  }, [navigate]);

  /* A health check outlives the page that started it. After a reload, pick it
     back up from wherever the app opened, so its outcome is still announced. */
  useEffect(() => { discoverHealthRun(); }, []);

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
        <div className="content" hidden={immersive}>
          {/* Inside the content column, not above it: the playground has one
              vertical flow again, so removing the bar returns its height to
              the page rather than leaving an empty strip. */}
          <PageTitle title={title} />
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
              <Route path="/agent" element={null} />
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
