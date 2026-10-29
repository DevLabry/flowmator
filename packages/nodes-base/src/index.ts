import type { ICredentialType, INodeType } from '@8n8/workflow';
import { Code } from './nodes/code';
import { Aggregate, Limit, RemoveDuplicates, Sort, SplitOut } from './nodes/data';
import { ExecuteWorkflow, ExecuteWorkflowTrigger } from './nodes/execute-workflow';
import { ErrorTrigger, Filter, If, ManualTrigger, NoOp, StickyNote, StopAndError, Switch } from './nodes/flow';
import { LoopOverItems, Merge, Wait } from './nodes/merge-loop-wait';
import { EditFields } from './nodes/set';
import { HttpRequest } from './nodes/http-request';
import { ScheduleTrigger } from './nodes/schedule';
import { RespondToWebhook, Webhook } from './nodes/webhook';
import { credentials as credentialTypes } from './credentials';
import { aiCredentials, AiAgent, ChatTrigger } from './ai/agent';
import { AnthropicChatModel, CalculatorTool, CodeTool, HttpRequestTool, OllamaChatModel, OpenAiChatModel, SimpleMemory, StructuredOutputParser, WorkflowTool } from './ai/subnodes';
import { ConvertToFile, ExtractFromFile, ReadWriteFile } from './nodes/files';
import { FormTrigger } from './nodes/form';
import { Html, Markdown, Xml } from './nodes/markup';
import { CompareDatasets, Summarize } from './nodes/summarize-compare';
import { ExecuteCommand, SendEmail } from './nodes/system';
import { CryptoNode, DateTimeNode, RenameKeys } from './nodes/transform';

export const nodes: INodeType[] = [
  ManualTrigger,
  ErrorTrigger,
  NoOp,
  StickyNote,
  StopAndError,
  If,
  Filter,
  Switch,
  Merge,
  LoopOverItems,
  Wait,
  EditFields,
  Code,
  Limit,
  Sort,
  Aggregate,
  SplitOut,
  RemoveDuplicates,
  ExecuteWorkflow,
  ExecuteWorkflowTrigger,
  Webhook,
  RespondToWebhook,
  ScheduleTrigger,
  HttpRequest,
  DateTimeNode,
  CryptoNode,
  RenameKeys,
  Summarize,
  CompareDatasets,
  Xml,
  Html,
  Markdown,
  ExtractFromFile,
  ConvertToFile,
  ReadWriteFile,
  SendEmail,
  ExecuteCommand,
  FormTrigger,
  AiAgent,
  ChatTrigger,
  AnthropicChatModel,
  OpenAiChatModel,
  OllamaChatModel,
  SimpleMemory,
  CalculatorTool,
  CodeTool,
  HttpRequestTool,
  WorkflowTool,
  StructuredOutputParser,
];

export const credentials: ICredentialType[] = [...credentialTypes, ...aiCredentials];

export * from './ai/llm';
export { calculate, extractJson, schemaFromExample } from './ai/subnodes';

export { ruleToCron } from './nodes/schedule';
export { renderForm, renderSubmitted, parseSubmission, type FormField } from './nodes/form';

export * from './utils/filter';
export * from './utils/object';
