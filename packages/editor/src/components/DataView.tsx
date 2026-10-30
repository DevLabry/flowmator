import type { INodeExecutionData } from '@flowmator/workflow';
import { FileText } from 'lucide-react';
import { useState } from 'react';

export type DataMode = 'table' | 'json' | 'schema' | 'binary';

const IDENT = /^[A-Za-z_$][\w$]*$/;
export const joinPath = (base: string, key: string | number) =>
  typeof key === 'number' ? `${base}[${key}]` : IDENT.test(key) ? `${base}.${key}` : `${base}['${key.replace(/'/g, "\\'")}']`;

interface DragSource {
  /** e.g. "$json" for the direct parent, "$('Node').item.json" otherwise */
  root: string;
}

function startDrag(e: React.DragEvent, src: DragSource, path: Array<string | number>) {
  const expr = path.reduce<string>((acc, k) => joinPath(acc, k), src.root);
  e.dataTransfer.setData('application/flowmator-expr', `{{ ${expr} }}`);
  e.dataTransfer.setData('application/flowmator-path', path.join('.'));
  e.dataTransfer.setData('text/plain', `{{ ${expr} }}`);
  e.dataTransfer.effectAllowed = 'copy';
}

function Cell({ value }: { value: unknown }) {
  if (value === null) return <span className="null">null</span>;
  if (value === undefined) return <span className="null">—</span>;
  if (typeof value === 'object') return <span className="mono">{JSON.stringify(value)}</span>;
  if (value === '') return <span className="null">empty</span>;
  return <>{String(value)}</>;
}

function TableView({ items, src }: { items: INodeExecutionData[]; src?: DragSource }) {
  const columns = [...new Set(items.flatMap((i) => Object.keys(i.json ?? {})))];
  if (!columns.length) return <div className="empty">{items.length} item{items.length === 1 ? '' : 's'} without fields</div>;
  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>
              <span className="draggable-key" draggable={!!src} onDragStart={(e) => src && startDrag(e, src, [c])}>{c}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c}>
                <Cell value={item.json?.[c]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SchemaNode({ value, path, src, name }: { value: unknown; path: Array<string | number>; src?: DragSource; name: string }) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const children =
    value && typeof value === 'object'
      ? Array.isArray(value)
        ? value.length && typeof value[0] === 'object' ? [[0, value[0]] as const] : []
        : Object.entries(value)
      : [];
  return (
    <div style={{ paddingLeft: path.length > 1 ? 14 : 0 }}>
      <div className="schema-row">
        <span className="schema-type">{type}</span>
        <span className="draggable-key" draggable={!!src} onDragStart={(e) => src && startDrag(e, src, path)} style={{ fontWeight: 500 }}>{name}</span>
        {type !== 'object' && type !== 'array' && <span className="schema-val">{String(value)}</span>}
        {type === 'array' && <span className="faint">({(value as unknown[]).length})</span>}
      </div>
      {children.map(([k, v]) => (
        <SchemaNode key={String(k)} value={v} path={[...path, k]} src={src} name={String(k)} />
      ))}
    </div>
  );
}

function BinaryView({ items }: { items: INodeExecutionData[] }) {
  const withBinary = items.map((item, i) => ({ i, binary: item.binary })).filter((x) => x.binary && Object.keys(x.binary).length);
  if (!withBinary.length) return <div className="empty">No binary data</div>;
  return (
    <div style={{ padding: 12 }} className="col">
      {withBinary.map(({ i, binary }) =>
        Object.entries(binary!).map(([key, b]) => (
          <div key={`${i}-${key}`} className="card row" style={{ padding: 10 }}>
            <FileText size={18} />
            <div className="grow">
              <div style={{ fontWeight: 500 }}>{b.fileName ?? key}</div>
              <div className="faint">Item {i} · {key} · {b.mimeType}{b.fileSize ? ` · ${(b.fileSize / 1024).toFixed(1)} kB` : ''}</div>
            </div>
          </div>
        )),
      )}
    </div>
  );
}

export function DataView({ items, mode, src }: { items: INodeExecutionData[]; mode: DataMode; src?: DragSource }) {
  const [limit, setLimit] = useState(100);
  const shown = items.slice(0, limit);
  return (
    <>
      {mode === 'table' && <TableView items={shown} src={src} />}
      {mode === 'json' && <div className="json-view">{JSON.stringify(shown.map((i) => i.json), null, 2)}</div>}
      {mode === 'schema' && (
        <div style={{ padding: 12 }}>
          {Object.entries(items[0]?.json ?? {}).map(([k, v]) => (
            <SchemaNode key={k} value={v} path={[k]} src={src} name={k} />
          ))}
          {!Object.keys(items[0]?.json ?? {}).length && <div className="empty">No fields</div>}
        </div>
      )}
      {mode === 'binary' && <BinaryView items={items} />}
      {items.length > limit && (
        <div style={{ padding: 10, textAlign: 'center' }}>
          <button className="sm" onClick={() => setLimit(limit + 200)}>Show more ({items.length - limit} hidden)</button>
        </div>
      )}
    </>
  );
}

export function DataModeSwitch({ mode, onChange, hasBinary }: { mode: DataMode; onChange: (m: DataMode) => void; hasBinary: boolean }) {
  const modes: DataMode[] = hasBinary ? ['schema', 'table', 'json', 'binary'] : ['schema', 'table', 'json'];
  return (
    <span className="seg">
      {modes.map((m) => (
        <button key={m} className={mode === m ? 'active' : ''} onClick={() => onChange(m)}>{m[0].toUpperCase() + m.slice(1)}</button>
      ))}
    </span>
  );
}
