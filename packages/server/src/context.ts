import { CredentialTypesRegistry, NodeTypesRegistry, normalizeNodeTypeName } from '@8n8/core';
import { credentials as builtinCredentials, nodes as builtinNodes } from '@8n8/nodes-base';
import type { IWorkflowBase } from '@8n8/workflow';
import { ActiveWorkflows } from './active-workflows';
import { loadConfig, type ConfigOverrides, type ServerConfig } from './config';
import { Cipher, CredentialsHelper, CredentialsService } from './credentials';
import { DataTableService } from './data-tables';
import { Database } from './db';
import { EvaluationService } from './evaluations';
import { ExecutionService, type ProcessRole } from './execution-service';
import { Push, type PushSender } from './push';
import { ScalingService } from './scaling';
import { WebhookService } from './webhooks';

export interface AppContext {
  role: ProcessRole;
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
  dataTables: DataTableService;
  evaluations: EvaluationService;
  /** Queue mode only */
  scaling?: ScalingService;
}

/** Converts node types from n8n exports (n8n-nodes-base.x) to 8n8 names so stored workflows are consistent. */
export function normalizeWorkflow<T extends Partial<IWorkflowBase>>(wf: T): T {
  if (!wf.nodes) return wf;
  return { ...wf, nodes: wf.nodes.map((n) => ({ ...n, type: normalizeNodeTypeName(n.type) })) };
}

export function createContext(overrides: ConfigOverrides = {}, role: ProcessRole = 'main'): AppContext {
  const config = loadConfig(overrides);
  const db = new Database(config.dbFile);
  const scaling = config.executions.mode === 'queue' ? new ScalingService(config) : undefined;
  const push = new Push();
  // workers and webhook processes have no editors connected: their events go to main through Redis
  const events: PushSender = scaling && role !== 'main' ? { send: (event, pushRef) => void scaling.publish({ type: 'push', event, pushRef }) } : push;
  const nodeTypes = new NodeTypesRegistry();
  nodeTypes.registerAll(builtinNodes);
  const credentialTypes = new CredentialTypesRegistry();
  credentialTypes.registerAll(builtinCredentials);
  const credentials = new CredentialsService(db, new Cipher(config.encryptionKey), credentialTypes);
  const credentialsHelper = new CredentialsHelper(credentials);
  const executions = new ExecutionService(config, db, events, nodeTypes, credentialsHelper, role, scaling);
  const dataTables = new DataTableService(db);
  executions.dataTables = dataTables;
  const evaluations = new EvaluationService(db, executions, dataTables, role === 'main');
  const webhooks = new WebhookService(config, nodeTypes, executions, events, (id) => db.getWorkflow(id));
  const activeWorkflows = new ActiveWorkflows(config, db, nodeTypes, executions, webhooks, events);
  // webhook processes serve production webhooks too, so they must hear about (de)activations
  if (scaling && role === 'main') activeWorkflows.onChange = (workflowId, active) => void scaling.publish({ type: 'workflowChanged', workflowId, active });
  return { role, config, db, push, nodeTypes, credentialTypes, credentials, credentialsHelper, executions, webhooks, activeWorkflows, dataTables, evaluations, scaling };
}
