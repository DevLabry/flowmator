import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Api } from '../lib/api';
import { errorToast } from '../store/app';

type Variable = { id: string; key: string; value: string };

/** Variables are available in every expression as $vars.KEY */
export function VariablesPage() {
  const [list, setList] = useState<Variable[]>([]);
  const [draft, setDraft] = useState({ key: '', value: '' });
  const refresh = useCallback(() => {
    Api.variables().then((vars) => {
      setList(vars);
      (window as unknown as { __flowmatorVars: Record<string, string> }).__flowmatorVars = Object.fromEntries(vars.map((v) => [v.key, v.value]));
    }, errorToast('Could not load variables'));
  }, []);
  useEffect(refresh, [refresh]);

  const add = async () => {
    if (!draft.key) return;
    await Api.createVariable(draft.key, draft.value).then(() => setDraft({ key: '', value: '' }), errorToast('Could not add variable'));
    refresh();
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Variables</h1>
          <div className="muted" style={{ marginTop: 4 }}>Use them in expressions with <code>{'{{ $vars.KEY }}'}</code></div>
        </div>
      </div>
      <div className="card">
        <table className="list">
          <thead><tr><th style={{ width: '35%' }}>Key</th><th>Value</th><th style={{ width: 40 }} /></tr></thead>
          <tbody>
            {list.map((v) => (
              <tr key={v.id}>
                <td><input defaultValue={v.key} className="mono" onBlur={(e) => e.target.value !== v.key && Api.updateVariable(v.id, e.target.value, v.value).then(refresh, errorToast('Could not update'))} /></td>
                <td><input defaultValue={v.value} onBlur={(e) => e.target.value !== v.value && Api.updateVariable(v.id, v.key, e.target.value).then(refresh, errorToast('Could not update'))} /></td>
                <td><button className="ghost icon sm danger" onClick={() => Api.deleteVariable(v.id).then(refresh)}><Trash2 size={13} /></button></td>
              </tr>
            ))}
            <tr>
              <td><input className="mono" placeholder="NEW_KEY" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} /></td>
              <td><input placeholder="value" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} /></td>
              <td><button className="icon sm" onClick={add} disabled={!draft.key}><Plus size={13} /></button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
