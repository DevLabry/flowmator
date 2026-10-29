export type GenericValue = string | number | boolean | null | undefined | object;

export interface IDataObject {
  [key: string]: GenericValue | IDataObject | GenericValue[] | IDataObject[];
}

export interface IBinaryData {
  data: string; // base64 when stored in memory, otherwise a storage id
  mimeType: string;
  fileName?: string;
  fileExtension?: string;
  fileSize?: number;
  id?: string; // set when stored outside of memory, e.g. "filesystem:abc"
}

export interface IPairedItem {
  item: number;
  input?: number;
}

export interface INodeExecutionData {
  json: IDataObject;
  binary?: Record<string, IBinaryData>;
  pairedItem?: IPairedItem | IPairedItem[] | number;
  error?: NodeErrorJson;
}

export type ConnectionType =
  | 'main'
  | 'ai_agent'
  | 'ai_chain'
  | 'ai_document'
  | 'ai_embedding'
  | 'ai_languageModel'
  | 'ai_memory'
  | 'ai_outputParser'
  | 'ai_retriever'
  | 'ai_textSplitter'
  | 'ai_tool'
  | 'ai_vectorStore';

export interface IConnection {
  node: string;
  type: ConnectionType;
  index: number;
}

/** Same shape as n8n's connection map so exported workflows import unchanged. */
export type NodeOutputConnections = Partial<Record<ConnectionType, Array<IConnection[] | null>>>;
export type IConnections = Record<string, NodeOutputConnections>;

export type OnErrorMode = 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';

export interface INodeCredentialRef {
  id: string | null;
  name: string;
}

export interface INode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: INodeParameters;
  credentials?: Record<string, INodeCredentialRef>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  onError?: OnErrorMode;
  continueOnFail?: boolean; // legacy flag, maps to onError=continueRegularOutput
  webhookId?: string;
}

export type NodeParameterValue = string | number | boolean | null | undefined;
export interface INodeParameters {
  [key: string]: NodeParameterValue | INodeParameters | NodeParameterValue[] | INodeParameters[];
}

export interface IWorkflowSettings {
  executionOrder?: 'v0' | 'v1';
  errorWorkflow?: string;
  timezone?: string;
  saveDataErrorExecution?: 'all' | 'none';
  saveDataSuccessExecution?: 'all' | 'none';
  saveManualExecutions?: boolean;
  saveExecutionProgress?: boolean;
  executionTimeout?: number; // seconds, -1 = none
  callerPolicy?: 'any' | 'none' | 'workflowsFromAList' | 'workflowsFromSameOwner';
  callerIds?: string;
}

export type IPinData = Record<string, INodeExecutionData[]>;

export interface IWorkflowBase {
  id?: string;
  name: string;
  active?: boolean;
  nodes: INode[];
  connections: IConnections;
  settings?: IWorkflowSettings;
  pinData?: IPinData;
  staticData?: IDataObject;
  meta?: IDataObject;
  tags?: string[];
}

/* ---------- run data ---------- */

export interface ISourceData {
  previousNode: string;
  previousNodeOutput?: number;
  previousNodeRun?: number;
}

export interface ITaskData {
  startTime: number;
  executionTime: number;
  executionStatus?: 'success' | 'error' | 'waiting';
  data?: Partial<Record<ConnectionType, Array<INodeExecutionData[] | null>>>;
  /** One entry per input index, describing where that input's data came from. */
  source: Array<ISourceData | null>;
  error?: NodeErrorJson;
  hints?: string[];
}

export type IRunData = Record<string, ITaskData[]>;

export interface ITaskDataConnections {
  main: Array<INodeExecutionData[] | null>;
  [type: string]: Array<INodeExecutionData[] | null>;
}

export interface IExecuteData {
  node: INode;
  data: ITaskDataConnections;
  source: { main: Array<ISourceData | null> } | null;
  /** Set when a waiting node is re-run after its wait finished (timer or resume webhook/form). */
  resume?: { data?: INodeExecutionData[] };
}

export interface IWaitingForExecution {
  [nodeName: string]: Array<{ main: Array<INodeExecutionData[] | null>; source: Array<ISourceData | null> }>;
}

/** Everything needed to resume an execution later (e.g. after a Wait node). Fully JSON serializable. */
export interface IExecutionState {
  runData: IRunData;
  pinData?: IPinData;
  nodeExecutionStack: IExecuteData[];
  waitingExecution: IWaitingForExecution;
  lastNodeExecuted?: string;
  destinationNode?: string;
  /** $flow / node context data, keyed "flow" and "node:<name>" */
  contextData?: Record<string, IDataObject>;
}

export type ExecutionStatus = 'new' | 'running' | 'success' | 'error' | 'canceled' | 'waiting' | 'crashed';
export type ExecutionMode = 'manual' | 'trigger' | 'webhook' | 'internal' | 'retry' | 'integrated' | 'error' | 'cli' | 'evaluation';

