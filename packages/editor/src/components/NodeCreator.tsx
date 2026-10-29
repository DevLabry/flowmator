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
  '8n8.stickyNote': 'Canvas',
};
const ORDER = ['Triggers', 'Flow', 'Data transformation', 'Network', 'Canvas', 'Other'];

interface Props {
  onPick: (type: string) => void;
  onClose: () => void;
  /** Only show triggers (empty workflow) */
  triggersFirst: boolean;
}

export function NodeCreator({ onPick, onClose, triggersFirst }: Props) {
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
      const cat = t.isTrigger ? 'Triggers' : (CATEGORY[t.name] ?? 'Other');
      byCat.set(cat, [...(byCat.get(cat) ?? []), t]);
    }
    const order = triggersFirst ? ORDER : [...ORDER.slice(1, -1), 'Other', 'Triggers'];
    return order.filter((c) => byCat.has(c)).map((c) => ({ cat: c, items: byCat.get(c)!.sort((a, b) => a.displayName.localeCompare(b.displayName)) }));
  }, [nodeTypes, q, triggersFirst]);

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
          <h3 className="grow">{triggersFirst ? 'What triggers this workflow?' : 'What happens next?'}</h3>
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
