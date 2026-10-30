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
import { AnthropicChatModel, CalculatorTool, CodeTool, GeminiChatModel, HttpRequestTool, OllamaChatModel, OpenAiChatModel, PostgresChatMemory, RedisChatMemory, SimpleMemory, StructuredOutputParser, WorkflowTool } from './ai/subnodes';
import { McpClientTool, McpServerTrigger } from './ai/mcp';
import { ragNodes } from './ai/rag';
import { chainNodes } from './ai/chains';
import { modelCredentials, modelNodes } from './ai/models';
import { toolNodes } from './ai/tools';
import { moreVectorStores, vectorStoreCredentials } from './ai/vector-stores';
import { evaluationNodes } from './nodes/evaluation';
import { ConvertToFile, ExtractFromFile, ReadWriteFile } from './nodes/files';
import { Form, FormTrigger } from './nodes/form';
import { EmailReadImap } from './nodes/imap';
import { LocalFileTrigger } from './nodes/local-file-trigger';
import { Ftp, Ssh } from './nodes/remote-files';
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
  Form,
  EmailReadImap,
  LocalFileTrigger,
  Ssh,
  Ftp,
  AiAgent,
  ChatTrigger,
  AnthropicChatModel,
  OpenAiChatModel,
  OllamaChatModel,
  GeminiChatModel,
  PostgresChatMemory,
  RedisChatMemory,
  McpClientTool,
  McpServerTrigger,
  ...ragNodes,
  ...moreVectorStores,
  ...chainNodes,
  ...modelNodes,
  ...toolNodes,
  ...evaluationNodes,
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

export const credentials: ICredentialType[] = [...credentialTypes, ...aiCredentials, ...modelCredentials, ...vectorStoreCredentials, ...integrationCredentials];

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
export { characterSplitter, cosineSimilarity, recursiveSplitter, tokenSplitter, type AiDocument } from './ai/rag';
export { askJson, schemaFromAttributes, summarize } from './ai/chains';
export { bedrockModel } from './ai/models';
export { serpSummary } from './ai/tools';
export { mongoUri } from './ai/vector-stores';
export { signAws } from './utils/aws';
export { collectMetrics, EVALUATION_NODE, EVALUATION_TRIGGER, evaluationDataset, levenshtein, stringSimilarity, toolsUsedScore } from './nodes/evaluation';

export { ruleToCron } from './nodes/schedule';
export { formPageOf, renderForm, renderPage, renderSubmitted, parseSubmission, type FormField, type FormNodePage } from './nodes/form';
export { imapSearchQuery } from './nodes/imap';
export { buildIcs, parseIcs } from './nodes/ical';
export { Sftp, sshConnect } from './nodes/remote-files';

export * from './utils/filter';
export * from './utils/object';
