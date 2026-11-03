import type {
  ConnectionType,
  ExecutionMode,
  IBinaryData,
  ICredentialTypeDescription,
  IDataObject,
  IHttpFullResponse,
  IHttpRequestOptions,
  INode,
  INodeExecutionData,
  INodeParameters,
  INodePropertyOption,
  INodeTypeDescription,
  IPairedItem,
  IRunData,
  IWorkflowBase,
  ResourceMapperField,
} from './types';

export interface IWorkflowMeta {
  id?: string;
  name: string;
  active: boolean;
}

export interface IGetNodeParameterOptions {
  /** For resourceLocator params return only `.value` */
  extractValue?: boolean;
  /** Return the raw, unresolved value (expressions are kept as strings) */
  rawExpressions?: boolean;
}

export interface IHelpers {
  httpRequest(options: IHttpRequestOptions): Promise<any>;
  httpRequestWithAuthentication(credentialType: string, options: IHttpRequestOptions, itemIndex?: number): Promise<any>;
  returnJsonArray(data: IDataObject | IDataObject[]): INodeExecutionData[];
  constructExecutionMetaData(
    items: INodeExecutionData[],
    options: { itemData: IPairedItem | IPairedItem[] },
  ): INodeExecutionData[];
  prepareBinaryData(data: Buffer | Uint8Array, fileName?: string, mimeType?: string): Promise<IBinaryData>;
  getBinaryDataBuffer(itemIndex: number, propertyName: string, inputIndex?: number): Promise<Buffer>;
  assertBinaryData(itemIndex: number, propertyName: string): IBinaryData;
  binaryToString(body: Buffer, encoding?: BufferEncoding): string;
  /** Legacy request-promise style helpers, used by many community nodes */
  request(uriOrOptions: string | IDataObject, options?: IDataObject): Promise<any>;
  requestWithAuthentication(credentialType: string, options: IDataObject, additionalCredentialOptions?: IDataObject, itemIndex?: number): Promise<any>;
}

export interface ILogger {
  debug(message: string, meta?: object): void;
  info(message: string, meta?: object): void;
  warn(message: string, meta?: object): void;
  error(message: string, meta?: object): void;
}

export type DataTableColumnType = 'string' | 'number' | 'boolean' | 'date';

export interface IDataTableColumn {
  id: string;
  name: string;
  type: DataTableColumnType;
  index: number;
}

export interface IDataTable {
  id: string;
  name: string;
  columns: IDataTableColumn[];
  createdAt: string;
  updatedAt: string;
}

export type DataTableCondition = 'eq' | 'neq' | 'like' | 'ilike' | 'gt' | 'gte' | 'lt' | 'lte' | 'isEmpty' | 'isNotEmpty' | 'isTrue' | 'isFalse';

export interface IDataTableFilter {
  type: 'and' | 'or';
  filters: Array<{ columnName: string; condition: DataTableCondition; value?: unknown }>;
}

/** Rows always carry `id`, `createdAt` and `updatedAt` next to the user columns. */
export type DataTableRow = Record<string, unknown>;

export interface IDataTableRowsQuery {
  filter?: IDataTableFilter;
  sortBy?: { column: string; direction: 'ASC' | 'DESC' };
  skip?: number;
  take?: number;
}

