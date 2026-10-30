import { ArrowDownToLine, ArrowUpFromLine, Copy, GitBranch, Package, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Modal, Switch, timeAgo } from '../components/ui';
import { Api, ApiError, type CommunityPackage, type LogDestination, type SecretProvider, type SourceControlFile, type SourceControlPrefs } from '../lib/api';
import { errorToast, useApp } from '../store/app';

const toast = (kind: 'success' | 'error', msg: string) => useApp.getState().toast(kind, msg);

const field = (label: string, control: React.ReactNode, hint?: React.ReactNode) => (
  <div>
    <label className="field-label">{label}</label>
    {control}
    {hint && <div className="faint" style={{ marginTop: 4, fontSize: 12 }}>{hint}</div>}
  </div>
);

/* ===================== Source control ===================== */

export function SourceControlPage() {
  const [prefs, setPrefs] = useState<SourceControlPrefs>();
  const [draft, setDraft] = useState<Partial<SourceControlPrefs> & { httpsPassword?: string }>({});
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => Api.sourceControlPrefs().then((p) => { setPrefs(p); setDraft({}); }, errorToast('Could not load source control settings')), []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (prefs?.connected) Api.sourceControlBranches().then((b) => setBranches(b.branches), () => {});
  }, [prefs?.connected]);
  if (!prefs) return null;
  const v = { ...prefs, ...draft };
  const set = (p: Partial<typeof draft>) => setDraft({ ...draft, ...p });

  const save = async (extra: Partial<SourceControlPrefs> = {}) => {
    setBusy(true);
    try {
      setPrefs(await Api.saveSourceControlPrefs({ ...draft, ...extra }));
      setDraft({});
      toast('success', extra.connected ? 'Connected to the repository' : 'Saved');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-header">
        <div>
          <h1>Environments</h1>
          <div className="muted" style={{ marginTop: 4 }}>Keep workflows, credential stubs, variables, tags and folders in a Git branch. Push from one instance and pull into another.</div>
        </div>
        {prefs.connected && <span className="badge success"><GitBranch size={12} /> {prefs.branchName}</span>}
      </div>

      <section className="card col" style={{ padding: 18, gap: 14, marginBottom: 18 }}>
        <h2>Git repository</h2>
        {field('Connection', (
          <select value={v.connectionType} disabled={prefs.connected} onChange={(e) => set({ connectionType: e.target.value as 'ssh' | 'https' })}>
            <option value="ssh">SSH (deploy key)</option>
            <option value="https">HTTPS (username + token)</option>
          </select>
        ))}
        {field('Repository URL', <input className="mono" disabled={prefs.connected} placeholder={v.connectionType === 'ssh' ? 'git@github.com:me/workflows.git' : 'https://github.com/me/workflows.git'} value={v.repositoryUrl} onChange={(e) => set({ repositoryUrl: e.target.value })} />)}
        {v.connectionType === 'https' ? (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow">{field('Username', <input disabled={prefs.connected} value={v.httpsUsername ?? ''} onChange={(e) => set({ httpsUsername: e.target.value })} />)}</div>
            <div className="grow">{field('Token / password', <input type="password" disabled={prefs.connected} placeholder={prefs.hasHttpsPassword ? '••••••••' : ''} value={draft.httpsPassword ?? ''} onChange={(e) => set({ httpsPassword: e.target.value })} />)}</div>
          </div>
        ) : (
          field(
            'SSH key',
            <div className="row">
              <code className="grow ellipsis card" style={{ padding: '6px 8px' }}>{prefs.publicKey ?? 'No key yet — one is generated when you connect'}</code>
              {prefs.publicKey && <button className="sm" onClick={() => { navigator.clipboard.writeText(prefs.publicKey!); toast('success', 'Copied'); }}><Copy size={12} /> Copy</button>}
              <select style={{ width: 110 }} value={v.keyGeneratorType} onChange={(e) => set({ keyGeneratorType: e.target.value as 'ed25519' | 'rsa' })}>
                <option value="ed25519">ED25519</option>
                <option value="rsa">RSA</option>
              </select>
              <button className="sm" onClick={async () => { await Api.generateKeyPair(v.keyGeneratorType).catch(errorToast('Could not generate key')); load(); }}><RefreshCw size={12} /> Regenerate</button>
            </div>,
            'Add this public key to the repository as a deploy key with write access.',
          )
        )}
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">{field('Commit author', <input value={v.authorName} onChange={(e) => set({ authorName: e.target.value })} />)}</div>
          <div className="grow">{field('Author email', <input value={v.authorEmail} onChange={(e) => set({ authorEmail: e.target.value })} />)}</div>
        </div>
        {!prefs.connected ? (
          <>
            {field('Branch', <input className="mono" value={v.branchName} onChange={(e) => set({ branchName: e.target.value })} />, 'Created on the first push if it does not exist yet.')}
            <div className="row"><button className="primary" disabled={busy || !v.repositoryUrl} onClick={() => save({ connected: true })}>{busy ? 'Connecting…' : 'Connect'}</button></div>
          </>
        ) : (
          <>
            {field('Branch', (
              <div className="row">
                <select className="grow" value={v.branchName} onChange={(e) => set({ branchName: e.target.value })}>
                  {[...new Set([prefs.branchName, ...branches])].map((b) => <option key={b}>{b}</option>)}
                </select>
                <button className="sm ghost" onClick={() => Api.sourceControlBranches().then((b) => setBranches(b.branches), errorToast('Could not list branches'))}><RefreshCw size={12} /></button>
              </div>
            ))}
            <div className="row"><span className="grow">Protected instance (read-only branch: pulling only)</span><Switch checked={v.branchReadOnly} onChange={(x) => set({ branchReadOnly: x })} /></div>
            {field('Color', <input type="color" style={{ width: 60, padding: 2 }} value={v.branchColor} onChange={(e) => set({ branchColor: e.target.value })} />)}
            <div className="row">
              <button className="primary" disabled={busy || !Object.keys(draft).length} onClick={() => save()}>Save settings</button>
              <span className="grow" />
              <button className="danger" onClick={async () => { if (confirm('Disconnect from the repository? Local workflows stay as they are.')) { await Api.disconnectSourceControl(); load(); } }}>Disconnect</button>
            </div>
          </>
        )}
      </section>

      {prefs.connected && <SourceControlSync readOnly={prefs.branchReadOnly} />}
    </div>
  );
}

