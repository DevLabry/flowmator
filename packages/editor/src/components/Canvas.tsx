import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getBezierPath,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import type { ConnectionType, IConnections, INode } from '@8n8/workflow';
import { Play, Plus, Trash2, Square, Copy, MessageCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getNodeType, useApp } from '../store/app';
import { useWorkflow } from '../store/workflow';
import { CanvasNode, StickyNode, type CanvasNodeData } from './CanvasNode';
import { ChatPanel } from './ChatPanel';
import { NodeCreator } from './NodeCreator';

const nodeTypes = { wf: CanvasNode, sticky: StickyNode };
const edgeTypes = { wf: WorkflowEdge };

function parseHandle(id: string | null | undefined) {
  const [, type = 'main', index = '0'] = (id ?? '').split(':');
  return { type: type as ConnectionType, index: Number(index) };
}

function WorkflowEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style } = props;
  // loops back to an earlier node: route below instead of through the nodes
  const backwards = targetX < sourceX - 20;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (backwards) {
    const dropY = Math.max(sourceY, targetY) + 110;
    path = `M ${sourceX} ${sourceY} C ${sourceX + 60} ${sourceY}, ${sourceX + 60} ${dropY}, ${sourceX} ${dropY} L ${targetX} ${dropY} C ${targetX - 60} ${dropY}, ${targetX - 60} ${targetY}, ${targetX} ${targetY}`;
    labelX = (sourceX + targetX) / 2;
    labelY = dropY;
  } else {
    [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  }
  const d = data as { label?: string; onDelete?: () => void; readOnly?: boolean };
  const [hover, setHover] = useState(false);
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ strokeWidth: 2, ...style }} interactionWidth={20} />
      <path d={path} fill="none" stroke="transparent" strokeWidth={20} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />
      <EdgeLabelRenderer>
        {(d?.label || hover) && (
          <div
            className={`edge-label nodrag nopan ${hover ? 'hover' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          >
            {d?.label}
            {!d?.readOnly && (
              <button className="del ghost" title="Delete connection" onClick={d?.onDelete}>
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

/** Serializes selected nodes plus the connections between them (n8n-compatible clipboard format). */
function selectionToJson(names: string[]) {
  const { workflow } = useWorkflow.getState();
  const set = new Set(names);
  const nodes = workflow.nodes.filter((n) => set.has(n.name));
  const connections: IConnections = {};
  for (const [src, byType] of Object.entries(workflow.connections)) {
    if (!set.has(src)) continue;
    const mapped: typeof byType = {};
    for (const [type, outputs] of Object.entries(byType)) {
      mapped[type as ConnectionType] = outputs?.map((t) => t?.filter((c) => set.has(c.node)) ?? null);
    }
    connections[src] = mapped;
  }
  return JSON.stringify({ nodes, connections }, null, 2);
}

function CanvasInner() {
  const wf = useWorkflow((s) => s.workflow);
  const runData = useWorkflow((s) => s.runData);
  const readOnly = useWorkflow((s) => s.readOnly);
  const status = useWorkflow((s) => s.status);
  const store = useWorkflow.getState;
  const flow = useReactFlow();
  const [creator, setCreator] = useState<null | { from?: { node: string; output: number; type: string }; to?: { node: string; type: string }; position?: [number, number] }>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [rfNodes, setRfNodes] = useState<Node[]>([]);

  const onAddFrom = useCallback((node: string, output: number, type: string) => setCreator({ from: { node, output, type } }), []);
  const onAddSubNode = useCallback((node: string, type: string) => setCreator({ to: { node, type } }), []);

  // store → React Flow nodes (keep RF's own selection/drag state)
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return wf.nodes.map((n) => {
        const isSticky = n.type.endsWith('stickyNote');
        const p = n.parameters as { width?: number; height?: number };
        const old = prevById.get(n.name);
        return {
          id: n.name,
          type: isSticky ? 'sticky' : 'wf',
          position: { x: n.position[0], y: n.position[1] },
          data: { name: n.name, onAddFrom, onAddSubNode } satisfies CanvasNodeData,
          selected: old?.selected ?? store().selected.includes(n.name),
          zIndex: isSticky ? -1 : 0,
          ...(isSticky ? { style: { width: p.width ?? 240, height: p.height ?? 160 } } : {}),
        } as Node;
      });
    });
  }, [wf.nodes, onAddFrom, onAddSubNode, store]);

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    for (const [src, byType] of Object.entries(wf.connections)) {
      for (const [type, outputs] of Object.entries(byType)) {
        outputs?.forEach((targets, outputIndex) => {
          for (const t of targets ?? []) {
            const items = runData[src]?.at(-1)?.data?.main?.[outputIndex];
            const pinned = !!wf.pinData?.[src] && !runData[src];
            const count = items?.length ?? (pinned ? wf.pinData[src].length : undefined);
            out.push({
              id: `${src}|${type}|${outputIndex}|${t.node}|${t.index}`,
              source: src,
              target: t.node,
              sourceHandle: `out:${type}:${type === 'main' ? outputIndex : 0}`,
              targetHandle: `in:${t.type}:${t.type === 'main' ? t.index : 0}`,
              type: 'wf',
              className: items?.length ? 'success' : pinned ? 'pinned' : undefined,
              style: type !== 'main' ? { strokeDasharray: '5 4' } : undefined,
              data: {
                label: count !== undefined ? `${count} item${count === 1 ? '' : 's'}` : '',
                readOnly,
                onDelete: () => store().disconnect(src, outputIndex, t.node, t.index, type as ConnectionType),
              },
            });
          }
        });
      }
    }
    return out;
  }, [wf.connections, wf.pinData, runData, readOnly, store]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStart = useCallback(() => store().checkpoint(), [store]);
  const onNodeDragStop = useCallback((_e: unknown, _n: Node, nodes: Node[]) => {
    store().moveNodes(Object.fromEntries(nodes.map((n) => [n.id, [Math.round(n.position.x), Math.round(n.position.y)] as [number, number]])));
  }, [store]);

  const onConnect = useCallback((c: Connection) => {
    const s = parseHandle(c.sourceHandle);
    const t = parseHandle(c.targetHandle);
    if (s.type !== t.type) return useApp.getState().toast('error', 'These connection types are not compatible');
    store().connect(c.source, s.index, c.target, t.index, s.type);
  }, [store]);

  const onSelectionChange = useCallback(({ nodes }: OnSelectionChangeParams) => store().setSelected(nodes.map((n) => n.id)), [store]);

  const placeNode = useCallback((type: string, position?: [number, number]) => {
    const s = store();
    let pos = position;
    let connectFrom: { node: string; output: number; type?: ConnectionType } | undefined;
    if (creator?.from) {
      const src = s.workflow.nodes.find((n) => n.name === creator.from!.node);
      if (src) {
        const siblings = s.workflow.connections[src.name]?.main?.[creator.from.output]?.length ?? 0;
        pos = [src.position[0] + 200, src.position[1] + creator.from.output * 140 + siblings * 140];
        connectFrom = { node: src.name, output: creator.from.output, type: creator.from.type as ConnectionType };
      }
    }
    if (!pos) {
      const selected = s.workflow.nodes.find((n) => n.name === s.selected[0]);
      const lastNode = selected ?? s.workflow.nodes.filter((n) => !n.type.endsWith('stickyNote')).at(-1);
      if (lastNode && !getNodeType(type)?.isTrigger) {
        pos = [lastNode.position[0] + 200, lastNode.position[1]];
        const lastType = getNodeType(lastNode.type);
        if (lastType?.outputs.length) connectFrom = { node: lastNode.name, output: 0 };
      } else {
        const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        pos = [Math.round(center.x - 42), Math.round(center.y - 42)];
      }
    }
    if (creator?.to) {
      // sub-node: below the root node, next to its siblings on the same input, connected upwards
      const root = s.workflow.nodes.find((n) => n.name === creator.to!.node);
      if (root) {
        const siblings = Object.values(s.workflow.connections).filter((byType) => byType[creator.to!.type as ConnectionType]?.some((t) => t?.some((c) => c.node === root.name))).length;
        const order = ['ai_languageModel', 'ai_memory', 'ai_tool', 'ai_outputParser'].indexOf(creator.to.type);
        pos = [root.position[0] - 120 + Math.max(0, order) * 110 + siblings * 100, root.position[1] + 200];
      }
      const sub = s.addNode(type, pos ?? [0, 0]);
      if (sub && root) s.connect(sub.name, 0, root.name, 0, creator.to.type as ConnectionType);
      setCreator(null);
      if (sub) s.setOpenNode(sub.name);
      return;
    }
    const node = s.addNode(type, pos, { connectFrom });
    setCreator(null);
    if (node && !type.endsWith('stickyNote')) {
      s.setSelected([node.name]);
      s.setOpenNode(node.name);
    }
  }, [creator, flow, store]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable], .cm-editor') || store().openNode) return;
      const mod = e.metaKey || e.ctrlKey;
      const s = store();
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (s.readOnly) return;
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
      } else if (mod && (e.key === 'c' || e.key === 'x') && s.selected.length) {
        await navigator.clipboard.writeText(selectionToJson(s.selected));
        if (e.key === 'x' && !s.readOnly) s.removeNodes(s.selected);
        useApp.getState().toast('info', `Copied ${s.selected.length} node${s.selected.length === 1 ? '' : 's'}`);
      } else if (mod && e.key === 'a') {
        e.preventDefault();
        setRfNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
        s.setSelected(s.workflow.nodes.map((n) => n.name));
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected.length && !s.readOnly) {
        s.removeNodes(s.selected);
      } else if (e.key === 'd' && !mod && s.selected.length && !s.readOnly) {
        s.checkpoint();
        for (const name of s.selected) {
          const n = s.workflow.nodes.find((x) => x.name === name);
          if (n) s.updateNode(name, { disabled: !n.disabled });
        }
      } else if (e.key === 'Tab' && !s.readOnly) {
        e.preventDefault();
        setCreator({});
      } else if (e.key === 'Enter' && s.selected.length === 1) {
        s.setOpenNode(s.selected[0]);
      } else if (e.key === 'F2' && s.selected.length === 1 && !s.readOnly) {
        const name = prompt('Rename node', s.selected[0]);
        if (name) s.renameNode(s.selected[0], name);
      } else if (e.key === '1' && e.shiftKey) {
        flow.fitView({ padding: 0.2, duration: 200 });
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, .cm-editor') || store().readOnly || store().openNode) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      try {
        const parsed = JSON.parse(text) as { nodes?: INode[]; connections?: IConnections };
        if (!Array.isArray(parsed.nodes)) return;
        e.preventDefault();
        const center = flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        const minX = Math.min(...parsed.nodes.map((n) => n.position[0]));
        const minY = Math.min(...parsed.nodes.map((n) => n.position[1]));
        const shifted = parsed.nodes.map((n) => ({ ...n, position: [Math.round(n.position[0] - minX + center.x), Math.round(n.position[1] - minY + center.y)] as [number, number] }));
        const names = store().addNodes(shifted, parsed.connections ?? {});
        setRfNodes((nds) => nds.map((n) => ({ ...n, selected: names.includes(n.id) })));
      } catch {
        /* not workflow JSON */
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [flow, store]);

  const hasTrigger = wf.nodes.some((n) => getNodeType(n.type)?.isTrigger);
  const realNodes = wf.nodes.filter((n) => !n.type.endsWith('stickyNote'));
  const triggers = wf.nodes.filter((n) => getNodeType(n.type)?.isTrigger && !n.disabled);
  const running = status === 'running' || status === 'waitingForWebhook';
  const chatTrigger = triggers.find((t) => t.type.endsWith('chatTrigger'));

  return (
    <div
      className="canvas-wrap"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const type = e.dataTransfer.getData('application/8n8-node');
        if (!type) return;
        const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        placeNode(type, [Math.round(p.x - 42), Math.round(p.y - 42)]);
      }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onNodeDoubleClick={(_e, n) => n.type === 'wf' && store().setOpenNode(n.id)}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={null}
        selectionOnDrag
        panOnDrag={[1, 2]}
        panOnScroll
        zoomOnPinch
        minZoom={0.15}
        maxZoom={2.5}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        snapToGrid
        snapGrid={[20, 20]}
      >
        <Background gap={20} size={1.2} color="var(--grid)" />
        <Controls showInteractive={false} position="bottom-left" />
        <MiniMap pannable zoomable position="bottom-right" style={{ width: 160, height: 100 }} nodeColor="var(--border-strong)" />
      </ReactFlow>

      {!realNodes.length && !readOnly && (
        <div className="canvas-empty">
          <button onClick={() => setCreator({})}>
            <Plus size={28} />
            <span>Add first step</span>
          </button>
        </div>
      )}

      {!readOnly && realNodes.length > 0 && (
        <div className="canvas-actions">
          {running ? (
            <button className="danger" onClick={() => store().stop()}><Square size={14} /> Stop</button>
          ) : (
            triggers.length > 1 ? (
              triggers.map((t) => (
                <button key={t.name} className="primary" onClick={() => store().run({ triggerNode: t.name })}><Play size={14} /> {t.name}</button>
              ))
            ) : (
              <button className="primary" disabled={!hasTrigger} title={hasTrigger ? 'Ctrl+Enter' : 'Add a trigger first'} onClick={() => store().run()}>
                <Play size={14} /> Execute workflow
              </button>
            )
          )}
          {Object.keys(runData).length > 0 && !running && (
            <button onClick={() => store().clearRunData()} title="Clear execution data"><Trash2 size={14} /></button>
          )}
          {chatTrigger && <button onClick={() => setChatOpen(!chatOpen)}><MessageCircle size={14} /> Chat</button>}
          <button onClick={() => setCreator({})} title="Add node (Tab)"><Plus size={14} /></button>
        </div>
      )}

      <WebhookBanner />
      <ErrorBanner />

      {creator && <NodeCreator triggersFirst={!hasTrigger && !creator.from && !creator.to} subNodeType={creator.to?.type} onPick={(t) => placeNode(t)} onClose={() => setCreator(null)} />}
      {chatOpen && chatTrigger && <ChatPanel trigger={chatTrigger.name} onClose={() => setChatOpen(false)} />}
    </div>
  );
}

function WebhookBanner() {
  const status = useWorkflow((s) => s.status);
  const urls = useWorkflow((s) => s.testUrls);
  if (status !== 'waitingForWebhook') return null;
  return (
    <div className="webhook-banner">
      <span className="spin" style={{ display: 'inline-flex' }}>⟳</span>
      <div className="grow">
        <div style={{ fontWeight: 600 }}>{urls.some((u) => u.includes('/form-test/')) ? 'Open the form and submit it' : 'Waiting for a test event'}</div>
        {urls.map((u) => (
          <a key={u} href={u} target="_blank" rel="noreferrer" className="mono ellipsis" style={{ fontSize: 11, display: 'block' }}>{u}</a>
        ))}
      </div>
      <button className="sm" onClick={() => navigator.clipboard.writeText(urls[0] ?? '')}><Copy size={12} /> Copy URL</button>
      <button className="sm" onClick={() => useWorkflow.getState().stop()}>Stop listening</button>
    </div>
  );
}

function ErrorBanner() {
  const err = useWorkflow((s) => s.executionError);
  const status = useWorkflow((s) => s.status);
  if (!err || status === 'running') return null;
  return (
    <div className="error-banner">
      <div style={{ fontWeight: 600 }}>{err.node ? `Problem in node “${err.node}”` : 'Problem running workflow'}</div>
      <div>{err.message}</div>
      {err.description && <div style={{ opacity: 0.8, fontSize: 12 }}>{err.description}</div>}
    </div>
  );
}

export function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}
