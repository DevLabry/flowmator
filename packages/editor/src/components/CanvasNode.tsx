import { Handle, NodeResizer, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { CircleAlert, Check, Pin, Play, Power, Trash2, Zap, Plus } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { getNodeType } from '../store/app';
import { staticIO, useWorkflow } from '../store/workflow';
import { NodeIcon } from './ui';

export interface CanvasNodeData extends Record<string, unknown> {
  name: string;
  onAddFrom: (node: string, output: number, type: string) => void;
  /** "+" under an AI input of a root node (agent): add a sub-node that feeds it */
  onAddSubNode: (node: string, type: string) => void;
}

const ioType = (io: string | { type: string }) => (typeof io === 'string' ? io : io.type);

/** How many sub-nodes already feed `target` through `type`. */
function countSubInputs(connections: Record<string, Record<string, Array<Array<{ node: string }> | null> | undefined>>, target: string, type: string) {
  let n = 0;
  for (const byType of Object.values(connections)) for (const targets of byType[type] ?? []) for (const t of targets ?? []) if (t.node === target) n++;
  return n;
}
const ioLabel = (io: string | { type: string; displayName?: string }) => (typeof io === 'string' ? '' : (io.displayName ?? ''));

export const CanvasNode = memo(function CanvasNode({ id, data, selected }: NodeProps) {
  const { name, onAddFrom, onAddSubNode } = data as CanvasNodeData;
  const updateNodeInternals = useUpdateNodeInternals();
  const node = useWorkflow((s) => s.workflow.nodes.find((n) => n.name === name));
  const subInputs = useWorkflow((s) => s.workflow.connections);
  const dynamicIO = useWorkflow((s) => s.nodeIO[name]);
  const runs = useWorkflow((s) => s.runData[name]);
  const running = useWorkflow((s) => s.executingNodes.includes(name));
  const pinned = useWorkflow((s) => !!s.workflow.pinData?.[name]);
  const connections = useWorkflow((s) => s.workflow.connections[name]);
  const readOnly = useWorkflow((s) => s.readOnly);
  // handles move when the inputs/outputs change (Switch rules, vector store mode): re-measure them
  const ioKey = dynamicIO ? JSON.stringify([dynamicIO.inputs, dynamicIO.outputs]) : '';
  useEffect(() => updateNodeInternals(id), [ioKey, id, updateNodeInternals]);
  if (!node) return null;

  const type = getNodeType(node.type);
  const io = dynamicIO ?? staticIO(node);
  const outputs = io.outputs;
  const mainOutputs = outputs.filter((o) => ioType(o) === 'main');
  const mainInputs = io.inputs.filter((i) => ioType(i) === 'main');
  const aiInputs = io.inputs.filter((i) => ioType(i) !== 'main');
  const aiOutputs = outputs.filter((o) => ioType(o) !== 'main');
  const isSub = !!type?.supplyData && mainOutputs.length === 0;
  const lastRun = runs?.at(-1);
  const itemCount = lastRun?.data?.main?.reduce((sum, o) => sum + (o?.length ?? 0), 0) ?? 0;
  const status = running ? 'running' : lastRun?.error ? 'error' : lastRun ? 'success' : '';
  const isTrigger = !!type?.isTrigger;
  const outputNames = io.outputNames ?? [];

  // root nodes with sub-node inputs (AI Agent) are wide, with their name inside, so the inputs fit below
  const wide = aiInputs.length > 0;
  const classes = ['wf-node', status, isTrigger && 'trigger', isSub && 'subnode', wide && 'wide', selected && 'selected', node.disabled && 'disabled', pinned && 'pinned']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      {!readOnly && (
        <div className="toolbar nodrag">
          {!isSub && <button className="ghost" title="Execute step" onClick={() => useWorkflow.getState().run({ destinationNode: name })}><Play size={13} /></button>}
          <button className="ghost" title={node.disabled ? 'Enable' : 'Disable'} onClick={() => useWorkflow.getState().updateNode(name, { disabled: !node.disabled })}><Power size={13} /></button>
          <button className="ghost" title="Delete" onClick={() => useWorkflow.getState().removeNodes([name])}><Trash2 size={13} /></button>
        </div>
      )}
      {isTrigger && <Zap size={14} className="trigger-bolt" fill="currentColor" />}

      {mainInputs.map((input, i) => (
        <Handle
          key={`in-main-${i}`}
          id={`in:main:${i}`}
          type="target"
          position={Position.Left}
          className="main-in"
          style={{ top: `${((i + 1) / (mainInputs.length + 1)) * 100}%` }}
        >
          {mainInputs.length > 1 && <span className="handle-label" style={{ right: 12, top: -2 }}>{io.inputNames?.[i] ?? ioLabel(input) ?? ''}</span>}
        </Handle>
      ))}
      {aiInputs.map((input, i) => (
        <Handle
          key={`in-ai-${i}`}
          id={`in:${ioType(input)}:0`}
          type="target"
          position={Position.Bottom}
          className="ai"
          style={{ left: `${((i + 1) / (aiInputs.length + 1)) * 100}%` }}
        >
          <span className="handle-label" style={{ top: 14, left: '50%', transform: 'translateX(-50%)' }}>{ioLabel(input) || ioType(input).replace('ai_', '')}{typeof input !== 'string' && input.required ? ' *' : ''}</span>
          {!readOnly && (typeof input === 'string' || !input.maxConnections || countSubInputs(subInputs, name, ioType(input)) < input.maxConnections) && (
            <button
              className="handle-plus nodrag"
              style={{ top: 34, left: '50%', transform: 'translateX(-50%)' }}
              title={`Add ${ioLabel(input) || 'sub-node'}`}
              onClick={(e) => {
                e.stopPropagation();
                onAddSubNode(name, ioType(input));
              }}
            >
              <Plus size={12} />
            </button>
          )}
        </Handle>
      ))}

      <div className="box">
        <NodeIcon icon={type?.icon} color={type?.defaults.color} size={isSub ? 26 : 32} label={type?.displayName ?? node.name} />
        {wide && <span className="inner-name ellipsis">{node.name}</span>}
        {pinned && <Pin size={13} className="pin" />}
        {status === 'success' && (
          <span className="status ok">
            <Check size={13} strokeWidth={3} />
            {runs && runs.length > 1 ? `${runs.length}` : ''}
          </span>
        )}
        {status === 'error' && (
          <span className="status err" title={lastRun?.error?.message}>
            <CircleAlert size={14} />
          </span>
        )}
      </div>

      {mainOutputs.map((_o, i) => {
        const top = `${((i + 1) / (mainOutputs.length + 1)) * 100}%`;
        const connected = !!connections?.main?.[i]?.length;
        return (
          <Handle key={`out-main-${i}`} id={`out:main:${i}`} type="source" position={Position.Right} style={{ top }}>
            {outputNames[i] && <span className="handle-label" style={{ left: 12, top: -14 }}>{outputNames[i]}</span>}
            {!connected && !readOnly && (
              <>
                <span className="handle-plus-line" style={{ left: 10, width: 30, top: 4 }} />
                <button
                  className="handle-plus nodrag"
                  style={{ left: 40, top: -4 }}
                  title="Add node"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddFrom(name, i, 'main');
                  }}
                >
                  <Plus size={12} />
                </button>
              </>
            )}
          </Handle>
        );
      })}
      {aiOutputs.map((o, i) => (
        <Handle key={`out-ai-${i}`} id={`out:${ioType(o)}:0`} type="source" position={Position.Top} className="ai" style={{ left: `${((i + 1) / (aiOutputs.length + 1)) * 100}%` }} />
      ))}

      <div className="label" style={wide ? { top: 'auto', bottom: 'calc(100% + 6px)' } : undefined}>
        {!wide && <div className="ellipsis" style={node.disabled ? { textDecoration: 'line-through' } : undefined}>{node.name}</div>}
        {itemCount > 0 && <div className="sublabel">{itemCount} item{itemCount === 1 ? '' : 's'}</div>}
      </div>
    </div>
  );
});

