import type { ICredentialType, INodeType } from '@8n8/workflow';
import { Code } from './nodes/code';
import { Aggregate, Limit, RemoveDuplicates, Sort, SplitOut } from './nodes/data';
import { DataTable } from './nodes/data-table';
import { ExecuteWorkflow, ExecuteWorkflowTrigger } from './nodes/execute-workflow';
import { ErrorTrigger, Filter, If, ManualTrigger, NoOp, StickyNote, StopAndError, Switch } from './nodes/flow';
import { LoopOverItems, Merge, Wait } from './nodes/merge-loop-wait';
import { EditFields } from './nodes/set';
import { HttpRequest } from './nodes/http-request';
import { ScheduleTrigger } from './nodes/schedule';
import { RespondToWebhook, Webhook } from './nodes/webhook';
import { credentials as credentialTypes } from './credentials';
import { integrationCredentials } from './credentials/integrations';
import { GitHub, GitHubTrigger } from './nodes/integrations/github';
import { Gmail, GmailTrigger } from './nodes/integrations/gmail';
import { Notion } from './nodes/integrations/notion';
import { Postgres } from './nodes/integrations/postgres';
import { GoogleSheets } from './nodes/integrations/sheets';
import { Slack, SlackTrigger } from './nodes/integrations/slack';
import { Airtable } from './nodes/integrations/airtable';
import { Discord } from './nodes/integrations/discord';
import { GoogleCalendar, GoogleCalendarTrigger } from './nodes/integrations/google-calendar';
import { GoogleDrive, GoogleDriveTrigger } from './nodes/integrations/google-drive';
import { MySql } from './nodes/integrations/mysql';
import { OpenAi } from './ai/openai';
import { Telegram, TelegramTrigger } from './nodes/integrations/telegram';
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
  DataTable,
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
  Slack,
  Telegram,
  TelegramTrigger,
  GitHub,
  GitHubTrigger,
  Notion,
  Gmail,
  GmailTrigger,
  GoogleSheets,
  Postgres,
  SlackTrigger,
  Discord,
  Airtable,
  GoogleDrive,
  GoogleDriveTrigger,
  GoogleCalendar,
  GoogleCalendarTrigger,
  MySql,
  OpenAi,
];

export const credentials: ICredentialType[] = [...credentialTypes, ...aiCredentials, ...integrationCredentials];

export { buildMime, simplifyMessage } from './nodes/integrations/gmail';
export { columnLetter, spreadsheetId } from './nodes/integrations/sheets';
export { notionId, simplifyPage, toNotionProperties } from './nodes/integrations/notion';
export { buildWhere, quoteIdent } from './nodes/integrations/postgres';
export { verifySlackSignature } from './nodes/integrations/slack';
export { airtableId, matchFormula } from './nodes/integrations/airtable';
export { buildDriveQuery, driveId, multipartRelated } from './nodes/integrations/google-drive';
export { buildEvent, dateOnly, eventTime } from './nodes/integrations/google-calendar';
export { buildMySqlWhere, mysqlConnector, quoteMySqlIdent, type MySqlSession } from './nodes/integrations/mysql';

export * from './ai/llm';
export { calculate, extractJson, schemaFromExample } from './ai/subnodes';

export { ruleToCron } from './nodes/schedule';
export { renderForm, renderSubmitted, parseSubmission, type FormField } from './nodes/form';

export * from './utils/filter';
export * from './utils/object';
