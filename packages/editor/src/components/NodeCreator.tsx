import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeTypeDescription } from '../lib/api';
import { useApp } from '../store/app';
import { NodeIcon } from './ui';

const CATEGORY: Record<string, string> = {
  '8n8.if': 'Flow',
  '8n8.switch': 'Flow',
  '8n8.merge': 'Flow',
  '8n8.filter': 'Flow',
  '8n8.splitInBatches': 'Flow',
  '8n8.wait': 'Flow',
  '8n8.executeWorkflow': 'Flow',
  '8n8.stopAndError': 'Flow',
  '8n8.noOp': 'Flow',
  '8n8.set': 'Data transformation',
  '8n8.code': 'Data transformation',
  '8n8.aggregate': 'Data transformation',
  '8n8.splitOut': 'Data transformation',
  '8n8.sort': 'Data transformation',
  '8n8.limit': 'Data transformation',
  '8n8.removeDuplicates': 'Data transformation',
  '8n8.httpRequest': 'Network',
  '8n8.respondToWebhook': 'Network',
  '8n8.dateTime': 'Data transformation',
  '8n8.crypto': 'Data transformation',
  '8n8.renameKeys': 'Data transformation',
  '8n8.summarize': 'Data transformation',
  '8n8.compareDatasets': 'Data transformation',
  '8n8.xml': 'Data transformation',
  '8n8.html': 'Data transformation',
  '8n8.markdown': 'Data transformation',
  '8n8.extractFromFile': 'Files',
  '8n8.convertToFile': 'Files',
  '8n8.readWriteFile': 'Files',
  '8n8.emailSend': 'Network',
  '8n8.executeCommand': 'Core',
  '8n8.stickyNote': 'Canvas',
  '8n8-ai.agent': 'AI',
  '8n8.slack': 'Apps',
  '8n8.telegram': 'Apps',
  '8n8.github': 'Apps',
  '8n8.notion': 'Apps',
  '8n8.gmail': 'Apps',
  '8n8.googleSheets': 'Apps',
  '8n8.postgres': 'Apps',
};
const ORDER = ['Triggers', 'AI', 'Apps', 'Chat Models', 'Memory', 'Tools', 'Output Parsers', 'Vector Stores', 'Embeddings', 'Document Loaders', 'Text Splitters', 'Retrievers', 'Flow', 'Data transformation', 'Files', 'Network', 'Core', 'Canvas', 'Other'];
const SUB_CATEGORY: Record<string, string> = {
  ai_languageModel: 'Chat Models',
  ai_memory: 'Memory',
  ai_tool: 'Tools',
  ai_outputParser: 'Output Parsers',
  ai_vectorStore: 'Vector Stores',
  ai_embedding: 'Embeddings',
  ai_document: 'Document Loaders',
  ai_textSplitter: 'Text Splitters',
  ai_retriever: 'Retrievers',
};
const outputTypes = (t: NodeTypeDescription): string[] => t.outputs.map((o) => (typeof o === 'string' ? o : o.type));
/** Sub-node only: supplies data and has no main output in its default mode. */
const isSubOnly = (t: NodeTypeDescription) => t.supplyData && !outputTypes(t).includes('main');

interface Props {
  onPick: (type: string) => void;
  onClose: () => void;
  /** Only show triggers (empty workflow) */
  triggersFirst: boolean;
  /** Only sub-nodes that output this connection type (adding to an agent's input) */
  subNodeType?: string;
}

export function NodeCreator({ onPick, onClose, triggersFirst, subNodeType }: Props) {
  const nodeTypes = useApp((s) => s.nodeTypes);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = (t: NodeTypeDescription) =>
      !needle ||
      t.displayName.toLowerCase().includes(needle) ||
      t.description.toLowerCase().includes(needle) ||
      (t.codex?.alias ?? []).some((a) => a.toLowerCase().includes(needle));
    const byCat = new Map<string, NodeTypeDescription[]>();
    for (const t of Object.values(nodeTypes)) {
      if (!matches(t)) continue;
      // vector stores switch to a sub-node mode when attached (subNodeParameters)
      if (subNodeType && !outputTypes(t).includes(subNodeType) && !t.subNodeParameters?.[subNodeType as 'ai_tool']) continue;
      // sub-nodes only make sense attached to a root node: list them when searching or attaching
      if (!subNodeType && isSubOnly(t) && !needle) continue;
      const sub = isSubOnly(t) ? SUB_CATEGORY[outputTypes(t)[0]] : t.subNodeParameters ? 'Vector Stores' : undefined;
      const cat = t.isTrigger ? 'Triggers' : (sub ?? CATEGORY[t.name] ?? (t.codex?.categories?.includes('AI') ? 'AI' : 'Other'));
      byCat.set(cat, [...(byCat.get(cat) ?? []), t]);
    }
    const order = triggersFirst ? ORDER : [...ORDER.slice(1, -1), 'Other', 'Triggers'];
    return order.filter((c) => byCat.has(c)).map((c) => ({ cat: c, items: byCat.get(c)!.sort((a, b) => a.displayName.localeCompare(b.displayName)) }));
  }, [nodeTypes, q, triggersFirst, subNodeType]);

  const flat = groups.flatMap((g) => g.items);

  return (
    <div className="creator" onKeyDown={(e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, flat.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
      if (e.key === 'Enter' && flat[active]) onPick(flat[active].name);
      if (e.key === 'Escape') onClose();
    }}>
      <div className="creator-head">
        <div className="row">
          <h3 className="grow">{subNodeType ? `Add ${SUB_CATEGORY[subNodeType] ?? 'sub-node'}` : triggersFirst ? 'What triggers this workflow?' : 'What happens next?'}</h3>
          <button className="ghost icon sm" onClick={onClose}><X size={15} /></button>
        </div>
        <div className="row" style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, color: 'var(--text-3)' }} />
          <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Search nodes…" style={{ paddingLeft: 30 }} />
        </div>
      </div>
      <div className="creator-list">
        {groups.map((g) => (
          <div key={g.cat}>
            <div className="creator-cat">{g.cat}</div>
            {g.items.map((t) => {
              const idx = flat.indexOf(t);
              return (
                <div
                  key={t.name}
                  className={`creator-item ${idx === active ? 'active' : ''}`}
                  onClick={() => onPick(t.name)}
                  onMouseEnter={() => setActive(idx)}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/8n8-node', t.name)}
                >
                  <span className="ic"><NodeIcon icon={t.icon} color={t.defaults.color} label={t.displayName} /></span>
                  <span className="grow">
                    <div style={{ fontWeight: 500 }}>{t.displayName}</div>
                    <div className="desc">{t.description}</div>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && <div className="empty">No nodes match “{q}”</div>}
      </div>
    </div>
  );
}
