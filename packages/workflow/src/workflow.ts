import type { INodeTypes } from './interfaces';
import type {
  ConnectionType,
  IConnection,
  IConnections,
  IDataObject,
  INode,
  IPinData,
  IWorkflowBase,
  IWorkflowSettings,
} from './types';

/** Connections indexed by destination: { [destNode]: { [type]: [ [ {node: sourceNode, index: sourceOutput} ] per input ] } } */
export type ConnectionsByDestination = Record<string, Partial<Record<ConnectionType, IConnection[][]>>>;

export function mapConnectionsByDestination(connections: IConnections): ConnectionsByDestination {
  const result: ConnectionsByDestination = {};
  for (const [sourceNode, byType] of Object.entries(connections)) {
    for (const [type, outputs] of Object.entries(byType) as Array<[ConnectionType, Array<IConnection[] | null>]>) {
      outputs?.forEach((targets, outputIndex) => {
        for (const target of targets ?? []) {
          const dest = (result[target.node] ??= {});
          const inputs = (dest[target.type] ??= []);
          while (inputs.length <= target.index) inputs.push([]);
          inputs[target.index].push({ node: sourceNode, type, index: outputIndex });
        }
      });
    }
  }
  return result;
}

export class Workflow {
  id?: string;
  name: string;
  active: boolean;
  nodes: Record<string, INode> = {};
  connectionsBySource: IConnections;
  connectionsByDestination: ConnectionsByDestination;
  settings: IWorkflowSettings;
  pinData?: IPinData;
  staticData: IDataObject;
  nodeTypes: INodeTypes;

  constructor(params: IWorkflowBase & { nodeTypes: INodeTypes }) {
    this.id = params.id;
    this.name = params.name;
    this.active = params.active ?? false;
    for (const node of params.nodes) this.nodes[node.name] = node;
    this.connectionsBySource = params.connections;
    this.connectionsByDestination = mapConnectionsByDestination(params.connections);
    this.settings = params.settings ?? {};
    this.pinData = params.pinData;
    this.staticData = params.staticData ?? {};
    this.nodeTypes = params.nodeTypes;
  }

  getNode(name: string): INode | null {
    return this.nodes[name] ?? null;
  }

  getNodeById(id: string): INode | null {
    return Object.values(this.nodes).find((n) => n.id === id) ?? null;
  }

  /** Direct children through `type` connections, optionally limited to one output index. */
  getDirectChildren(nodeName: string, type: ConnectionType = 'main', outputIndex?: number): IConnection[] {
    const outputs = this.connectionsBySource[nodeName]?.[type] ?? [];
    const result: IConnection[] = [];
    outputs.forEach((targets, i) => {
      if (outputIndex !== undefined && i !== outputIndex) return;
      for (const t of targets ?? []) result.push(t);
    });
    return result;
  }

  getDirectParents(nodeName: string, type: ConnectionType = 'main'): IConnection[] {
    return (this.connectionsByDestination[nodeName]?.[type] ?? []).flat();
  }

  /** All descendants (breadth first, no duplicates). */
  getChildNodes(nodeName: string, type: ConnectionType | 'ALL' = 'main', depth = -1): string[] {
    return this.walk(nodeName, depth, (name) =>
      type === 'ALL'
        ? Object.keys(this.connectionsBySource[name] ?? {}).flatMap((t) => this.getDirectChildren(name, t as ConnectionType))
        : this.getDirectChildren(name, type),
    );
  }

  /** All ancestors (breadth first, no duplicates). */
  getParentNodes(nodeName: string, type: ConnectionType | 'ALL' = 'main', depth = -1): string[] {
    return this.walk(nodeName, depth, (name) =>
      type === 'ALL'
        ? Object.keys(this.connectionsByDestination[name] ?? {}).flatMap((t) => this.getDirectParents(name, t as ConnectionType))
        : this.getDirectParents(name, type),
    );
  }

  private walk(start: string, depth: number, next: (name: string) => IConnection[]): string[] {
    const seen = new Set<string>([start]);
    const result: string[] = [];
    let frontier = [start];
    let level = 0;
    while (frontier.length && (depth === -1 || level < depth)) {
      const nextFrontier: string[] = [];
      for (const name of frontier) {
        for (const c of next(name)) {
          if (seen.has(c.node)) continue;
          seen.add(c.node);
          result.push(c.node);
          nextFrontier.push(c.node);
        }
      }
      frontier = nextFrontier;
      level++;
    }
    return result;
  }

