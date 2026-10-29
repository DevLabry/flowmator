import { CredentialTypesRegistry, NodeTypesRegistry, normalizeNodeTypeName } from '@8n8/core';
import { credentials as builtinCredentials, nodes as builtinNodes } from '@8n8/nodes-base';
import type { IWorkflowBase } from '@8n8/workflow';
import { ActiveWorkflows } from './active-workflows';
import { loadConfig, type ServerConfig } from './config';
import { Cipher, CredentialsHelper, CredentialsService } from './credentials';
import { Database } from './db';
import { ExecutionService } from './execution-service';
import { Push } from './push';
import { WebhookService } from './webhooks';

export interface AppContext {
  config: ServerConfig;
  db: Database;
  push: Push;
  nodeTypes: NodeTypesRegistry;
  credentialTypes: CredentialTypesRegistry;
  credentials: CredentialsService;
  credentialsHelper: CredentialsHelper;
  executions: ExecutionService;
  webhooks: WebhookService;
  activeWorkflows: ActiveWorkflows;
}

/** Converts node types from n8n exports (n8n-nodes-base.x) to 8n8 names so stored workflows are consistent. */
export function normalizeWorkflow<T extends Partial<IWorkflowBase>>(wf: T): T {
  if (!wf.nodes) return wf;
  return { ...wf, nodes: wf.nodes.map((n) => ({ ...n, type: normalizeNodeTypeName(n.type) })) };
}

export function createContext(overrides: Partial<ServerConfig> = {}): AppContext {
  const config = loadConfig(overrides);
  const db = new Database(config.dbFile);
  const push = new Push();
  const nodeTypes = new NodeTypesRegistry();
  nodeTypes.registerAll(builtinNodes);
  const credentialTypes = new CredentialTypesRegistry();
  credentialTypes.registerAll(builtinCredentials);
  const credentials = new CredentialsService(db, new Cipher(config.encryptionKey), credentialTypes);
  const credentialsHelper = new CredentialsHelper(credentials);
  const executions = new ExecutionService(config, db, push, nodeTypes, credentialsHelper);
  const webhooks = new WebhookService(config, nodeTypes, executions, push, (id) => db.getWorkflow(id));
  const activeWorkflows = new ActiveWorkflows(config, db, nodeTypes, executions, webhooks, push);
  return { config, db, push, nodeTypes, credentialTypes, credentials, credentialsHelper, executions, webhooks, activeWorkflows };
}