function SourceControlSync({ readOnly }: { readOnly: boolean }) {
  const [files, setFiles] = useState<SourceControlFile[]>();
  const [pushing, setPushing] = useState(false);
  const [diff, setDiff] = useState<{ file: string; local: string | null; remote: string | null }>();
  const refresh = useCallback(() => {
    setFiles(undefined);
    Api.sourceControlStatus().then(setFiles, (e) => { toast('error', (e as Error).message); setFiles([]); });
  }, []);
  useEffect(refresh, [refresh]);

  const local = files?.filter((f) => f.location === 'local') ?? [];
  const remote = files?.filter((f) => f.location === 'remote' || f.conflict) ?? [];

  const pull = async (force = false) => {
    try {
      const r = await Api.pull(force);
      toast('success', r.pulled.length ? `Pulled ${r.pulled.length} change${r.pulled.length === 1 ? '' : 's'}` : 'Up to date');
      refresh();
      useApp.getState().load().catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && confirm(`${e.message}\n\nOverwrite the local versions?`)) return pull(true);
      toast('error', (e as Error).message);
    }
  };

  return (
    <section className="card col" style={{ padding: 18, gap: 12 }}>
      <div className="row">
        <h2 className="grow">Changes</h2>
        <button className="sm ghost" onClick={refresh}><RefreshCw size={12} /> Refresh</button>
        <button className="sm" onClick={() => pull()}><ArrowDownToLine size={13} /> Pull</button>
        {!readOnly && <button className="sm primary" disabled={!local.length} onClick={() => setPushing(true)}><ArrowUpFromLine size={13} /> Push</button>}
      </div>
      {!files && <div className="muted">Checking the repository…</div>}
      {files && !files.length && <div className="muted">Everything is in sync.</div>}
      {files && files.length > 0 && (
        <table className="list">
          <thead><tr><th>Name</th><th>Type</th><th>Change</th><th>Where</th><th /></tr></thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.file}>
                <td>{f.name}</td>
                <td className="muted">{f.type}</td>
                <td><span className={`badge ${f.status === 'deleted' ? 'error' : f.status === 'created' ? 'success' : 'accent'}`}>{f.status}</span>{f.conflict && <span className="badge warning" style={{ marginLeft: 4 }}>conflict</span>}</td>
                <td className="muted">{f.location === 'local' ? 'this instance' : 'repository'}</td>
                <td><button className="sm ghost" onClick={() => Api.sourceControlDiff(f.file).then(setDiff, errorToast('Could not load diff'))}>Compare</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {remote.length > 0 && <div className="faint">{remote.length} change{remote.length === 1 ? '' : 's'} to pull.</div>}
      {pushing && <PushModal files={local} onClose={() => setPushing(false)} onDone={refresh} />}
      {diff && (
        <Modal title={diff.file} width={980} onClose={() => setDiff(undefined)}>
          <div className="row" style={{ alignItems: 'stretch', gap: 12 }}>
            {(['local', 'remote'] as const).map((side) => (
              <div key={side} className="grow col" style={{ minWidth: 0, flexBasis: 0 }}>
                <span className="label">{side === 'local' ? 'This instance' : 'Repository'}</span>
                <pre className="card mono" style={{ padding: 10, maxHeight: 480, overflow: 'auto', fontSize: 11, margin: 0 }}>{diff[side] ?? '(none)'}</pre>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}

function PushModal({ files, onClose, onDone }: { files: SourceControlFile[]; onClose: () => void; onDone: () => void }) {
  const [selected, setSelected] = useState(() => new Set(files.map((f) => f.file)));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const push = async (force = false) => {
    setBusy(true);
    try {
      const r = await Api.push({ commitMessage: message, fileNames: [...selected], force });
      toast('success', r.commit ? `Pushed ${r.commit.slice(0, 7)}` : 'Nothing to push');
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && confirm(`${e.message}\n\nOverwrite the remote versions?`)) return push(true);
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Commit and push changes" width={620} onClose={onClose} footer={<button className="primary" disabled={busy || !selected.size} onClick={() => push()}><Send size={13} /> Commit and push</button>}>
      <div className="col" style={{ gap: 6, maxHeight: 320, overflow: 'auto' }}>
        {files.map((f) => (
          <label key={f.file} className="row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={selected.has(f.file)} onChange={(e) => { const s = new Set(selected); if (e.target.checked) s.add(f.file); else s.delete(f.file); setSelected(s); }} />
            <span className="grow">{f.name} <span className="faint">({f.type})</span></span>
            <span className={`badge ${f.status === 'deleted' ? 'error' : f.status === 'created' ? 'success' : 'accent'}`}>{f.status}</span>
            {f.conflict && <span className="badge warning">conflict</span>}
            {f.updatedAt && <span className="faint">{timeAgo(f.updatedAt)}</span>}
          </label>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>{field('Commit message', <input autoFocus placeholder="Describe the change" value={message} onChange={(e) => setMessage(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && push()} />)}</div>
    </Modal>
  );
}

/* ===================== External secrets ===================== */

export function ExternalSecretsPage() {
  const [providers, setProviders] = useState<SecretProvider[]>([]);
  const [editing, setEditing] = useState<SecretProvider>();
  const load = useCallback(() => Api.secretProviders().then(setProviders, errorToast('Could not load secret providers')), []);
  useEffect(() => void load(), [load]);

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-header">
        <div>
          <h1>External secrets</h1>
          <div className="muted" style={{ marginTop: 4 }}>Use secrets from a vault in credential fields with <code>{'{{ $secrets.<provider>.<name> }}'}</code>. They are refreshed every 5 minutes.</div>
        </div>
      </div>
      <div className="col" style={{ gap: 12 }}>
        {providers.map((p) => (
          <div key={p.name} className="card row" style={{ padding: 14 }}>
            <div className="grow col" style={{ gap: 2 }}>
              <strong>{p.displayName}</strong>
              <span className="faint">
                {p.connected ? `${p.secrets.length} secret${p.secrets.length === 1 ? '' : 's'}${p.updatedAt ? ` · updated ${timeAgo(p.updatedAt)}` : ''}` : 'Not connected'}
                {p.error && <span className="text-danger"> · {p.error}</span>}
              </span>
            </div>
            <span className={`badge ${p.state === 'connected' ? 'success' : p.state === 'error' ? 'error' : ''}`}>{p.state}</span>
            {p.connected && <button className="sm ghost" title="Reload secrets" onClick={() => Api.refreshSecretProvider(p.name).then(load)}><RefreshCw size={12} /></button>}
            <Switch checked={p.connected} onChange={(on) => Api.connectSecretProvider(p.name, on).then(load, errorToast('Could not connect'))} />
            <button className="sm" onClick={() => setEditing(p)}>Set up</button>
          </div>
        ))}
      </div>
      {editing && <SecretProviderModal provider={editing} onClose={() => setEditing(undefined)} onSaved={load} />}
    </div>
  );
}

function SecretProviderModal({ provider, onClose, onSaved }: { provider: SecretProvider; onClose: () => void; onSaved: () => void }) {
  const [settings, setSettings] = useState(provider.settings);
  const [result, setResult] = useState<{ success: boolean; count?: number; error?: string }>();
  const visible = provider.properties.filter((p) => {
    // Vault shows only the fields of the chosen auth method
    if (provider.name !== 'vault') return true;
    const auth = settings.authMethod ?? 'token';
    if (p.name === 'token') return auth === 'token';
    if (p.name === 'roleId' || p.name === 'secretId') return auth === 'appRole';
    if (p.name === 'username' || p.name === 'password') return auth === 'usernameAndPassword';
    return true;
  });
  const save = async (connect: boolean) => {
    await Api.saveSecretProvider(provider.name, settings);
    if (connect) await Api.connectSecretProvider(provider.name, true);
    onSaved();
    onClose();
  };
  return (
    <Modal
      title={provider.displayName}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button onClick={() => Api.testSecretProvider(provider.name, settings).then(setResult, errorToast('Test failed'))}>Test connection</button>
          <button onClick={() => save(false).catch(errorToast('Could not save'))}>Save</button>
          <button className="primary" onClick={() => save(true).catch(errorToast('Could not connect'))}>Save and connect</button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        {visible.map((p) =>
          field(
            p.displayName,
            p.type === 'options' ? (
              <select value={String(settings[p.name] ?? p.default ?? '')} onChange={(e) => setSettings({ ...settings, [p.name]: e.target.value })}>
                {p.options!.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <input type={p.type === 'password' ? 'password' : 'text'} placeholder={p.placeholder} value={String(settings[p.name] ?? '')} onChange={(e) => setSettings({ ...settings, [p.name]: e.target.value })} />
            ),
            p.hint,
          ),
        )}
        {result && (
          <div className={`card ${result.success ? 'text-success' : 'text-danger'}`} style={{ padding: 10 }}>
            {result.success ? `Connection works: ${result.count} secret${result.count === 1 ? '' : 's'} found` : result.error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ===================== Log streaming ===================== */

const DEST_TYPES: Array<[LogDestination['type'], string]> = [
  ['$$MessageEventBusDestinationWebhook', 'Webhook'],
  ['$$MessageEventBusDestinationSyslog', 'Syslog'],
  ['$$MessageEventBusDestinationSentry', 'Sentry'],
];

export function LogStreamingPage() {
  const [list, setList] = useState<LogDestination[]>([]);
  const [editing, setEditing] = useState<Partial<LogDestination>>();
  const load = useCallback(() => Api.destinations().then(setList, errorToast('Could not load destinations')), []);
  useEffect(() => void load(), [load]);

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-header">
        <div>
          <h1>Log streaming</h1>
          <div className="muted" style={{ marginTop: 4 }}>Send workflow, node and audit events to a webhook, a syslog server or Sentry.</div>
        </div>
        <button className="primary" onClick={() => setEditing({ type: '$$MessageEventBusDestinationWebhook', label: 'New destination', enabled: true, subscribedEvents: ['n8n.workflow'], method: 'POST', headers: [] })}><Plus size={14} /> Add destination</button>
      </div>
      <div className="col" style={{ gap: 12 }}>
        {!list.length && <div className="card muted" style={{ padding: 24, textAlign: 'center' }}>No destinations yet</div>}
        {list.map((d) => (
          <div key={d.id} className="card row" style={{ padding: 14 }}>
            <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
              <strong>{d.label}</strong>
              <span className="faint ellipsis">
                {DEST_TYPES.find(([t]) => t === d.type)?.[1]} · {d.url ?? (d.host ? `${d.protocol}://${d.host}:${d.port}` : d.dsn?.replace(/\/\/[^@]+@/, '//…@'))} · {d.subscribedEvents.join(', ')}
              </span>
              {d.lastError && <span className="text-danger" style={{ fontSize: 12 }}>Last delivery failed {timeAgo(d.lastError.at)}: {d.lastError.message}</span>}
            </div>
            <Switch checked={d.enabled} onChange={(enabled) => Api.saveDestination({ ...d, enabled }).then(load)} />
            <button className="sm" onClick={() => Api.testDestination(d.id).then((ok) => { toast(ok ? 'success' : 'error', ok ? 'Test event delivered' : 'Test event failed'); load(); })}><Send size={12} /> Test</button>
            <button className="sm" onClick={() => setEditing(d)}>Edit</button>
            <button className="ghost icon sm danger" onClick={() => confirm(`Delete ${d.label}?`) && Api.deleteDestination(d.id).then(load)}><Trash2 size={13} /></button>
          </div>
        ))}
      </div>
      {editing && <DestinationModal initial={editing} onClose={() => setEditing(undefined)} onSaved={load} />}
    </div>
  );
}

function DestinationModal({ initial, onClose, onSaved }: { initial: Partial<LogDestination>; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(initial);
  const [eventNames, setEventNames] = useState<Record<string, string[]>>({});
  useEffect(() => void Api.eventNames().then(setEventNames, () => {}), []);
  const set = (p: Partial<LogDestination>) => setD({ ...d, ...p });
  const subs = new Set(d.subscribedEvents ?? []);
  const toggle = (name: string, on: boolean) => {
    const s = new Set(subs);
    if (on) s.add(name);
    else s.delete(name);
    set({ subscribedEvents: [...s] });
  };
  const save = () =>
    Api.saveDestination(d).then(() => {
      onSaved();
      onClose();
    }, errorToast('Could not save destination'));

  return (
    <Modal title={d.id ? 'Edit destination' : 'New destination'} width={680} onClose={onClose} footer={<button className="primary" onClick={save}>Save</button>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="grow">{field('Name', <input value={d.label ?? ''} onChange={(e) => set({ label: e.target.value })} />)}</div>
          <div style={{ width: 180 }}>{field('Type', (
            <select value={d.type} disabled={!!d.id} onChange={(e) => set({ type: e.target.value as LogDestination['type'] })}>
              {DEST_TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
            </select>
          ))}</div>
        </div>
        {d.type === '$$MessageEventBusDestinationWebhook' && (
          <>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <div style={{ width: 110 }}>{field('Method', <select value={d.method ?? 'POST'} onChange={(e) => set({ method: e.target.value })}>{['POST', 'PUT', 'GET'].map((m) => <option key={m}>{m}</option>)}</select>)}</div>
              <div className="grow">{field('URL', <input className="mono" placeholder="https://logs.example.com/8n8" value={d.url ?? ''} onChange={(e) => set({ url: e.target.value })} />)}</div>
            </div>
            {field('Headers', (
              <div className="col" style={{ gap: 6 }}>
                {(d.headers ?? []).map((h, i) => (
                  <div key={i} className="row">
                    <input placeholder="Name" value={h.name} onChange={(e) => set({ headers: d.headers!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                    <input placeholder="Value" value={h.value} onChange={(e) => set({ headers: d.headers!.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                    <button className="ghost icon sm danger" onClick={() => set({ headers: d.headers!.filter((_, j) => j !== i) })}><Trash2 size={13} /></button>
                  </div>
                ))}
                <button className="sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ headers: [...(d.headers ?? []), { name: '', value: '' }] })}><Plus size={12} /> Add header</button>
              </div>
            ))}
          </>
        )}
        {d.type === '$$MessageEventBusDestinationSyslog' && (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow">{field('Host', <input value={d.host ?? '127.0.0.1'} onChange={(e) => set({ host: e.target.value })} />)}</div>
            <div style={{ width: 90 }}>{field('Port', <input type="number" value={d.port ?? 514} onChange={(e) => set({ port: Number(e.target.value) })} />)}</div>
            <div style={{ width: 90 }}>{field('Protocol', <select value={d.protocol ?? 'udp'} onChange={(e) => set({ protocol: e.target.value as 'udp' | 'tcp' })}><option>udp</option><option>tcp</option></select>)}</div>
            <div style={{ width: 90 }}>{field('Facility', <input type="number" min={0} max={23} value={d.facility ?? 16} onChange={(e) => set({ facility: Number(e.target.value) })} />)}</div>
            <div style={{ width: 110 }}>{field('App name', <input value={d.app_name ?? '8n8'} onChange={(e) => set({ app_name: e.target.value })} />)}</div>
          </div>
        )}
        {d.type === '$$MessageEventBusDestinationSentry' && field('DSN', <input className="mono" placeholder="https://key@o0.ingest.sentry.io/0" value={d.dsn ?? ''} onChange={(e) => set({ dsn: e.target.value })} />)}

        {field('Events', (
          <div className="col card" style={{ padding: 10, gap: 10, maxHeight: 300, overflow: 'auto' }}>
            {Object.entries(eventNames).map(([group, names]) => (
              <div key={group} className="col" style={{ gap: 4 }}>
                <label className="row" style={{ fontWeight: 600 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={subs.has(`n8n.${group}`)} onChange={(e) => toggle(`n8n.${group}`, e.target.checked)} /> All {group} events
                </label>
                {!subs.has(`n8n.${group}`) && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 2, paddingLeft: 22 }}>
                    {names.map((n) => (
                      <label key={n} className="row mono" style={{ fontSize: 12 }}>
                        <input type="checkbox" style={{ width: 'auto' }} checked={subs.has(n)} onChange={(e) => toggle(n, e.target.checked)} /> {n}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ===================== Community nodes ===================== */

export function CommunityNodesPage() {
  const [list, setList] = useState<CommunityPackage[]>([]);
  const [installing, setInstalling] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string>();
  const load = useCallback(() => Api.communityPackages().then(setList, errorToast('Could not load packages')), []);
  useEffect(() => void load(), [load]);
  // node types changed: reload them so the node panel shows the new nodes
  const reloadTypes = () => useApp.getState().load().catch(() => {});

  const install = async () => {
    setBusy(name);
    try {
      const p = await Api.installPackage(name.trim());
      toast('success', `Installed ${p.packageName} (${p.installedNodes.length} node${p.installedNodes.length === 1 ? '' : 's'})`);
      setInstalling(false);
      setName('');
      load();
      reloadTypes();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-header">
        <div>
          <h1>Community nodes</h1>
          <div className="muted" style={{ marginTop: 4 }}>Install n8n community node packages from npm (<code>n8n-nodes-*</code>). They run with full access to this machine: only install packages you trust.</div>
        </div>
        <div className="row">
          {list.length > 0 && <button onClick={() => Api.checkPackageUpdates().then(setList, errorToast('Could not check updates'))}><RefreshCw size={13} /> Check updates</button>}
          <button className="primary" onClick={() => setInstalling(true)}><Plus size={14} /> Install</button>
        </div>
      </div>
      <div className="col" style={{ gap: 12 }}>
        {!list.length && <div className="card muted" style={{ padding: 24, textAlign: 'center' }}>No community packages installed</div>}
        {list.map((p) => (
          <div key={p.packageName} className="card row" style={{ padding: 14, alignItems: 'flex-start' }}>
            <Package size={18} style={{ marginTop: 2 }} />
            <div className="grow col" style={{ gap: 2 }}>
              <strong>{p.packageName} <span className="faint" style={{ fontWeight: 400 }}>v{p.installedVersion}</span></strong>
              <span className="muted">{p.installedNodes.map((n) => n.name).join(', ') || '—'}</span>
              {p.failedLoading && <span className="text-danger">Failed to load: {p.failedLoading}</span>}
            </div>
            {p.updateAvailable && (
              <button className="sm primary" disabled={busy === p.packageName} onClick={async () => {
                setBusy(p.packageName);
                await Api.updatePackage(p.packageName, p.updateAvailable).then(() => { load(); reloadTypes(); }, errorToast('Update failed'));
                setBusy(undefined);
              }}>Update to {p.updateAvailable}</button>
            )}
            <button className="sm danger" disabled={busy === p.packageName} onClick={async () => {
              if (!confirm(`Uninstall ${p.packageName}? Workflows that use its nodes will stop working after a restart.`)) return;
              await Api.uninstallPackage(p.packageName).then(load, errorToast('Uninstall failed'));
            }}>Uninstall</button>
          </div>
        ))}
      </div>
      {installing && (
        <Modal title="Install community nodes" width={520} onClose={() => setInstalling(false)} footer={<button className="primary" disabled={!name.trim() || !!busy} onClick={install}>{busy ? 'Installing…' : 'Install'}</button>}>
          {field('npm package name', <input autoFocus className="mono" placeholder="n8n-nodes-example or @scope/n8n-nodes-example@1.2.3" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && install()} />, <>Browse packages on <a href="https://www.npmjs.com/search?q=keywords:n8n-community-node-package" target="_blank" rel="noreferrer">npm</a>.</>)}
        </Modal>
      )}
    </div>
  );
}