const STICKY_COLORS = ['#fff5d6', '#fde2d0', '#fadadd', '#dff4e4', '#dbe9fb', '#ece2fb', '#f0f0f0'];

export const StickyNode = memo(function StickyNode({ data, selected }: NodeProps) {
  const { name } = data as CanvasNodeData;
  const node = useWorkflow((s) => s.workflow.nodes.find((n) => n.name === name));
  const readOnly = useWorkflow((s) => s.readOnly);
  const [editing, setEditing] = useState(false);
  if (!node) return null;
  const p = node.parameters as { content?: string; color?: number; width?: number; height?: number };
  const color = STICKY_COLORS[((p.color ?? 1) - 1) % STICKY_COLORS.length];
  const set = (patch: Record<string, unknown>) => useWorkflow.getState().setParameters(name, { ...node.parameters, ...patch } as never);
  return (
    <>
      <NodeResizer
        isVisible={selected && !readOnly}
        minWidth={150}
        minHeight={80}
        onResizeEnd={(_e, r) => set({ width: Math.round(r.width), height: Math.round(r.height) })}
      />
      <div className="sticky" style={{ background: color, width: p.width ?? 240, height: p.height ?? 160 }} onDoubleClick={() => !readOnly && setEditing(true)}>
        {editing ? (
          <textarea className="nodrag" autoFocus defaultValue={p.content ?? ''} onBlur={(e) => { set({ content: e.target.value }); setEditing(false); }} />
        ) : (
          <StickyContent text={p.content ?? ''} />
        )}
        {selected && !readOnly && (
          <div className="row nodrag" style={{ position: 'absolute', bottom: 6, right: 8, gap: 4 }}>
            {STICKY_COLORS.map((c, i) => (
              <span key={c} onClick={() => set({ color: i + 1 })} style={{ width: 12, height: 12, borderRadius: 6, background: c, border: '1px solid #0002', cursor: 'pointer' }} />
            ))}
          </div>
        )}
      </div>
    </>
  );
});

/** Minimal markdown: headings, bold, italics, links, code. */
function StickyContent({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const h = line.match(/^(#{1,3})\s+(.*)/);
        const html = (h ? h[2] : line)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
          .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
          .replace(/\*(.+?)\*/g, '<i>$1</i>')
          .replace(/`(.+?)`/g, '<code>$1</code>')
          .replace(/\[(.+?)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
        const Tag = h ? (`h${h[1].length}` as 'h1') : 'div';
        return <Tag key={i} dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />;
      })}
    </>
  );
}
