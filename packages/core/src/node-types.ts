import type { ICredentialType, ICredentialTypes, INodeType, INodeTypes } from '@flowmator/workflow';

/** Imported node type prefixes, mapped onto Flowmator's own names. */
const IMPORT_ALIASES: Array<[string, string]> = [
  ['n8n-nodes-base.', 'flowmator.'],
  ['@n8n/n8n-nodes-langchain.', 'flowmator-ai.'],
];

export function normalizeNodeTypeName(type: string): string {
  for (const [from, to] of IMPORT_ALIASES) if (type.startsWith(from)) return to + type.slice(from.length);
  return type;
}

export class NodeTypesRegistry implements INodeTypes {
  private readonly types = new Map<string, INodeType>();

  register(nodeType: INodeType) {
    this.types.set(nodeType.description.name, nodeType);
  }

  registerAll(nodeTypes: INodeType[]) {
    for (const t of nodeTypes) this.register(t);
  }

  has(type: string) {
    return this.types.has(normalizeNodeTypeName(type));
  }

  /** One implementation per type handles all its versions, so `version` is informational. */
  getByNameAndVersion(type: string, _version?: number): INodeType {
    const t = this.types.get(normalizeNodeTypeName(type));
    if (!t) throw new Error(`Unrecognized node type: ${type}`);
    return t;
  }

  getKnownTypes(): string[] {
    return [...this.types.keys()];
  }

  getAll(): INodeType[] {
    return [...this.types.values()];
  }
}

export class CredentialTypesRegistry implements ICredentialTypes {
  private readonly types = new Map<string, ICredentialType>();

  registerAll(types: ICredentialType[]) {
    for (const t of types) this.types.set(t.name, t);
  }

  get(type: string): ICredentialType {
    const t = this.types.get(type);
    if (!t) throw new Error(`Unrecognized credential type: ${type}`);
    return t;
  }

  getKnownTypes(): string[] {
    return [...this.types.keys()];
  }

  getAll(): ICredentialType[] {
    return [...this.types.values()];
  }
}
