import { Activity, BarChart3, Home, KeyRound, Layers, LayoutTemplate, ListTree, LogOut, Plus, Settings, Table2, User as UserIcon, UserCog, Variable } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Popover, Toasts } from './components/ui';
import { setUnauthorizedHandler } from './lib/api';
import { connectPush, disconnectPush } from './lib/push';
import { ChangePasswordPage, ForgotPasswordPage, SetupPage, SigninPage, SignupPage } from './pages/Auth';
import { ProjectPage, createTeamProject } from './pages/Projects';
import { PersonalSettingsPage, UsersPage } from './pages/Users';
import { displayName, useAuth, useIsAdmin } from './store/auth';
import { CredentialsPage } from './pages/Credentials';
import { DataTablePage, DataTablesPage } from './pages/DataTables';
import { EditorPage } from './pages/Editor';
import { ExecutionsPage } from './pages/Executions';
import { InsightsPage } from './pages/Insights';
import { CommunityNodesPage, ExternalSecretsPage, LogStreamingPage, SourceControlPage } from './pages/Platform';
import { SettingsPage } from './pages/Settings';
import { TemplatesPage } from './pages/Templates';
import { VariablesPage } from './pages/Variables';
import { WorkflowsPage } from './pages/Workflows';
import { useApp } from './store/app';

function UserMenu() {
  const user = useAuth((s) => s.user)!;
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <div style={{ position: 'relative' }}>
      <button className="ghost user-button" onClick={() => setOpen(!open)}>
        <span className="avatar">{displayName(user).slice(0, 1).toUpperCase()}</span>
        <span className="col grow" style={{ gap: 0, minWidth: 0, textAlign: 'left' }}>
          <span className="ellipsis" style={{ fontWeight: 500 }}>{displayName(user)}</span>
          <span className="faint ellipsis" style={{ fontSize: 11 }}>{user.email}</span>
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} style={{ left: 0, bottom: 44 }}>
        <button onClick={() => { setOpen(false); navigate('/settings/personal'); }}><UserCog size={14} /> Personal settings</button>
        <button onClick={() => { setOpen(false); useAuth.getState().signOut(); }}><LogOut size={14} /> Sign out</button>
      </Popover>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const projects = useAuth((s) => s.projects);
  const admin = useIsAdmin();
  const navigate = useNavigate();
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">fm</span> Flowmator
        </div>
        <NavLink to="/home/workflows"><Home size={16} /> Overview</NavLink>
        <NavLink to="/projects/personal/workflows"><UserIcon size={16} /> Personal</NavLink>
        <div className="nav-section row">
          <span className="grow">Projects</span>
          {admin && <button className="ghost icon sm" title="Add project" onClick={() => createTeamProject(navigate)}><Plus size={13} /></button>}
        </div>
        {projects.filter((p) => p.type === 'team').map((p) => (
          <NavLink key={p.id} to={`/projects/${p.id}/workflows`}><Layers size={16} /> <span className="ellipsis">{p.name}</span></NavLink>
        ))}
        <div className="nav-section">Instance</div>
        <NavLink to="/home/executions"><Activity size={16} /> Executions</NavLink>
        <NavLink to="/home/credentials"><KeyRound size={16} /> Credentials</NavLink>
        <NavLink to="/home/variables"><Variable size={16} /> Variables</NavLink>
        <NavLink to="/home/datatables"><Table2 size={16} /> Data tables</NavLink>
        {admin && <NavLink to="/insights"><BarChart3 size={16} /> Insights</NavLink>}
        <NavLink to="/templates"><LayoutTemplate size={16} /> Templates</NavLink>
        <div className="spacer" />
        <NavLink to="/settings" end={false}><Settings size={16} /> Settings</NavLink>
        <UserMenu />
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}

/** Pages for owners and admins only */
function AdminOnly({ children }: { children: React.ReactNode }) {
  return useIsAdmin() ? <>{children}</> : <Navigate to="/home/workflows" replace />;
}

/** Signed out: sign in (or the first-run owner setup), invitation and password reset pages. */
function PublicRoutes({ setup }: { setup: boolean }) {
  const location = useLocation();
  const back = location.pathname.startsWith('/signin') ? '/home/workflows' : `${location.pathname}${location.search}`;
  return (
    <Routes>
      <Route path="/setup" element={setup ? <SetupPage /> : <Navigate to="/signin" replace />} />
      <Route path="/signin" element={setup ? <Navigate to="/setup" replace /> : <SigninPage />} />
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />
      <Route path="*" element={<Navigate to={setup ? '/setup' : `/signin?redirect=${encodeURIComponent(back)}`} replace />} />
    </Routes>
  );
}

