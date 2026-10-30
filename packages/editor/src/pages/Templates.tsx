import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../components/ui';
import { Api, Templates, type TemplateSummary } from '../lib/api';
import { errorToast, useApp } from '../store/app';

/** Browse n8n's public template library and import a template as a new workflow. */
export function TemplatesPage() {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<Array<{ id: number; name: string }>>([]);
  const [results, setResults] = useState<{ total: number; items: TemplateSummary[] }>();
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<TemplateSummary>();

  useEffect(() => {
    Templates.categories().then((c) => setCategories(c.categories ?? []), () => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    setError(undefined);
    Templates.search({ search: query, category, page, rows: 24 }).then(
      (r) => setResults((prev) => ({ total: r.totalWorkflows, items: page === 1 ? r.workflows : [...(prev?.items ?? []), ...r.workflows] })),
      (e) => setError((e as Error).message),
    );
  }, [query, category, page]);
  useEffect(() => setPage(1), [query, category]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Templates</h1>
          <div className="muted" style={{ marginTop: 4 }}>Workflows from the n8n template library. Importing one creates a new workflow; add your own credentials before activating it.</div>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="row grow card" style={{ padding: '0 10px' }}>
          <Search size={14} className="faint" />
          <input style={{ border: 'none', background: 'none' }} placeholder="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select style={{ width: 220 }} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {error && <div className="card text-danger" style={{ padding: 16 }}>{error}</div>}
      {results && <div className="faint" style={{ marginBottom: 8 }}>{results.total.toLocaleString()} templates</div>}
      <div className="template-grid">
        {results?.items.map((t) => (
          <button key={t.id} className="card template-card" onClick={() => setOpen(t)}>
            <strong>{t.name}</strong>
            <span className="faint">{t.user?.name ?? t.user?.username}{t.totalViews ? ` · ${t.totalViews.toLocaleString()} views` : ''}</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 'auto' }}>
              {[...new Set((t.nodes ?? []).map((n) => n.displayName))].slice(0, 5).map((n) => <span key={n} className="badge">{n}</span>)}
            </div>
          </button>
        ))}
      </div>
      {results && results.items.length < results.total && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}><button onClick={() => setPage(page + 1)}>Load more</button></div>
      )}
      {open && <TemplateModal template={open} onClose={() => setOpen(undefined)} />}
    </div>
  );
}

function TemplateModal({ template, onClose }: { template: TemplateSummary; onClose: () => void }) {
  const [detail, setDetail] = useState<TemplateSummary & { description?: string }>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const nodeTypes = useApp((s) => s.nodeTypes);
  useEffect(() => {
    Templates.workflow(template.id).then((r) => setDetail(r.workflow), () => {});
  }, [template.id]);

  const use = async () => {
    setBusy(true);
    try {
      const t = await Templates.importable(template.id);
      const [wf] = await Api.importWorkflows({ name: t.name, nodes: t.workflow.nodes, connections: t.workflow.connections, settings: t.workflow.settings ?? {}, pinData: t.workflow.pinData, meta: { templateId: String(template.id) } });
      navigate(`/workflow/${wf.id}`);
    } catch (e) {
      errorToast('Could not import template')(e);
      setBusy(false);
    }
  };

  // nodes 8n8 doesn't have yet are imported anyway, but flagged here
  const missing = [...new Set((detail?.nodes ?? template.nodes ?? []).map((n) => n.name))].filter((n) => {
    const name = n.replace(/^n8n-nodes-base\./, '8n8.').replace(/^@n8n\/n8n-nodes-langchain\./, '8n8-ai.');
    return !nodeTypes[name];
  });

  return (
    <Modal title={template.name} width={720} onClose={onClose} footer={<button className="primary" disabled={busy} onClick={use}>{busy ? 'Importing…' : 'Use this workflow'}</button>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {[...new Set((detail?.nodes ?? template.nodes ?? []).map((n) => n.displayName))].map((n) => <span key={n} className="badge">{n}</span>)}
        </div>
        {missing.length > 0 && <div className="card text-danger" style={{ padding: 10 }}>Not available in 8n8: {missing.join(', ')}</div>}
        <div className="muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 380, overflow: 'auto' }}>{detail?.description ?? template.description ?? 'Loading…'}</div>
      </div>
    </Modal>
  );
}