  /** Number of main inputs a node has, based on its type description (dynamic inputs included). */
  getNodeInputCount(node: INode): number {
    const type = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    const inputs = type.description.dynamicInputs?.(node.parameters) ?? type.description.inputs;
    return inputs.filter((i) => (typeof i === 'string' ? i : i.type) === 'main').length;
  }

  getNodeOutputCount(node: INode): number {
    const type = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    const outputs = type.description.dynamicOutputs?.(node.parameters) ?? type.description.outputs;
    let count = outputs.filter((o) => (typeof o === 'string' ? o : o.type) === 'main').length;
    if (node.onError === 'continueErrorOutput') count++;
    return count;
  }

  isTriggerNode(node: INode): boolean {
    const type = this.nodeTypes.getByNameAndVersion(node.type, node.typeVersion);
    return !!(type.trigger || type.poll || type.webhook) || type.description.group.includes('trigger');
  }

  getTriggerNodes(): INode[] {
    return Object.values(this.nodes).filter((n) => !n.disabled && this.isTriggerNode(n));
  }

  /**
   * Picks the node to start from. With a destination node, the trigger must be one of its ancestors.
   */
  getStartNode(destinationNode?: string): INode | undefined {
    const candidates = destinationNode
      ? [destinationNode, ...this.getParentNodes(destinationNode)].map((n) => this.nodes[n])
      : Object.values(this.nodes);
    const triggers = candidates.filter((n) => n && !n.disabled && this.isTriggerNode(n));
    if (triggers.length) {
      // prefer manual triggers when several exist
      return triggers.find((n) => n.type.endsWith('manualTrigger')) ?? triggers[0];
    }
    // legacy: a node without any main parents
    return candidates.find((n) => n && !n.disabled && this.getDirectParents(n.name).length === 0);
  }

  /** Renames a node and rewrites connections plus expression references to it. */
  renameNode(oldName: string, newName: string): void {
    const node = this.nodes[oldName];
    if (!node) return;
    delete this.nodes[oldName];
    node.name = newName;
    this.nodes[newName] = node;

    const conns: IConnections = {};
    for (const [src, byType] of Object.entries(this.connectionsBySource)) {
      for (const outputs of Object.values(byType)) {
        for (const targets of outputs ?? []) for (const t of targets ?? []) if (t.node === oldName) t.node = newName;
      }
      conns[src === oldName ? newName : src] = byType;
    }
    this.connectionsBySource = conns;
    this.connectionsByDestination = mapConnectionsByDestination(conns);

    for (const n of Object.values(this.nodes)) n.parameters = renameInParameters(n.parameters, oldName, newName) as typeof n.parameters;
    if (this.pinData?.[oldName]) {
      this.pinData[newName] = this.pinData[oldName];
      delete this.pinData[oldName];
    }
  }

  toJSON(): IWorkflowBase {
    return {
      id: this.id,
      name: this.name,
      active: this.active,
      nodes: Object.values(this.nodes),
      connections: this.connectionsBySource,
      settings: this.settings,
      pinData: this.pinData,
      staticData: this.staticData,
    };
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function renameInExpression(value: string, oldName: string, newName: string): string {
  if (!value.startsWith('=')) return value;
  const o = escapeRegExp(oldName);
  const quoted = (q: string) => new RegExp(`(\\$\\(|\\$node\\[|\\$items\\()\\s*${q}${o}${q}`, 'g');
  let out = value;
  for (const q of ["'", '"', '`']) {
    out = out.replace(quoted(q), (m) => m.replace(`${q}${oldName}${q}`, `${q}${newName}${q}`));
  }
  return out.replace(new RegExp(`\\$node\\.${o}\\b`, 'g'), `$node["${newName}"]`);
}

function renameInParameters(value: unknown, oldName: string, newName: string): unknown {
  if (typeof value === 'string') return renameInExpression(value, oldName, newName);
  if (Array.isArray(value)) return value.map((v) => renameInParameters(v, oldName, newName));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameInParameters(v, oldName, newName)]));
  }
  return value;
}
