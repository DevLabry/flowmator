import {
  createExpressionContext,
  evaluateExpression,
  NodeOperationError,
  resolveParameterValue,
  type IDataObject,
  type IGetNodeParameterOptions,
  type IHookFunctions,
  type ILoadOptionsFunctions,
  type INodeExecutionData,
  type INodeParameters,
  type IPollFunctions,
  type ITriggerFunctions,
  type IWebhookFunctions,
  type IWebhookRequest,
  type ConnectionType,
} from '@flowmator/workflow';
import { BaseNodeContext, ExecuteContext, type BaseContextParams } from './node-context';

/** Parameter resolution outside of an item context (triggers, pollers, webhooks): expressions see no input data. */
class NoItemContext extends BaseNodeContext {
  getNodeParameter(name: string, fallback?: unknown, options?: IGetNodeParameterOptions): any {
    const raw = this.getRawParameter(name);
    if (raw === undefined) {
      if (fallback !== undefined) return fallback;
      throw new NodeOperationError(this.node, `Could not get parameter "${name}"`);
    }
    if (options?.rawExpressions) return raw;
    const ctx = createExpressionContext({
      workflow: this.workflow,
      runData: {},
      activeNodeName: this.node.name,
      itemIndex: 0,
      runIndex: 0,
      inputData: this.inputForExpressions(),
      mode: this.additionalData.mode,
      executionId: this.additionalData.executionId,
      timezone: this.getTimezone(),
      variables: this.additionalData.variables,
    });
    return this.finalizeParameter(
      resolveParameterValue(raw, (expr) => evaluateExpression(expr, ctx)),
      options,
    );
  }

  protected inputForExpressions(): INodeExecutionData[] {
    return [];
  }
}

export class TriggerContext extends NoItemContext implements ITriggerFunctions {
  constructor(
    p: BaseContextParams,
    private readonly activation: ReturnType<ITriggerFunctions['getActivationMode']>,
    readonly emit: (data: INodeExecutionData[][], responsePromise?: unknown) => void,
    readonly emitError: (error: Error) => void,
  ) {
    super(p);
  }
  getActivationMode() {
    return this.activation;
  }
}

export class PollContext extends NoItemContext implements IPollFunctions {
  constructor(
    p: BaseContextParams,
    readonly __emit: (data: INodeExecutionData[][]) => void,
  ) {
    super(p);
  }
}

export class HookContext extends NoItemContext implements IHookFunctions {
  constructor(
    p: BaseContextParams,
    private readonly webhookName: string,
    private readonly urlFor: (name: string) => string,
  ) {
    super(p);
  }
  getWebhookName() {
    return this.webhookName;
  }
  getNodeWebhookUrl(name: string) {
    return this.urlFor(name);
  }
}

export class WebhookContext extends NoItemContext implements IWebhookFunctions {
  constructor(
    p: BaseContextParams,
    private readonly request: IWebhookRequest,
    private readonly webhookName: string,
    private readonly urlFor: (name: string) => string,
  ) {
    super(p);
  }
  protected inputForExpressions(): INodeExecutionData[] {
    return [{ json: { headers: this.request.headers, query: this.request.query, body: this.request.body, params: this.request.params } as IDataObject }];
  }
  getRequestObject() {
    return this.request;
  }
  getHeaderData() {
    return this.request.headers as IDataObject;
  }
  getQueryData() {
    return this.request.query;
  }
  getBodyData() {
    return (this.request.body ?? {}) as IDataObject;
  }
  getParamsData() {
    return this.request.params;
  }
  getWebhookName() {
    return this.webhookName;
  }
  getNodeWebhookUrl(name: string) {
    return this.urlFor(name);
  }

  private subNodes?: ExecuteContext;
  /** For triggers with sub-node inputs (MCP Server Trigger): what the connected sub-nodes supply. */
  getInputConnectionData(type: ConnectionType, itemIndex: number): Promise<unknown> {
    this.subNodes ??= new ExecuteContext({
      workflow: this.workflow,
      node: this.node,
      additionalData: this.additionalData,
      runData: {},
      executeData: { node: this.node, data: { main: [this.inputForExpressions()] }, source: null },
      runIndex: 0,
      contextData: {},
    });
    return this.subNodes.getInputConnectionData(type, itemIndex);
  }
  async closeSubNodes() {
    await this.subNodes?.closeSubNodes();
  }
}

export class LoadOptionsContext extends NoItemContext implements ILoadOptionsFunctions {
  getCurrentNodeParameters(): INodeParameters {
    return this.node.parameters;
  }
}
