import { ChevronRight, Copy, GitBranch, KeySquare, Package, Plus, Radio, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { timeAgo } from '../components/ui';
import { Api } from '../lib/api';
import { errorToast, useApp } from '../store/app';

export function SettingsPage() {
  const settings = useApp((s) => s.settings);
  const [keys, setKeys] = useState<Array<{ id: string; label: string; apiKey: string; createdAt: string }>>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => localStorageGet('8n8-theme') ?? 'system');
  const refresh = useCallback(() => Api.apiKeys().then(setKeys, errorToast('Could not load API keys')), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const applyTheme = (t: string) => {
    setTheme(t);
    localStorageSet('8n8-theme', t);
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  };

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-header"><h1>Settings</h1></div>

      <section className="card col" style={{ padding: 6, marginBottom: 18, gap: 0 }}>
        {[
          ['/settings/environments', GitBranch, 'Environments', 'Push and pull workflows with a Git repository'],
          ['/settings/external-secrets', KeySquare, 'External secrets', 'Vault, AWS, Azure and GCP secrets in credentials'],
          ['/settings/log-streaming', Radio, 'Log streaming', 'Send events to a webhook, syslog or Sentry'],
          ['/settings/community-nodes', Package, 'Community nodes', 'Install n8n-nodes-* packages from npm'],
        ].map(([to, Icon, title, desc]) => {
          const I = Icon as typeof GitBranch;
          return (
            <Link key={to as string} to={to as string} className="row settings-link">
              <I size={16} />
              <span className="grow col" style={{ gap: 0 }}><strong>{title as string}</strong><span className="faint">{desc as string}</span></span>
              <ChevronRight size={14} className="faint" />
            </Link>
          );
        })}
      </section>

      <section className="card col" style={{ padding: 18, marginBottom: 18 }}>
        <h2>Appearance</h2>
        <div className="row">
          <span className="grow">Theme</span>
          <select style={{ width: 160 }} value={theme} onChange={(e) => applyTheme(e.target.value)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </section>

      <section className="card col" style={{ padding: 18, marginBottom: 18 }}>
        <div className="row">
          <h2 className="grow">API keys</h2>
          <button className="primary" onClick={async () => {
            const label = prompt('Label for this key', 'My key');
            if (!label) return;
            const created = await Api.createApiKey(label).catch(errorToast('Could not create key'));
            if (created) {
              setNewKey(created.apiKey);
              refresh();
            }
          }}><Plus size={14} /> Create key</button>
        </div>
        <div className="muted">Use the public API at <code>/api/v1</code> with the header <code>X-N8N-API-KEY</code>.</div>
        {newKey && (
          <div className="card row" style={{ padding: 10, borderColor: 'var(--success)' }}>
            <code className="grow ellipsis">{newKey}</code>
            <button className="sm" onClick={() => { navigator.clipboard.writeText(newKey); useApp.getState().toast('success', 'Copied'); }}><Copy size={12} /> Copy</button>
            <span className="faint">Shown once</span>
          </div>
        )}
        {keys.map((k) => (
          <div key={k.id} className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
            <span className="grow" style={{ fontWeight: 500 }}>{k.label}</span>
            <code className="faint">{k.apiKey}</code>
            <span className="faint">{timeAgo(k.createdAt)}</span>
            <button className="ghost icon sm danger" onClick={() => Api.deleteApiKey(k.id).then(refresh)}><Trash2 size={13} /></button>
          </div>
        ))}
      </section>

      <section className="card col" style={{ padding: 18 }}>
        <h2>Instance</h2>
        {Object.entries(settings).map(([k, v]) => (
          <div key={k} className="row"><span className="grow muted">{k}</span><code>{String(v)}</code></div>
        ))}
      </section>
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

// apply the saved theme on load
const saved = localStorageGet('8n8-theme');
if (saved && saved !== 'system') document.documentElement.setAttribute('data-theme', saved);