/** Data tables: small tables stored by Flowmator itself, shared by every workflow. */
export interface IDataTableService {
  listTables(filter?: { name?: string }): Promise<IDataTable[]>;
  /** Finds a table by id, or by name when no id matches. */
  getTable(idOrName: string): Promise<IDataTable | null>;
  createTable(name: string, columns: Array<{ name: string; type: DataTableColumnType }>): Promise<IDataTable>;
  renameTable(id: string, name: string): Promise<IDataTable>;
  deleteTable(id: string): Promise<void>;
  addColumn(tableId: string, column: { name: string; type: DataTableColumnType }): Promise<IDataTableColumn>;
  getRows(tableId: string, query?: IDataTableRowsQuery): Promise<{ count: number; data: DataTableRow[] }>;
  insertRows(tableId: string, rows: DataTableRow[]): Promise<DataTableRow[]>;
  /** Updates every row matching the filter; returns the rows after (or, with dryRun, before and after) the change. */
  updateRows(tableId: string, filter: IDataTableFilter, data: DataTableRow, options?: { dryRun?: boolean }): Promise<DataTableRow[]>;
  /** Updates the rows matching the filter, or inserts one when none match. */
  upsertRow(tableId: string, filter: IDataTableFilter, data: DataTableRow): Promise<DataTableRow[]>;
  deleteRows(tableId: string, filter: IDataTableFilter, options?: { dryRun?: boolean }): Promise<DataTableRow[]>;
}

interface IBaseFunctions {
  getNode(): INode;
  /** Throws when the host has no data table storage (e.g. running the engine without a server). */
  getDataTables(): IDataTableService;
  getWorkflow(): IWorkflowMeta;
  getMode(): ExecutionMode;
  getTimezone(): string;
  getRestApiUrl(): string;
  getInstanceBaseUrl(): string;
  getCredentials<T extends object = IDataObject>(type: string, itemIndex?: number): Promise<T>;
  getWorkflowStaticData(type: 'global' | 'node'): IDataObject;
  helpers: IHelpers;
  logger: ILogger;
}

export interface IExecuteWorkflowInfo {
  id?: string;
  code?: IWorkflowBase;
}

export interface IExecuteWorkflowResult {
  data: INodeExecutionData[][] | null;
  executionId?: string;
}

export interface IExecuteFunctions extends IBaseFunctions {
  getInputData(inputIndex?: number, type?: ConnectionType): INodeExecutionData[];
  getNodeParameter(name: string, itemIndex: number, fallback?: unknown, options?: IGetNodeParameterOptions): any;
  /** `additionalKeys` adds variables such as $response / $pageCount (HTTP pagination). */
  evaluateExpression(expression: string, itemIndex: number, additionalKeys?: Record<string, unknown>): unknown;
  /** The variables expressions see ($json, $input, $('Node'), $now...) for an item. Used by the Code node. */
  getWorkflowDataProxy(itemIndex: number): Record<string, unknown>;
  continueOnFail(): boolean;
  getExecutionId(): string;
  getRunIndex(): number;
  getInputSourceData(inputIndex?: number): { previousNode: string; previousNodeOutput?: number; previousNodeRun?: number } | null;
  putExecutionToWait(waitTill: Date): Promise<void>;
  /** Defined when the node is resumed after a wait; `data` holds what the resume webhook/form received. */
  getResumeData(): { data?: INodeExecutionData[] } | undefined;
  executeWorkflow(
    workflowInfo: IExecuteWorkflowInfo,
    items: INodeExecutionData[],
    options?: { waitForSubWorkflow?: boolean; parentExecution?: boolean },
  ): Promise<IExecuteWorkflowResult>;
  sendMessageToUI(...args: unknown[]): void;
  sendResponse(response: IWebhookResponse): void;
  /** For AI root nodes: fetch what connected sub-nodes supply (models, tools, memory...) */
  getInputConnectionData(type: ConnectionType, itemIndex: number): Promise<unknown>;
  getExecutionCancelSignal(): AbortSignal | undefined;
  getContext(type: 'flow' | 'node'): IDataObject;
  getParentNodes(nodeName: string): string[];
  getChildNodes(nodeName: string): string[];
  getRunData(): IRunData;
}

export interface ISupplyDataFunctions extends Omit<IExecuteFunctions, 'getInputData'> {
  getInputData(inputIndex?: number, type?: ConnectionType): INodeExecutionData[];
}

export interface ITriggerFunctions extends IBaseFunctions {
  emit(data: INodeExecutionData[][], responsePromise?: unknown): void;
  emitError(error: Error): void;
  getNodeParameter(name: string, fallback?: unknown, options?: IGetNodeParameterOptions): any;
  getActivationMode(): 'init' | 'create' | 'update' | 'activate' | 'manual';
}

