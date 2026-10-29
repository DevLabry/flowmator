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
];

export const credentials: ICredentialType[] = credentialTypes;

export { ruleToCron } from './nodes/schedule';

export * from './utils/filter';
export * from './utils/object';
