import type { ICredentialType, IDataObject, ILoadOptionsFunctions, INodeProperties, INodeType, ISupplyDataFunctions } from '@8n8/workflow';
import { signAws, type AwsCredentials } from '../utils/aws';
import { openAiModel, type ChatModel, type ModelTurn, type OpenAiOptions } from './llm';
import { subNode } from './subnodes';

const password = { password: true };

const modelOptions = (maxTokensDefault = 0): INodeProperties => ({
  displayName: 'Options',
  name: 'options',
  type: 'collection',
  default: {},
  options: [
    { displayName: 'Maximum Tokens', name: 'maxTokens', type: 'number', default: maxTokensDefault, description: '0 = provider default' },
    { displayName: 'Sampling Temperature', name: 'temperature', type: 'number', typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 }, default: 0.7 },
  ],
});

const optionsOf = (ctx: ISupplyDataFunctions, i: number) => {
  const o = ctx.getNodeParameter('options', i, {}) as IDataObject;
  return { maxTokens: Number(o.maxTokens) || undefined, temperature: o.temperature === undefined ? undefined : Number(o.temperature) };
};

/* ---------------- OpenAI-compatible providers ---------------- */

interface CompatibleSpec {
  name: string;
  displayName: string;
  description: string;
  credential: string;
  defaultUrl: string;
  defaultModel: string;
  maxTokensField?: OpenAiOptions['maxTokensField'];
  extraBody?: Record<string, unknown>;
  /** Some providers list embedding/audio models too */
  modelFilter?: (id: string) => boolean;
}

function compatibleModel(spec: CompatibleSpec): INodeType {
  const base = (c: { url?: string }) => (c.url || spec.defaultUrl).replace(/\/$/, '');
  return {
    description: {
      ...subNode(spec.name, spec.displayName, spec.description, 'ai_languageModel', 'fa:robot'),
      credentials: [{ name: spec.credential, required: true }],
      properties: [
        { displayName: 'Model', name: 'model', type: 'options', default: spec.defaultModel, required: true, typeOptions: { loadOptionsMethod: 'listModels' } },
        modelOptions(),
      ],
    },
    methods: {
      loadOptions: {
        async listModels(this: ILoadOptionsFunctions) {
          const c = await this.getCredentials<{ apiKey: string; url?: string }>(spec.credential);
          const res = (await this.helpers.httpRequest({ url: `${base(c)}/models`, headers: { authorization: `Bearer ${c.apiKey}` }, json: true })) as { data: Array<{ id: string; name?: string }> };
          return res.data
            .filter((m) => !spec.modelFilter || spec.modelFilter(m.id))
            .map((m) => ({ name: m.name ?? m.id, value: m.id }))
            .sort((a, b) => a.name.localeCompare(b.name));
        },
      },
    },
    async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
      const c = await this.getCredentials<{ apiKey: string; url?: string }>(spec.credential);
      const model = this.getNodeParameter('model', itemIndex) as string;
      if (!model) throw new Error(`Select a model in the ${spec.displayName} node`);
      return {
        response: openAiModel({ apiKey: c.apiKey, baseURL: base(c), model, maxTokensField: spec.maxTokensField, extraBody: spec.extraBody, ...optionsOf(this, itemIndex), signal: this.getExecutionCancelSignal() }),
      };
    },
  };
}

export const MistralChatModel = compatibleModel({
  name: 'lmChatMistralCloud',
  displayName: 'Mistral Cloud Chat Model',
  description: 'Mistral AI models for AI Agent and chains',
  credential: 'mistralCloudApi',
  defaultUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'mistral-small-latest',
  maxTokensField: 'max_tokens',
  modelFilter: (id) => !/embed|moderation|ocr/.test(id),
});

export const GroqChatModel = compatibleModel({
  name: 'lmChatGroq',
  displayName: 'Groq Chat Model',
  description: 'Fast open models served by Groq',
  credential: 'groqApi',
  defaultUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
  modelFilter: (id) => !/whisper|tts|guard/.test(id),
});

export const DeepSeekChatModel = compatibleModel({
  name: 'lmChatDeepSeek',
  displayName: 'DeepSeek Chat Model',
  description: 'DeepSeek models for AI Agent and chains',
  credential: 'deepSeekApi',
  defaultUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-chat',
  maxTokensField: 'max_tokens',
});

export const OpenRouterChatModel = compatibleModel({
  name: 'lmChatOpenRouter',
  displayName: 'OpenRouter Chat Model',
  description: 'Hundreds of models from many providers through OpenRouter',
  credential: 'openRouterApi',
  defaultUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'openai/gpt-4.1-mini',
  maxTokensField: 'max_tokens',
});

export const XAiGrokChatModel = compatibleModel({
  name: 'lmChatXAiGrok',
  displayName: 'xAI Grok Chat Model',
  description: 'Grok models from xAI',
  credential: 'xAiApi',
  defaultUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-3-mini',
  modelFilter: (id) => !/image|imagine/.test(id),
});

