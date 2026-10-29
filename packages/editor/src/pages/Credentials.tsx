import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CredentialModal } from '../components/CredentialModal';
import { Modal, timeAgo } from '../components/ui';
import { Api } from '../lib/api';
import { useApp } from '../store/app';

export function CredentialsPage() {
  const credentials = useApp((s) => s.credentials);
  const credentialTypes = useApp((s) => s.credentialTypes);
  const [picker, setPicker] = useState(false);
  const [edit, setEdit] = useState<{ type: string; id?: string } | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    useApp.getState().refreshCredentials();
  }, []);

  const types = Object.values(credentialTypes).filter((t) => t.displayName.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Credentials</h1>
        <button className="primary" onClick={() => setPicker(true)}><Plus size={14} /> Add credential</button>
      </div>
      <div className="card">
        <table className="list">
          <thead><tr><th>Name</th><th>Type</th><th>Updated</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {credentials.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setEdit({ type: c.type, id: c.id })}>
                <td style={{ fontWeight: 500 }}>{c.name}</td>
                <td className="muted">{credentialTypes[c.type]?.displayName ?? c.type}</td>
                <td className="muted">{timeAgo(c.updatedAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button className="ghost icon sm danger" onClick={async () => {
                    if (!confirm(`Delete credential “${c.name}”? Nodes using it will fail.`)) return;
                    await Api.deleteCredential(c.id);
                    useApp.getState().refreshCredentials();
                  }}><Trash2 size={13} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!credentials.length && <div className="empty">No credentials yet. They're stored encrypted on this machine.</div>}
      </div>
      {picker && (
        <Modal title="Add credential" onClose={() => setPicker(false)}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search credential types" />
          <div className="col" style={{ gap: 2 }}>
            {types.map((t) => (
              <div key={t.name} className="creator-item" onClick={() => { setPicker(false); setEdit({ type: t.name }); }}>
                <span style={{ fontWeight: 500 }}>{t.displayName}</span>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {edit && <CredentialModal type={edit.type} credentialId={edit.id} onClose={() => setEdit(null)} />}
    </div>
  );
}
