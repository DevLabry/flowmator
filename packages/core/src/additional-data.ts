import type {
  ExecutionMode,
  IDataObject,
  IDataTableService,
  IExecuteWorkflowInfo,
  IExecuteWorkflowResult,
  IExecutionState,
  IHttpRequestOptions,
  ILogger,
  INode,
  INodeExecutionData,
  IRun,
  ITaskData,
  IWebhookResponse,
} from '@flowmator/workflow';
import type { BinaryDataStore } from './binary-data';

export interface ICredentialsHelper {
  /** Returns decrypted credential data for the node's credential of `type`. */
  getDecrypted(node: INode, type: string): Promise<IDataObject>;
  /** Applies the credential to a request (headers, query, auth, OAuth tokens...). */
  authenticate(type: string, credentials: IDataObject, request: IHttpRequestOptions, node: INode): Promise<IHttpRequestOptions>;
  /** Optional hook used to refresh OAuth2 tokens on 401 and persist them. */
  refresh?(node: INode, type: string, credentials: IDataObject): Promise<IDataObject | null>;
}

export interface ExecutionHooks {
  workflowExecuteBefore?(): Promise<void> | void;
  workflowExecuteAfter?(run: IRun): Promise<void> | void;
  nodeExecuteBefore?(nodeName: string): Promise<void> | void;
  nodeExecuteAfter?(nodeName: string, task: ITaskData, state: IExecutionState): Promise<void> | void;
  sendMessageToUI?(nodeName: string, args: unknown[]): void;
}

export interface IWorkflowExecuteAdditionalData {
  executionId: string;
  mode: ExecutionMode;
  credentialsHelper?: ICredentialsHelper;
  variables?: IDataObject;
  timezone?: string;
  instanceBaseUrl?: string;
  restApiUrl?: string;
  webhookBaseUrl?: string;
  webhookTestBaseUrl?: string;
  webhookWaitingBaseUrl?: string;
  formWaitingBaseUrl?: string;
  hooks?: ExecutionHooks;
  logger?: ILogger;
  signal?: AbortSignal;
  binaryData?: BinaryDataStore;
  /** Data tables stored by the server (Data Table node). */
  dataTables?: IDataTableService;
  /** Runs another workflow (by id or inline code). The core falls back to in-process execution of inline code. */
  executeWorkflow?(
    info: IExecuteWorkflowInfo,
    items: INodeExecutionData[],
    options: { parentExecutionId: string; waitForSubWorkflow: boolean },
  ): Promise<IExecuteWorkflowResult>;
  /** Respond to Webhook node: delivers the HTTP response for the triggering webhook. */
  sendResponse?(response: IWebhookResponse): void;
  /** For executions started by a test webhook etc. */
  executionCustomData?: IDataObject;
}

export const consoleLogger: ILogger = {
  debug: () => {},
  info: (m, meta) => console.log(m, meta ?? ''),
  warn: (m, meta) => console.warn(m, meta ?? ''),
  error: (m, meta) => console.error(m, meta ?? ''),
};