export interface IPollFunctions extends IBaseFunctions {
  getNodeParameter(name: string, fallback?: unknown, options?: IGetNodeParameterOptions): any;
  __emit(data: INodeExecutionData[][]): void;
}

export interface IWebhookRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: IDataObject;
  params: IDataObject;
  body: unknown;
  rawBody?: Buffer;
  files?: Array<{ fieldName: string; fileName: string; mimeType: string; data: Buffer }>;
  ip?: string;
}

export interface IWebhookResponse {
  statusCode?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface IWebhookFunctions extends IBaseFunctions {
  getRequestObject(): IWebhookRequest;
  getHeaderData(): IDataObject;
  getQueryData(): IDataObject;
  getBodyData(): IDataObject;
  getParamsData(): IDataObject;
  getNodeParameter(name: string, fallback?: unknown, options?: IGetNodeParameterOptions): any;
  getWebhookName(): string;
  getNodeWebhookUrl(name: string): string;
  /** What sub-nodes connected through `type` supply (e.g. the tools of an MCP Server Trigger). */
  getInputConnectionData(type: ConnectionType, itemIndex: number): Promise<unknown>;
}

export interface IWebhookResult {
  workflowData?: INodeExecutionData[][];
  webhookResponse?: IWebhookResponse;
  noWebhookResponse?: boolean;
}

export interface IHookFunctions extends IBaseFunctions {
  getNodeParameter(name: string, fallback?: unknown): any;
  getNodeWebhookUrl(name: string): string;
  getWebhookName(): string;
}

export interface ILoadOptionsFunctions extends IBaseFunctions {
  getNodeParameter(name: string, fallback?: unknown, options?: IGetNodeParameterOptions): any;
  getCurrentNodeParameters(): INodeParameters;
}

export interface ITriggerResponse {
  closeFunction?: () => Promise<void>;
  /** Called when the workflow is run manually from the editor */
  manualTriggerFunction?: () => Promise<void>;
}

export interface ISupplyDataResult {
  response: unknown;
  closeFunction?: () => Promise<void>;
}

export interface INodeType {
  description: INodeTypeDescription;
  execute?(this: IExecuteFunctions): Promise<INodeExecutionData[][] | null>;
  trigger?(this: ITriggerFunctions): Promise<ITriggerResponse | undefined>;
  poll?(this: IPollFunctions): Promise<INodeExecutionData[][] | null>;
  webhook?(this: IWebhookFunctions): Promise<IWebhookResult>;
  supplyData?(this: ISupplyDataFunctions, itemIndex: number): Promise<ISupplyDataResult>;
  webhookMethods?: Record<
    string,
    {
      checkExists(this: IHookFunctions): Promise<boolean>;
      create(this: IHookFunctions): Promise<boolean>;
      delete(this: IHookFunctions): Promise<boolean>;
    }
  >;
  methods?: {
    loadOptions?: Record<string, (this: ILoadOptionsFunctions) => Promise<INodePropertyOption[]>>;
    listSearch?: Record<
      string,
      (this: ILoadOptionsFunctions, filter?: string, paginationToken?: string) => Promise<{ results: INodePropertyOption[]; paginationToken?: string }>
    >;
    resourceMapping?: Record<string, (this: ILoadOptionsFunctions) => Promise<{ fields: ResourceMapperField[]; emptyFieldsNotice?: string }>>;
  };
}

export interface ICredentialType extends ICredentialTypeDescription {
  /** Optional hook to compute derived values (e.g. refresh an access token) before use */
  preAuthentication?(credentials: IDataObject): Promise<IDataObject>;
}

export interface INodeTypes {
  getByNameAndVersion(type: string, version?: number): INodeType;
  getKnownTypes(): string[];
}

export interface ICredentialTypes {
  get(type: string): ICredentialType;
  getKnownTypes(): string[];
}

export type { IHttpFullResponse };
