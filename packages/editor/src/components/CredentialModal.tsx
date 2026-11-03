import { getParameterDisplayed, type IDataObject, type INodeParameters } from '@flowmator/workflow';
import { useEffect, useState } from 'react';
import { Api, type CredentialSummary } from '../lib/api';
import { errorToast, useApp } from '../store/app';
import { CodeEditor } from './Editors';
import { Modal, Switch } from './ui';

interface Props {
  type: string;
  credentialId?: string;
  /** Project a new credential goes to (default: the personal project) */
  projectId?: string;
  onClose: () => void;
  onSaved?: (c: CredentialSummary) => void;
}

/** Create or edit a credential. Secrets come back redacted; leaving them untouched keeps the stored value. */
export function CredentialModal({ type, credentialId, projectId, onClose, onSaved }: Props) {
  const credType = useApp((s) => s.credentialTypes[type]);
  const baseUrl = String(useApp((s) => s.settings.urlBaseWebhook) ?? `${location.origin}/`);
  const [name, setName] = useState(credType ? `${credType.displayName} account` : 'Credential');
  const [data, setData] = useState<IDataObject>({});
  const [id, setId] = useState(credentialId);
  const [testResult, setTestResult] = useState<{ status: string; message: string }>();
  const [busy, setBusy] = useState(false);
  // people it is only shared with can use it but not see or change its secrets
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    if (!credentialId) {
      setData(Object.fromEntries((credType?.properties ?? []).filter((p) => p.type !== 'hidden').map((p) => [p.name, p.default])) as IDataObject);
      return;
    }
    Api.credential(credentialId).then((c) => {
      setName(c.name);
      setData(c.data ?? {});
      setReadOnly(!c.scopes?.includes('update'));
    }, errorToast('Could not load credential'));
  }, [credentialId, credType]);

  if (!credType) return <Modal title="Unknown credential type" onClose={onClose}>{type}</Modal>;

  const isOAuth2 = type === 'oAuth2Api' || credType.extends?.includes('oAuth2Api');
  const connected = !!(data.oauthTokenData as IDataObject | undefined)?.connected;

  const save = async () => {
    setBusy(true);
    try {
      const saved = id ? await Api.updateCredential(id, { name, data }) : await Api.createCredential({ name, type, data, projectId });
      setId(saved.id);
      await useApp.getState().refreshCredentials();
      onSaved?.(saved);
      useApp.getState().toast('success', 'Credential saved');
      return saved;
    } catch (e) {
      errorToast('Could not save credential')(e);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTestResult(await Api.testCredential({ id, type, data }).catch((e) => ({ status: 'Error', message: (e as Error).message })));
  };

  const connect = async () => {
    const saved = await save();
    if (!saved) return;
    const url = await Api.oauthUrl(saved.id).catch(errorToast('Could not start OAuth'));
    if (!url) return;
    const popup = window.open(url, 'flowmator-oauth', 'width=600,height=700');
    const onMsg = (e: MessageEvent) => {
      if (e.data !== 'flowmator-oauth-success') return;
      window.removeEventListener('message', onMsg);
      popup?.close();
      Api.credential(saved.id).then((c) => setData(c.data ?? {}));
      useApp.getState().toast('success', 'Account connected');
    };
    window.addEventListener('message', onMsg);
  };

  return (
    <Modal
      title={id ? `Edit ${credType.displayName}` : `New ${credType.displayName}`}
      onClose={onClose}
      width={560}
      footer={
        <>
          {testResult && <span className={`badge ${testResult.status === 'OK' ? 'success' : 'error'}`} title={testResult.message} style={{ marginRight: 'auto', maxWidth: 260 }}><span className="ellipsis">{testResult.message}</span></span>}
          {readOnly ? <button onClick={onClose}>Close</button> : <button onClick={test}>Test</button>}
          <button className="primary" disabled={busy || readOnly} onClick={async () => { if (await save()) onClose(); }}>Save</button>
        </>
      }
    >
      <div>
        <label className="field-label">Name</label>
        <input value={name} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
      </div>
      {readOnly && <div className="muted">This credential is shared with you: your workflows can use it, but only its owner's project can see or change its details.</div>}
      {!readOnly && credType.properties.map((p) => {
        if (p.type === 'hidden' || !getParameterDisplayed(p, data as INodeParameters)) return null;
        const v = data[p.name];
        const set = (nv: unknown) => setData({ ...data, [p.name]: nv as never });
        return (
          <div key={p.name}>
            <label className="field-label">{p.displayName}</label>
            {p.type === 'options' ? (
              <select value={String(v ?? '')} onChange={(e) => set(e.target.value)}>
                {(p.options ?? []).map((o) => 'value' in o ? <option key={String(o.value)} value={String(o.value)}>{o.name}</option> : null)}
              </select>
            ) : p.type === 'boolean' ? (
              <Switch checked={!!v} onChange={set} />
            ) : p.type === 'json' ? (
              <CodeEditor value={typeof v === 'string' ? v : JSON.stringify(v ?? {}, null, 2)} onChange={set} language="json" minHeight={90} />
            ) : (
              <input
                type={p.typeOptions?.password ? 'password' : p.type === 'number' ? 'number' : 'text'}
                value={String(v ?? '')}
                placeholder={p.placeholder}
                onFocus={(e) => v === '__FLOWMATOR_REDACTED__' && e.target.select()}
                onChange={(e) => set(p.type === 'number' ? Number(e.target.value) : e.target.value)}
              />
            )}
            {p.description && <div className="param-hint">{p.description}</div>}
          </div>
        );
      })}
      {isOAuth2 && data.grantType !== 'clientCredentials' && (
        <div className="card row" style={{ padding: 12 }}>
          <div className="grow">
            <div style={{ fontWeight: 500 }}>{connected ? 'Account connected' : 'Not connected'}</div>
            <div className="faint mono" style={{ fontSize: 11 }}>Redirect URL: {baseUrl}rest/oauth2-credential/callback</div>
          </div>
          <button className="primary" onClick={connect}>{connected ? 'Reconnect' : 'Connect account'}</button>
        </div>
      )}
    </Modal>
  );
}