/* ---------------- Azure OpenAI ---------------- */

interface AzureCreds {
  apiKey: string;
  resourceName?: string;
  apiVersion?: string;
  endpoint?: string;
}

const azureBase = (c: AzureCreds) => (c.endpoint || `https://${c.resourceName}.openai.azure.com`).replace(/\/$/, '');

export const AzureOpenAiChatModel: INodeType = {
  description: {
    ...subNode('lmChatAzureOpenAi', 'Azure OpenAI Chat Model', 'OpenAI models deployed in your Azure resource', 'ai_languageModel', 'fa:robot'),
    credentials: [{ name: 'azureOpenAiApi', required: true }],
    properties: [
      { displayName: 'Model (Deployment) Name', name: 'model', type: 'string', default: '', required: true, placeholder: 'gpt-4o-prod', description: 'The name of the deployment in Azure AI Foundry' },
      modelOptions(),
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<AzureCreds>('azureOpenAiApi');
    if (!c.endpoint && !c.resourceName) throw new Error('Set the resource name or the endpoint in the Azure OpenAI credential');
    const deployment = String(this.getNodeParameter('model', itemIndex) ?? '').trim();
    if (!deployment) throw new Error('Set the deployment name in the Azure OpenAI Chat Model node');
    const url = `${azureBase(c)}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(c.apiVersion || '2025-03-01-preview')}`;
    return {
      response: openAiModel({ apiKey: c.apiKey, baseURL: azureBase(c), url, headers: { 'api-key': c.apiKey }, model: deployment, ...optionsOf(this, itemIndex), signal: this.getExecutionCancelSignal() }),
    };
  },
};

/* ---------------- AWS Bedrock (Converse API) ---------------- */

interface AwsCreds extends AwsCredentials {
  region: string;
}

type BedrockBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }>; status?: 'success' | 'error' } }
  | Record<string, unknown>;
interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockBlock[];
}

async function awsJson<T>(creds: AwsCreds, service: string, method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = signAws({ method, url, body: payload, headers: { 'content-type': 'application/json', accept: 'application/json' } }, creds, creds.region, service);
  const res = await fetch(url, { method, headers, body: payload, signal });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T & { message?: string; Message?: string }) : ({} as T & { message?: string });
  if (!res.ok) throw new Error(`Bedrock: ${res.status} ${json.message ?? (json as { Message?: string }).Message ?? res.statusText}`);
  return json;
}

export function bedrockModel(o: { creds: AwsCreds; model: string; maxTokens?: number; temperature?: number; signal?: AbortSignal }): ChatModel {
  const url = `https://bedrock-runtime.${o.creds.region}.amazonaws.com/model/${encodeURIComponent(o.model)}/converse`;
  return {
    provider: 'bedrock',
    model: o.model,
    createSession({ system, history, tools }) {
      const messages: BedrockMessage[] = [];
      for (const m of history ?? []) {
        if (!messages.length && m.role !== 'user') continue;
        const last = messages.at(-1);
        if (last?.role === m.role) last.content.push({ text: m.text });
        else messages.push({ role: m.role, content: [{ text: m.text }] });
      }
      const toolConfig = tools.length ? { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema } } })) } : undefined;
      const call = async (): Promise<ModelTurn> => {
        const res = await awsJson<{
          output: { message: BedrockMessage };
          stopReason: string;
          usage?: { inputTokens: number; outputTokens: number };
        }>(
          o.creds,
          'bedrock',
          'POST',
          url,
          {
            messages,
            ...(system ? { system: [{ text: system }] } : {}),
            ...(toolConfig ? { toolConfig } : {}),
            inferenceConfig: { ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}), ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) },
          },
          o.signal,
        );
        // reasoning blocks go back unchanged with the rest of the turn
        messages.push(res.output.message);
        const content = res.output.message.content;
        const toolCalls = content
          .filter((b): b is { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } } => 'toolUse' in b)
          .map((b) => ({ id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input ?? {} }));
        return {
          text: content.filter((b): b is { text: string } => typeof (b as { text?: unknown }).text === 'string').map((b) => b.text).join(''),
          toolCalls,
          done: res.stopReason !== 'tool_use',
          stopReason: res.stopReason,
          usage: { inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0 },
        };
      };
      return {
        async sendUser(text) {
          messages.push({ role: 'user', content: [{ text }] });
          return call();
        },
        async sendToolResults(results) {
          messages.push({ role: 'user', content: results.map((r) => ({ toolResult: { toolUseId: r.id, content: [{ text: r.content }], ...(r.isError ? { status: 'error' as const } : {}) } })) });
          return call();
        },
      };
    },
  };
}

