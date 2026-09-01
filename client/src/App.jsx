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
import TablesPage from './pages/Tables.jsx';
import Applications from './pages/Applications.jsx';
import Transport from './pages/Transport.jsx';
import Audit from './pages/Audit.jsx';
import Settings from './pages/Settings.jsx';
import Toasts from './components/Toasts.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { RequiresInstance } from './components/states.jsx';

const TITLES = {
  '/': 'Dashboard',
  '/agent': 'Agent',
  '/incidents': 'Incident Management',
  '/catalog': 'Catalog Management',
  '/flows': 'Flow Designer',
  '/sla': 'SLA Definitions',
  '/access': 'Access Control',
  '/tables': 'Database Administration',
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

  // D-4 — the tab says which page you left open. With eight routes behind one
  // title, a pinned NowHelpAssist tab was unidentifiable among its own siblings.
  useEffect(() => {
    document.title = pathname === '/' ? 'NowHelpAssist — Agentic ServiceNow Studio' : `${title} — NowHelpAssist`;
    // Navigation in the terminal, so a later error has somewhere to belong.
    logToServer('info', `page ${title}`);
  }, [pathname, title]);

  return (
    <div className="shell">
      <aside className="sidebar">
        {/* The wordmark is unchanged; the mark is the same file the browser
            tab loads, so the two can never drift apart. The subtitle stays on
            its own full-width line — putting it beside the mark cost it 35px
            and broke it onto two. */}
        <div className="logo">
          <span className="logo-row">
            <img className="logomark" src="/favicon.svg" alt="" width="26" height="26" aria-hidden="true" />
            <span>Now<span className="assist">HelpAssist</span></span>
          </span>
          <span className="logo-sub">agentic servicenow studio</span>
        </div>
        <NavLink to="/" end className="navlink">Dashboard</NavLink>
        <NavLink to="/agent" className="navlink">Agent</NavLink>
        <NavLink to="/incidents" className="navlink">Incidents</NavLink>
        <NavLink to="/catalog" className="navlink">Catalog</NavLink>
        <NavLink to="/flows" className="navlink">Flows</NavLink>
        <NavLink to="/sla" className="navlink">SLA</NavLink>
        <NavLink to="/access" className="navlink">Access</NavLink>
        <NavLink to="/tables" className="navlink">Tables</NavLink>
        <NavLink to="/applications" className="navlink">Applications</NavLink>
        <NavLink to="/transport" className="navlink">Transport</NavLink>
        <NavLink to="/audit" className="navlink">Audit</NavLink>
        <NavLink to="/settings" className="navlink">Settings</NavLink>
        <div className="sidebar-foot">v0.1 · phase 1</div>
      </aside>
      <div className="main">
        <Topbar title={title} />
        <div className="content">
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
              <Route path="/agent" element={<AgentChat />} />
              <Route path="/incidents" element={<RequiresInstance what="Incident Management"><Incidents /></RequiresInstance>} />
              <Route path="/catalog" element={<RequiresInstance what="Catalog Management"><Catalog /></RequiresInstance>} />
              <Route path="/flows" element={<RequiresInstance what="Flow Designer"><Flows /></RequiresInstance>} />
              <Route path="/sla" element={<RequiresInstance what="SLA definitions"><Sla /></RequiresInstance>} />
              <Route path="/access" element={<RequiresInstance what="Access control"><Access /></RequiresInstance>} />
              <Route path="/tables" element={<RequiresInstance what="Database administration"><TablesPage /></RequiresInstance>} />
              <Route path="/applications" element={<RequiresInstance what="Applications"><Applications /></RequiresInstance>} />
              <Route path="/transport" element={<RequiresInstance what="Transport"><Transport /></RequiresInstance>} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
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
    </BrowserRouter>
  );
}
