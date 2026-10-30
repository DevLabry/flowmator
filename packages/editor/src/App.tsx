import { Activity, KeyRound, ListTree, Settings, Table2, Variable, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Toasts } from './components/ui';
import { connectPush } from './lib/push';
import { CredentialsPage } from './pages/Credentials';
import { DataTablePage, DataTablesPage } from './pages/DataTables';
import { EditorPage } from './pages/Editor';
import { ExecutionsPage } from './pages/Executions';
import { SettingsPage } from './pages/Settings';
import { VariablesPage } from './pages/Variables';
import { WorkflowsPage } from './pages/Workflows';
import { useApp } from './store/app';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark">8n8</span> 8n8
        </div>
        <NavLink to="/home/workflows"><Workflow size={16} /> Workflows</NavLink>
        <NavLink to="/home/executions"><Activity size={16} /> Executions</NavLink>
        <NavLink to="/home/credentials"><KeyRound size={16} /> Credentials</NavLink>
        <NavLink to="/home/variables"><Variable size={16} /> Variables</NavLink>
        <NavLink to="/home/datatables"><Table2 size={16} /> Data tables</NavLink>
        <div className="spacer" />
        <NavLink to="/settings"><Settings size={16} /> Settings</NavLink>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}

export function App() {
  const loaded = useApp((s) => s.loaded);
  const [error, setError] = useState<string>();

  useEffect(() => {
    useApp.getState().load().catch((e) => setError((e as Error).message));
    connectPush();
  }, []);

  if (error) return <div className="empty">Could not reach the 8n8 server: {error}</div>;
  if (!loaded) return <div className="empty"><ListTree className="spin" /> Loading…</div>;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/home/workflows" replace />} />
        <Route path="/home/workflows" element={<Shell><WorkflowsPage /></Shell>} />
        <Route path="/home/executions" element={<Shell><ExecutionsPage /></Shell>} />
        <Route path="/home/credentials" element={<Shell><CredentialsPage /></Shell>} />
        <Route path="/home/variables" element={<Shell><VariablesPage /></Shell>} />
        <Route path="/home/datatables" element={<Shell><DataTablesPage /></Shell>} />
        <Route path="/home/datatables/:id" element={<Shell><DataTablePage /></Shell>} />
        <Route path="/settings" element={<Shell><SettingsPage /></Shell>} />
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
