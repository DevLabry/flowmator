import type { INode, NodeErrorJson } from './types';

export class WorkflowError extends Error {
  description?: string;
  constructor(message: string, options?: { description?: string; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'WorkflowError';
    this.description = options?.description;
  }
}

export class ExpressionError extends WorkflowError {
  constructor(message: string, options?: { description?: string; cause?: unknown }) {
    super(message, options);
    this.name = 'ExpressionError';
  }
}

export class NodeOperationError extends WorkflowError {
  node: INode;
  itemIndex?: number;
  constructor(node: INode, error: string | Error, options?: { description?: string; itemIndex?: number }) {
    super(typeof error === 'string' ? error : error.message, {
      description: options?.description,
      cause: typeof error === 'string' ? undefined : error,
    });
    this.name = 'NodeOperationError';
    this.node = node;
    this.itemIndex = options?.itemIndex;
    if (typeof error !== 'string' && error.stack) this.stack = error.stack;
  }
}

export class NodeApiError extends NodeOperationError {
  httpCode?: string;
  constructor(node: INode, error: Error & { statusCode?: number; body?: unknown }, options?: { description?: string; itemIndex?: number }) {
    super(node, error, options);
    this.name = 'NodeApiError';
    if (error.statusCode) this.httpCode = String(error.statusCode);
    if (!this.description && error.body !== undefined) {
      this.description = typeof error.body === 'string' ? error.body : JSON.stringify(error.body);
    }
  }
}

/** Thrown by the Stop and Error node or when an execution is cancelled */
export class ExecutionCancelledError extends WorkflowError {
  constructor() {
    super('The execution was cancelled');
    this.name = 'ExecutionCancelledError';
  }
}

export function toErrorJson(error: unknown, node?: INode): NodeErrorJson {
  if (error instanceof Error) {
    const json: NodeErrorJson = { message: error.message, name: error.name, stack: error.stack };
    if (error instanceof WorkflowError && error.description) json.description = error.description;
    if (error instanceof NodeOperationError) {
      json.node = error.node.name;
      if (error.itemIndex !== undefined) json.itemIndex = error.itemIndex;
    } else if (node) {
      json.node = node.name;
    }
    if (error instanceof NodeApiError && error.httpCode) json.httpCode = error.httpCode;
    return json;
  }
  return { message: String(error), node: node?.name };
}