export const BedrockChatModel: INodeType = {
  description: {
    ...subNode('lmChatAwsBedrock', 'AWS Bedrock Chat Model', 'Claude, Llama, Mistral, Nova and other models on AWS Bedrock', 'ai_languageModel', 'fa:aws'),
    credentials: [{ name: 'aws', required: true }],
    properties: [
      {
        displayName: 'Model Source',
        name: 'modelSource',
        type: 'options',
        default: 'onDemand',
        options: [
          { name: 'On-Demand Models', value: 'onDemand' },
          { name: 'Inference Profiles', value: 'inferenceProfile', description: 'Cross-region profiles, needed by newer models' },
        ],
      },
      { displayName: 'Model', name: 'model', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'listModels', loadOptionsDependsOn: ['modelSource'] } },
      modelOptions(2000),
    ],
  },
  methods: {
    loadOptions: {
      async listModels(this: ILoadOptionsFunctions) {
        const c = await this.getCredentials<AwsCreds>('aws');
        const base = `https://bedrock.${c.region}.amazonaws.com`;
        if (this.getCurrentNodeParameters().modelSource === 'inferenceProfile') {
          const res = await awsJson<{ inferenceProfileSummaries: Array<{ inferenceProfileId: string; inferenceProfileName: string }> }>(c, 'bedrock', 'GET', `${base}/inference-profiles?maxResults=1000`);
          return res.inferenceProfileSummaries.map((p) => ({ name: p.inferenceProfileName, value: p.inferenceProfileId })).sort((a, b) => a.name.localeCompare(b.name));
        }
        const res = await awsJson<{ modelSummaries: Array<{ modelId: string; modelName: string; providerName: string; inferenceTypesSupported?: string[] }> }>(
          c,
          'bedrock',
          'GET',
          `${base}/foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND`,
        );
        return res.modelSummaries.map((m) => ({ name: `${m.providerName} ${m.modelName}`, value: m.modelId })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const creds = await this.getCredentials<AwsCreds>('aws');
    const model = this.getNodeParameter('model', itemIndex) as string;
    if (!model) throw new Error('Select a model in the AWS Bedrock Chat Model node');
    return { response: bedrockModel({ creds, model, ...optionsOf(this, itemIndex), signal: this.getExecutionCancelSignal() }) };
  },
};

/* ---------------- credentials ---------------- */

const keyAndUrl = (name: string, displayName: string, url: string, docs?: string): ICredentialType => ({
  name,
  displayName,
  ...(docs ? { documentationUrl: docs } : {}),
  properties: [
    { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: password, default: '' },
    { displayName: 'Base URL', name: 'url', type: 'string', default: url },
  ],
  test: { request: { url: `={{$credentials.url || "${url}"}}/models`, headers: { authorization: '=Bearer {{$credentials.apiKey}}' } } },
});

export const modelCredentials: ICredentialType[] = [
  keyAndUrl('mistralCloudApi', 'Mistral Cloud', 'https://api.mistral.ai/v1', 'https://console.mistral.ai/api-keys'),
  keyAndUrl('groqApi', 'Groq', 'https://api.groq.com/openai/v1', 'https://console.groq.com/keys'),
  keyAndUrl('deepSeekApi', 'DeepSeek', 'https://api.deepseek.com', 'https://platform.deepseek.com/api_keys'),
  keyAndUrl('openRouterApi', 'OpenRouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/keys'),
  keyAndUrl('xAiApi', 'xAI', 'https://api.x.ai/v1', 'https://console.x.ai'),
  {
    name: 'azureOpenAiApi',
    displayName: 'Azure OpenAI',
    properties: [
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: password, default: '' },
      { displayName: 'Resource Name', name: 'resourceName', type: 'string', default: '', description: 'The part before .openai.azure.com' },
      { displayName: 'API Version', name: 'apiVersion', type: 'string', default: '2025-03-01-preview' },
      { displayName: 'Endpoint', name: 'endpoint', type: 'string', default: '', placeholder: 'https://my-resource.openai.azure.com', description: 'Only when it is not https://<resource name>.openai.azure.com' },
    ],
  },
  {
    name: 'aws',
    displayName: 'AWS',
    properties: [
      { displayName: 'Region', name: 'region', type: 'string', default: 'us-east-1' },
      { displayName: 'Access Key ID', name: 'accessKeyId', type: 'string', default: '' },
      { displayName: 'Secret Access Key', name: 'secretAccessKey', type: 'string', typeOptions: password, default: '' },
      { displayName: 'Session Token', name: 'sessionToken', type: 'string', typeOptions: password, default: '', description: 'Only for temporary credentials' },
    ],
  },
  { name: 'serpApi', displayName: 'SerpApi', documentationUrl: 'https://serpapi.com/manage-api-key', properties: [{ displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: password, default: '' }] },
];

export const modelNodes: INodeType[] = [MistralChatModel, GroqChatModel, DeepSeekChatModel, OpenRouterChatModel, XAiGrokChatModel, AzureOpenAiChatModel, BedrockChatModel];