export interface IRun {
  status: ExecutionStatus;
  mode: ExecutionMode;
  startedAt: Date;
  stoppedAt?: Date;
  waitTill?: Date | null;
  data: {
    resultData: { runData: IRunData; pinData?: IPinData; lastNodeExecuted?: string; error?: NodeErrorJson };
    executionData?: IExecutionState;
  };
}

export interface NodeErrorJson {
  message: string;
  description?: string;
  name?: string;
  stack?: string;
  node?: string;
  itemIndex?: number;
  httpCode?: string;
  context?: IDataObject;
}

/* ---------- node type descriptions ---------- */

export type NodePropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'multiOptions'
  | 'collection'
  | 'fixedCollection'
  | 'json'
  | 'dateTime'
  | 'color'
  | 'hidden'
  | 'notice'
  | 'resourceLocator'
  | 'resourceMapper'
  | 'filter'
  | 'assignmentCollection'
  | 'credentialsSelect'
  | 'button';

export interface INodePropertyOption {
  name: string;
  value: string | number | boolean;
  description?: string;
  action?: string;
}

export interface INodePropertyCollection {
  name: string;
  displayName: string;
  values: INodeProperties[];
}

export interface IDisplayOptions {
  show?: Record<string, Array<NodeParameterValue>>;
  hide?: Record<string, Array<NodeParameterValue>>;
}

export interface INodeProperties {
  displayName: string;
  name: string;
  type: NodePropertyType;
  default: NodeParameterValue | INodeParameters | INodeParameters[] | NodeParameterValue[];
  description?: string;
  hint?: string;
  placeholder?: string;
  required?: boolean;
  noDataExpression?: boolean;
  displayOptions?: IDisplayOptions;
  options?: Array<INodePropertyOption | INodeProperties | INodePropertyCollection>;
  typeOptions?: {
    multipleValues?: boolean;
    multipleValueButtonText?: string;
    rows?: number;
    password?: boolean;
    minValue?: number;
    maxValue?: number;
    numberPrecision?: number;
    editor?: 'codeNodeEditor' | 'jsEditor' | 'htmlEditor' | 'sqlEditor' | 'json';
    editorLanguage?: 'javaScript' | 'python' | 'json' | 'html' | 'sql';
    loadOptionsMethod?: string;
    loadOptionsDependsOn?: string[];
    sortable?: boolean;
  };
  modes?: Array<{ displayName: string; name: string; type: 'string' | 'list'; placeholder?: string }>;
}

export type NodeGroup = 'trigger' | 'input' | 'output' | 'transform' | 'organization' | 'schedule';

export interface INodeInputConfiguration {
  type: ConnectionType;
  displayName?: string;
  required?: boolean;
  maxConnections?: number;
}

export interface INodeTypeDescription {
  name: string;
  displayName: string;
  description: string;
  group: NodeGroup[];
  version: number | number[];
  defaults: { name: string; color?: string };
  icon?: string;
  subtitle?: string;
  inputs: Array<ConnectionType | INodeInputConfiguration>;
  outputs: Array<ConnectionType | INodeInputConfiguration>;
  /** Labels for outputs, e.g. ["true", "false"] */
  outputNames?: string[];
  inputNames?: string[];
  properties: INodeProperties[];
  credentials?: Array<{ name: string; required?: boolean; displayOptions?: IDisplayOptions }>;
  webhooks?: IWebhookDescription[];
  polling?: boolean;
  maxNodes?: number;
  codex?: { categories?: string[]; subcategories?: Record<string, string[]>; alias?: string[] };
  /** Outputs can be computed from parameters (e.g. Switch with N rules). */
  dynamicOutputs?: (parameters: INodeParameters) => Array<ConnectionType | INodeInputConfiguration>;
  dynamicOutputNames?: (parameters: INodeParameters) => string[];
  dynamicInputs?: (parameters: INodeParameters) => Array<ConnectionType | INodeInputConfiguration>;
}

export interface IWebhookDescription {
  name: 'default' | 'setup' | string;
  httpMethod: string; // may be an expression like '={{$parameter["httpMethod"]}}'
  path: string;
  responseMode?: string;
  isFullPath?: boolean;
  restartWebhook?: boolean; // used by the Wait node
}

export interface ICredentialTypeDescription {
  name: string;
  displayName: string;
  extends?: string[];
  properties: INodeProperties[];
  documentationUrl?: string;
  /** How to inject the credential into an HTTP request. */
  authenticate?: {
    type: 'generic';
    properties: {
      headers?: Record<string, string>;
      qs?: Record<string, string>;
      body?: Record<string, string>;
      auth?: { username: string; password: string };
    };
  };
  test?: { request: IHttpRequestOptions };
}

export interface IHttpRequestOptions {
  url: string;
  baseURL?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  qs?: IDataObject;
  body?: unknown;
  json?: boolean;
  timeout?: number;
  returnFullResponse?: boolean;
  ignoreHttpStatusErrors?: boolean;
  encoding?: 'json' | 'text' | 'arraybuffer';
  auth?: { username: string; password: string };
}

export interface IHttpFullResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: unknown;
}
