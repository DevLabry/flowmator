import { getNodeParametersWithDefaults, getParameterDisplayed, type INode, type INodeExecutionData, type INodeParameters } from '@8n8/workflow';
import { ArrowLeft, Copy, Pencil, Pin, PinOff, Play, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Api } from '../lib/api';
import { getNodeType, useApp } from '../store/app';
import { getNodeInput, staticIO, toWorkflowClass, useWorkflow } from '../store/workflow';
import { CredentialModal } from './CredentialModal';
import { DataModeSwitch, DataView, type DataMode } from './DataView';
import { CodeEditor } from './Editors';
import { ParameterList } from './ParameterForm';
import { NodeIcon, Switch } from './ui';

function InputPanel({ node }: { node: INode }) {
  const runData = useWorkflow((s) => s.runData);
  const workflow = useWorkflow((s) => s.workflow);
  const [mode, setMode] = useState<DataMode>('schema');
  const parents = useMemo(() => toWorkflowClass(workflow).getParentNodes(node.name), [workflow, node.name]);
  const direct = useMemo(() => toWorkflowClass(workflow).getDirectParents(node.name).map((p) => p.node), [workflow, node.name]);
  const defaultSource = getNodeInput(node.name).from ?? direct[0];
  const [source, setSource] = useState<string | undefined>(defaultSource);
  useEffect(() => setSource(defaultSource), [defaultSource]);

  const items: INodeExecutionData[] = useMemo(() => {
    if (!source) return [];
    if (source === defaultSource) return getNodeInput(node.name).items;
    return runData[source]?.at(-1)?.data?.main?.[0] ?? workflow.pinData?.[source] ?? [];
  }, [source, defaultSource, node.name, runData, workflow.pinData]);

  const root = !source || source === defaultSource ? '$json' : `$('${source.replace(/'/g, "\\'")}').item.json`;
  const executed = !!source && (!!runData[source] || !!workflow.pinData?.[source]);

  return (
    <div className="ndv-panel">
      <div className="ndv-panel-head">
        <strong>Input</strong>
        {parents.length > 0 && (
          <select style={{ width: 'auto', minHeight: 26, padding: '2px 6px' }} value={source} onChange={(e) => setSource(e.target.value)}>
            {parents.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
        <span className="grow" />
        {executed && <span className="faint">{items.length} item{items.length === 1 ? '' : 's'}</span>}
        <DataModeSwitch mode={mode} onChange={setMode} hasBinary={items.some((i) => i.binary)} />
      </div>
      <div className="ndv-panel-body">
        {!parents.length ? (
          <div className="empty">This node has no input</div>
        ) : !executed ? (
          <div className="empty col" style={{ alignItems: 'center' }}>
            <div>No input data yet</div>
            <button className="sm" onClick={() => useWorkflow.getState().run({ destinationNode: source })}><Play size={12} /> Execute previous nodes</button>
          </div>
        ) : (
          <DataView items={items} mode={mode} src={{ root }} />
        )}
      </div>
    </div>
  );
}

function OutputPanel({ node }: { node: INode }) {
  const runs = useWorkflow((s) => s.runData[node.name]);
  const pinned = useWorkflow((s) => s.workflow.pinData?.[node.name]);
  const nodeIO = useWorkflow((s) => s.nodeIO[node.name]);
  const executing = useWorkflow((s) => s.executingNodes.includes(node.name));
  const readOnly = useWorkflow((s) => s.readOnly);
  const [mode, setMode] = useState<DataMode>('table');
  const [runIndex, setRunIndex] = useState<number | null>(null);
  const [branch, setBranch] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);

  const run = runs?.[runIndex ?? runs.length - 1];
  const io = nodeIO ?? staticIO(node);
  const outputNames = io.outputNames ?? [];
  const outputCount = run?.data?.main?.length ?? io.outputs.length;
  const items = pinned && !runs ? pinned : (run?.data?.main?.[branch] ?? []);

  const startEdit = () => setEditing(JSON.stringify((pinned ?? run?.data?.main?.[branch] ?? [{ json: {} }]).map((i) => i.json), null, 2));
  const saveEdit = () => {
    try {
      const parsed = JSON.parse(editing ?? '[]');
      const list = (Array.isArray(parsed) ? parsed : [parsed]).map((json) => ({ json }));
      useWorkflow.getState().setPinData(node.name, list);
      setEditing(null);
    } catch (e) {
      useApp.getState().toast('error', 'Invalid JSON', (e as Error).message);
    }
  };

  return (
    <div className="ndv-panel">
      <div className="ndv-panel-head">
        <strong>Output</strong>
        {runs && runs.length > 1 && (
          <select style={{ width: 'auto', minHeight: 26, padding: '2px 6px' }} value={runIndex ?? runs.length - 1} onChange={(e) => setRunIndex(Number(e.target.value))}>
            {runs.map((_, i) => <option key={i} value={i}>Run {i + 1} of {runs.length}</option>)}
          </select>
        )}
        <span className="grow" />
        {pinned && <span className="badge" style={{ color: 'var(--pinned)' }}><Pin size={11} /> Pinned</span>}
        {(run || pinned) && <span className="faint">{items.length} item{items.length === 1 ? '' : 's'}</span>}
        {!readOnly && (
          <>
            <button className="ghost sm icon" title="Edit output (pins it)" onClick={startEdit}><Pencil size={13} /></button>
            {(run || pinned) && (
              <button
                className="ghost sm icon"
                title={pinned ? 'Unpin data' : 'Pin this data: future runs reuse it instead of executing the node'}
                onClick={() => useWorkflow.getState().setPinData(node.name, pinned ? null : (run?.data?.main?.[0] ?? []))}
              >
                {pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
            )}
          </>
        )}
        <DataModeSwitch mode={mode} onChange={setMode} hasBinary={items.some((i) => i.binary)} />
      </div>
      {outputCount > 1 && !editing && (
        <div className="tabs" style={{ padding: '0 8px' }}>
          {Array.from({ length: outputCount }, (_, i) => (
            <button key={i} className={branch === i ? 'active' : ''} onClick={() => setBranch(i)}>
              {outputNames[i] || `Output ${i}`} ({run?.data?.main?.[i]?.length ?? 0})
            </button>
          ))}
        </div>
      )}
      <div className="ndv-panel-body">
        {editing !== null ? (
          <div className="col" style={{ padding: 12 }}>
            <CodeEditor value={editing} onChange={setEditing} language="json" minHeight={280} />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button className="primary" onClick={saveEdit}>Save and pin</button>
            </div>
          </div>
        ) : executing ? (
          <div className="empty">Executing…</div>
        ) : run?.error ? (
          <div style={{ padding: 16 }} className="col">
            <div style={{ color: 'var(--danger)', fontWeight: 600 }}>{run.error.message}</div>
            {run.error.description && <div className="muted">{run.error.description}</div>}
            {run.error.httpCode && <div className="faint">HTTP {run.error.httpCode}</div>}
            {run.error.stack && <details><summary className="faint">Stack trace</summary><pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{run.error.stack}</pre></details>}
          </div>
        ) : run || pinned ? (
          items.length ? <DataView items={items} mode={mode} /> : <div className="empty">No output data in this branch</div>
        ) : (
          <div className="empty col" style={{ alignItems: 'center' }}>
            <div>Execute this node to view data</div>
            {!readOnly && <button className="sm primary" onClick={() => useWorkflow.getState().run({ destinationNode: node.name })}><Play size={12} /> Execute step</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function CredentialsSection({ node }: { node: INode }) {
  const type = getNodeType(node.type)!;
  const credentials = useApp((s) => s.credentials);
  const credentialTypes = useApp((s) => s.credentialTypes);
  const [modal, setModal] = useState<{ type: string; id?: string } | null>(null);
  // saved workflows (and n8n exports) leave out parameters that are at their default
  const params = getNodeParametersWithDefaults(type.properties, node.parameters, node.typeVersion);

  const wanted = new Set<string>();
  for (const c of type.credentials ?? []) if (getParameterDisplayed({ displayOptions: c.displayOptions } as never, params)) wanted.add(c.name);
  if (params.authentication === 'predefinedCredentialType' && typeof params.nodeCredentialType === 'string' && params.nodeCredentialType) wanted.add(params.nodeCredentialType);
  if (params.authentication === 'genericCredentialType' && typeof params.genericAuthType === 'string' && params.genericAuthType) wanted.add(params.genericAuthType);
  if (!wanted.size) return null;

  const setCred = (credType: string, id: string) => {
    const c = credentials.find((x) => x.id === id);
    const next = { ...(node.credentials ?? {}) };
    if (c) next[credType] = { id: c.id, name: c.name };
    else delete next[credType];
    useWorkflow.getState().updateNode(node.name, { credentials: next });
  };

  return (
    <>
      {[...wanted].map((credType) => {
        const options = credentials.filter((c) => c.type === credType);
        const current = node.credentials?.[credType]?.id ?? '';
        return (
          <div key={credType} className="param">
            <div className="param-head"><span className="label">Credential for {credentialTypes[credType]?.displayName ?? credType}</span></div>
            <div className="row">
              <select value={current} onChange={(e) => (e.target.value === '__new' ? setModal({ type: credType }) : setCred(credType, e.target.value))}>
                <option value="">— select credential —</option>
                {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="__new">+ Create new credential</option>
              </select>
              {current && <button className="icon" title="Edit credential" onClick={() => setModal({ type: credType, id: current })}><Pencil size={13} /></button>}
            </div>
          </div>
        );
      })}
      {modal && <CredentialModal type={modal.type} credentialId={modal.id} onClose={() => setModal(null)} onSaved={(c) => setCred(modal.type, c.id)} />}
    </>
  );
}

function WebhookUrls({ node }: { node: INode }) {
  const wfId = useWorkflow((s) => s.workflow.id);
  const dirty = useWorkflow((s) => s.dirty);
  const [urls, setUrls] = useState<{ test: string; production: string } | null>(null);
  const [which, setWhich] = useState<'test' | 'production'>('test');
  useEffect(() => {
    if (!wfId || dirty) return;
    Api.webhookUrls(wfId).then((list) => setUrls(list.find((u) => u.node === node.name) ?? null)).catch(() => {});
  }, [wfId, dirty, node.name, node.parameters]);
  return (
    <div className="card" style={{ padding: 10 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <strong className="grow">Webhook URLs</strong>
        <span className="seg">
          <button className={which === 'test' ? 'active' : ''} onClick={() => setWhich('test')}>Test URL</button>
          <button className={which === 'production' ? 'active' : ''} onClick={() => setWhich('production')}>Production URL</button>
        </span>
      </div>
      {urls ? (
        <div className="row">
          <code className="grow ellipsis">{urls[which]}</code>
          <button className="ghost sm icon" onClick={() => navigator.clipboard.writeText(urls[which])}><Copy size={13} /></button>
        </div>
      ) : (
        <div className="faint">Save the workflow to see its URLs</div>
      )}
    </div>
  );
}

function SettingsTab({ node }: { node: INode }) {
  const update = (patch: Partial<INode>) => useWorkflow.getState().updateNode(node.name, patch);
  const onError = node.onError ?? (node.continueOnFail ? 'continueRegularOutput' : 'stopWorkflow');
  const row = (label: string, desc: string, control: React.ReactNode) => (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <div className="grow">
        <div style={{ fontWeight: 500 }}>{label}</div>
        <div className="param-hint" style={{ marginTop: 0 }}>{desc}</div>
      </div>
      {control}
    </div>
  );
  return (
    <>
      {row('Always Output Data', 'Output an empty item when the node returns nothing, so the workflow continues', <Switch checked={!!node.alwaysOutputData} onChange={(v) => update({ alwaysOutputData: v })} />)}
      {row('Execute Once', 'Run only with the first input item', <Switch checked={!!node.executeOnce} onChange={(v) => update({ executeOnce: v })} />)}
      {row('Retry On Fail', 'Retry the node when it fails', <Switch checked={!!node.retryOnFail} onChange={(v) => update({ retryOnFail: v })} />)}
      {node.retryOnFail && (
        <div className="row">
          <div className="grow">
            <label className="field-label">Max Tries</label>
            <input type="number" min={2} max={5} value={node.maxTries ?? 3} onChange={(e) => update({ maxTries: Number(e.target.value) })} />
          </div>
          <div className="grow">
            <label className="field-label">Wait Between Tries (ms)</label>
            <input type="number" min={0} max={5000} value={node.waitBetweenTries ?? 1000} onChange={(e) => update({ waitBetweenTries: Number(e.target.value) })} />
          </div>
        </div>
      )}
      <div>
        <label className="field-label">On Error</label>
        <select value={onError} onChange={(e) => update({ onError: e.target.value as INode['onError'], continueOnFail: undefined })}>
          <option value="stopWorkflow">Stop Workflow</option>
          <option value="continueRegularOutput">Continue</option>
          <option value="continueErrorOutput">Continue (using error output)</option>
        </select>
      </div>
      {row('Disabled', 'Disabled nodes pass their input through untouched', <Switch checked={!!node.disabled} onChange={(v) => update({ disabled: v })} />)}
      <div>
        <label className="field-label">Notes</label>
        <textarea value={node.notes ?? ''} onChange={(e) => update({ notes: e.target.value })} style={{ fontFamily: 'inherit' }} />
      </div>
      {row('Display Note in Flow', 'Show the note under the node on the canvas', <Switch checked={!!node.notesInFlow} onChange={(v) => update({ notesInFlow: v })} />)}
      <div className="faint">Node type: {node.type} · v{node.typeVersion} · id {node.id.slice(0, 8)}</div>
    </>
  );
}

export function NDV() {
  const openName = useWorkflow((s) => s.openNode);
  const node = useWorkflow((s) => s.workflow.nodes.find((n) => n.name === s.openNode));
  const readOnly = useWorkflow((s) => s.readOnly);
  const [tab, setTab] = useState<'params' | 'settings'>('params');
  const [name, setName] = useState('');
  useEffect(() => setName(openName ?? ''), [openName]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal') && useWorkflow.getState().setOpenNode(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!openName || !node) return null;
  const type = getNodeType(node.type);
  if (!type) return null;
  const io = staticIO(node);
  const hasInput = io.inputs.some((i) => (typeof i === 'string' ? i : i.type) === 'main');
  const close = () => useWorkflow.getState().setOpenNode(null);

  return (
    <div className="ndv-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`ndv ${hasInput ? '' : 'no-input'}`}>
        {hasInput && <InputPanel node={node} />}
        <div className="ndv-params">
          <div className="head">
            <div className="ndv-title">
              <button className="ghost icon sm" onClick={close} title="Back to canvas"><ArrowLeft size={15} /></button>
              <NodeIcon icon={type.icon} color={type.defaults.color} label={type.displayName} />
              <input
                value={name}
                disabled={readOnly}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setName(useWorkflow.getState().renameNode(node.name, name))}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              {!readOnly && !type.supplyData && (
                <button className="primary sm" onClick={() => useWorkflow.getState().run({ destinationNode: node.name })}>
                  <Play size={12} /> {type.isTrigger ? 'Test step' : 'Execute step'}
                </button>
              )}
              <button className="ghost icon sm" onClick={close}><X size={15} /></button>
            </div>
            <div className="tabs">
              <button className={tab === 'params' ? 'active' : ''} onClick={() => setTab('params')}>Parameters</button>
              <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
            </div>
          </div>
          <div className="body" style={readOnly ? { pointerEvents: 'none', opacity: 0.85 } : undefined}>
            {tab === 'params' ? (
              <>
                {type.hasWebhook && type.isTrigger && <WebhookUrls node={node} />}
                <CredentialsSection node={node} />
                <ParameterList
                  properties={type.properties}
                  values={node.parameters}
                  root={node.parameters}
                  onChange={(p: INodeParameters) => useWorkflow.getState().setParameters(node.name, p)}
                  nodeName={node.name}
                  typeVersion={node.typeVersion}
                />
                {!type.properties.length && <div className="faint">This node has no parameters.</div>}
              </>
            ) : (
              <SettingsTab node={node} />
            )}
          </div>
        </div>
        {type.supplyData ? (
          <div className="ndv-panel">
            <div className="ndv-panel-head"><strong>Output</strong></div>
            <div className="empty">This is a sub-node. It runs inside the node it is connected to (for example an AI Agent), so run that node to try it.</div>
          </div>
        ) : (
          <OutputPanel node={node} />
        )}
      </div>
    </div>
  );
}