/** After signing in on /signin, /setup… go to where the user was headed. */
function AfterSignIn() {
  const redirect = new URLSearchParams(useLocation().search).get('redirect');
  return <Navigate to={redirect?.startsWith('/') ? redirect : '/home/workflows'} replace />;
}

export function App() {
  const status = useAuth((s) => s.status);
  const loaded = useApp((s) => s.loaded);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setUnauthorizedHandler(() => useAuth.getState().expired());
    useAuth.getState().init().catch((e) => setError((e as Error).message));
  }, []);

  // the editor's data needs a session
  useEffect(() => {
    if (status !== 'signedIn') {
      disconnectPush();
      useApp.setState({ loaded: false });
      return;
    }
    useApp.getState().load().catch((e) => setError((e as Error).message));
    connectPush();
  }, [status]);

  if (error) return <div className="empty">Could not reach the Flowmator server: {error}</div>;
  if (status === 'checking') return <div className="empty"><ListTree className="spin" /> Loading…</div>;
  if (status !== 'signedIn') {
    return (
      <BrowserRouter>
        <PublicRoutes setup={status === 'setup'} />
        <Toasts />
      </BrowserRouter>
    );
  }
  if (!loaded) return <div className="empty"><ListTree className="spin" /> Loading…</div>;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/home/workflows" replace />} />
        {['/signin', '/setup', '/signup', '/change-password', '/forgot-password'].map((p) => <Route key={p} path={p} element={<AfterSignIn />} />)}
        <Route path="/projects/:id/workflows" element={<Shell><ProjectPage tab="workflows" /></Shell>} />
        <Route path="/projects/:id/credentials" element={<Shell><ProjectPage tab="credentials" /></Shell>} />
        <Route path="/projects/:id/settings" element={<Shell><ProjectPage tab="settings" /></Shell>} />
        <Route path="/settings/users" element={<Shell><AdminOnly><UsersPage /></AdminOnly></Shell>} />
        <Route path="/settings/personal" element={<Shell><PersonalSettingsPage /></Shell>} />
        <Route path="/home/workflows" element={<Shell><WorkflowsPage /></Shell>} />
        <Route path="/home/executions" element={<Shell><ExecutionsPage /></Shell>} />
        <Route path="/home/credentials" element={<Shell><CredentialsPage /></Shell>} />
        <Route path="/home/variables" element={<Shell><VariablesPage /></Shell>} />
        <Route path="/home/datatables" element={<Shell><DataTablesPage /></Shell>} />
        <Route path="/home/datatables/:id" element={<Shell><DataTablePage /></Shell>} />
        <Route path="/settings" element={<Shell><SettingsPage /></Shell>} />
        <Route path="/settings/environments" element={<Shell><AdminOnly><SourceControlPage /></AdminOnly></Shell>} />
        <Route path="/settings/external-secrets" element={<Shell><AdminOnly><ExternalSecretsPage /></AdminOnly></Shell>} />
        <Route path="/settings/log-streaming" element={<Shell><AdminOnly><LogStreamingPage /></AdminOnly></Shell>} />
        <Route path="/settings/community-nodes" element={<Shell><AdminOnly><CommunityNodesPage /></AdminOnly></Shell>} />
        <Route path="/insights" element={<Shell><AdminOnly><InsightsPage /></AdminOnly></Shell>} />
        <Route path="/templates" element={<Shell><TemplatesPage /></Shell>} />
        <Route path="/workflow/new" element={<EditorPage />} />
        <Route path="/workflow/:id" element={<EditorPage />} />
        <Route path="/workflow/:id/executions" element={<EditorPage tab="executions" />} />
        <Route path="/workflow/:id/executions/:executionId" element={<EditorPage tab="executions" />} />
        <Route path="/workflow/:id/evaluations" element={<EditorPage tab="evaluations" />} />
        <Route path="/workflow/:id/evaluations/:runId" element={<EditorPage tab="evaluations" />} />
        <Route path="*" element={<Navigate to="/home/workflows" replace />} />
      </Routes>
      <Toasts />
    </BrowserRouter>
  );
}
