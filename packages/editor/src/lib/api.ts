import type {
  ICredentialTypeDescription,
  IConnections,
  INode,
  INodeTypeDescription,
  IPinData,
  IRun,
  IRunData,
  IWorkflowSettings,
  ExecutionStatus,
  ExecutionMode,
  IDataObject,
  INodePropertyOption,
} from '@8n8/workflow';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(json.message ?? res.statusText, res.status, json.hint);
  return json.data as T;
}

export interface NodeTypeDescription extends INodeTypeDescription {
  hasDynamicIO: boolean;
  isTrigger: boolean;
  hasWebhook: boolean;
  supplyData: boolean;
  loadOptionsMethods: string[];
}

export interface WorkflowData {
  id?: string;
  name: string;
  active: boolean;
  nodes: INode[];
  connections: IConnections;
  settings: IWorkflowSettings;
  pinData: IPinData;
  tags: string[];
  versionId?: string;
  activationError?: string | null;
  updatedAt?: string;
  createdAt?: string;
  isArchived?: boolean;
  parentFolderId?: string | null;
  staticData?: IDataObject;
}

export interface ExecutionSummary {
  id: string;
  workflowId: string | null;
  workflowName: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  waitTill: string | null;
  retryOf: string | null;
  retrySuccessId: string | null;
}

export interface ExecutionFull extends Omit<ExecutionSummary, 'workflowName'> {
  data: IRun['data'] | null;
  workflowData: WorkflowData;
}

export interface CredentialSummary {
  id: string;
  name: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  data?: IDataObject;
}

export interface NodeIO {
  inputs: Array<string | { type: string; displayName?: string; required?: boolean; maxConnections?: number }>;
  outputs: Array<string | { type: string; displayName?: string }>;
  inputNames: string[];
  outputNames: string[];
}

export const Api = {
  settings: () => api<IDataObject>('GET', '/rest/settings'),
  nodeTypes: () => api<NodeTypeDescription[]>('GET', '/rest/node-types'),
  nodeIO: (type: string, parameters: IDataObject, onError?: string) => api<NodeIO>('POST', '/rest/node-types/io', { type, parameters, onError }),
  loadOptions: (body: IDataObject) => api<INodePropertyOption[] | { results: INodePropertyOption[] }>('POST', '/rest/dynamic-node-parameters/options', body),
  credentialTypes: () => api<ICredentialTypeDescription[]>('GET', '/rest/credential-types'),

  workflows: (query = '') => api<WorkflowData[]>('GET', `/rest/workflows${query}`),
  workflow: (id: string) => api<WorkflowData>('GET', `/rest/workflows/${id}`),
  createWorkflow: (wf: Partial<WorkflowData>) => api<WorkflowData>('POST', '/rest/workflows', wf),
  importWorkflows: (wf: unknown) => api<WorkflowData[]>('POST', '/rest/workflows/import', wf),
  updateWorkflow: (id: string, wf: Partial<WorkflowData>, force = false) => api<WorkflowData>('PATCH', `/rest/workflows/${id}${force ? '?forceSave=true' : ''}`, wf),
  deleteWorkflow: (id: string) => api('DELETE', `/rest/workflows/${id}`),
  copyWorkflow: (id: string) => api<WorkflowData>('POST', `/rest/workflows/${id}/copy`),
  activate: (id: string) => api<WorkflowData>('POST', `/rest/workflows/${id}/activate`),
  deactivate: (id: string) => api<WorkflowData>('POST', `/rest/workflows/${id}/deactivate`),
  archive: (id: string) => api<WorkflowData>('POST', `/rest/workflows/${id}/archive`),
  unarchive: (id: string) => api<WorkflowData>('POST', `/rest/workflows/${id}/unarchive`),
  run: (id: string, body: IDataObject, pushRef: string) =>
    api<{ executionId?: string; waitingForWebhook?: boolean; testUrls?: string[] }>('POST', `/rest/workflows/${id}/run?pushRef=${pushRef}`, body),
  cancelTestWebhook: (id: string) => api('DELETE', `/rest/workflows/${id}/test-webhook`),
  webhookUrls: (id: string) => api<Array<{ node: string; test: string; production: string }>>('GET', `/rest/workflows/${id}/webhook-urls`),
  history: (id: string) => api<Array<{ versionId: string; name: string; createdAt: string }>>('GET', `/rest/workflow-history/workflow/${id}`),
  historyVersion: (id: string, v: string) => api<{ nodes: INode[]; connections: IConnections }>('GET', `/rest/workflow-history/workflow/${id}/version/${v}`),
  restoreVersion: (id: string, v: string) => api<WorkflowData>('POST', `/rest/workflow-history/workflow/${id}/version/${v}/restore`),

  executions: (query = '') => api<{ results: ExecutionSummary[]; count: number }>('GET', `/rest/executions${query}`),
  execution: (id: string) => api<ExecutionFull>('GET', `/rest/executions/${id}`),
  deleteExecution: (id: string) => api('DELETE', `/rest/executions/${id}`),
  deleteExecutions: (body: IDataObject) => api('POST', '/rest/executions/delete', body),
  retryExecution: (id: string, loadWorkflow: boolean) => api<{ status: string }>('POST', `/rest/executions/${id}/retry`, { loadWorkflow }),
  stopExecution: (id: string) => api('POST', `/rest/executions/${id}/stop`),

  credentials: (type?: string) => api<CredentialSummary[]>('GET', `/rest/credentials${type ? `?type=${type}` : ''}`),
  credential: (id: string) => api<CredentialSummary>('GET', `/rest/credentials/${id}?includeData=true`),
  createCredential: (c: { name: string; type: string; data: IDataObject }) => api<CredentialSummary>('POST', '/rest/credentials', c),
  updateCredential: (id: string, c: { name?: string; data?: IDataObject }) => api<CredentialSummary>('PATCH', `/rest/credentials/${id}`, c),
  deleteCredential: (id: string) => api('DELETE', `/rest/credentials/${id}`),
  testCredential: (c: { id?: string; type: string; data: IDataObject }) => api<{ status: string; message: string }>('POST', '/rest/credentials/test', { credentials: c }),
  oauthUrl: (id: string) => api<string>('GET', `/rest/oauth2-credential/auth?id=${id}`),

  tags: () => api<Array<{ id: string; name: string; usageCount?: number }>>('GET', '/rest/tags?withUsageCount=true'),
  variables: () => api<Array<{ id: string; key: string; value: string }>>('GET', '/rest/variables'),
  createVariable: (key: string, value: string) => api('POST', '/rest/variables', { key, value }),
  updateVariable: (id: string, key: string, value: string) => api('PATCH', `/rest/variables/${id}`, { key, value }),
  deleteVariable: (id: string) => api('DELETE', `/rest/variables/${id}`),
  apiKeys: () => api<Array<{ id: string; label: string; apiKey: string; createdAt: string }>>('GET', '/rest/api-keys'),
  createApiKey: (label: string) => api<{ id: string; apiKey: string }>('POST', '/rest/api-keys', { label }),
  deleteApiKey: (id: string) => api('DELETE', `/rest/api-keys/${id}`),
};

export type { IRunData };
