import { createSign } from 'node:crypto';
import type { ICredentialType, IDataObject, IHelpers, ILoadOptionsFunctions, INodeProperties, INodeType, ISupplyDataFunctions } from '@flowmator/workflow';
import { signAws, type AwsCredentials } from '../utils/aws';
import { geminiModel, openAiModel, type ChatModel, type ModelTurn, type OpenAiOptions } from './llm';
import { embeddingsOf, inBatches } from './rag';
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
  /** The OpenAI-compatible base URL, when it is not the credential's URL */
  base?: (c: { url?: string }) => string;
  /** Providers whose model list is not OpenAI's /models */
  listModels?: (helpers: IHelpers, c: { apiKey: string; url?: string }) => Promise<Array<{ name: string; value: string }>>;
}

function compatibleModel(spec: CompatibleSpec): INodeType {
  const base = spec.base ?? ((c: { url?: string }) => (c.url || spec.defaultUrl).replace(/\/$/, ''));
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
          if (spec.listModels) return spec.listModels(this.helpers, c);
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

/* ---------------- Cohere ---------------- */

interface CohereCreds {
  apiKey: string;
  url?: string;
}
const cohereUrl = (c: CohereCreds) => (c.url || 'https://api.cohere.ai').replace(/\/$/, '');

export const CohereChatModel = compatibleModel({
  name: 'lmChatCohere',
  displayName: 'Cohere Chat Model',
  description: 'Cohere Command models for AI Agent and chains',
  credential: 'cohereApi',
  defaultUrl: 'https://api.cohere.ai',
  defaultModel: 'command-a-03-2025',
  maxTokensField: 'max_tokens',
  // Cohere's OpenAI-compatible endpoint
  base: (c) => `${cohereUrl(c as CohereCreds)}/compatibility/v1`,
  async listModels(helpers, c) {
    const res = (await helpers.httpRequest({ url: `${cohereUrl(c)}/v1/models`, qs: { endpoint: 'chat', page_size: 1000 }, headers: { authorization: `Bearer ${c.apiKey}` }, json: true })) as { models: Array<{ name: string }> };
    return res.models.map((m) => ({ name: m.name, value: m.name })).sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const EmbeddingsCohere: INodeType = {
  description: {
    ...subNode('embeddingsCohere', 'Embeddings Cohere', 'Turns text into vectors with Cohere', 'ai_embedding', 'fa:vector-square'),
    credentials: [{ name: 'cohereApi', required: true }],
    properties: [
      {
        displayName: 'Model',
        name: 'modelName',
        type: 'options',
        default: 'embed-english-v3.0',
        options: ['embed-v4.0', 'embed-english-v3.0', 'embed-english-light-v3.0', 'embed-multilingual-v3.0', 'embed-multilingual-light-v3.0'].map((m) => ({ name: m, value: m })),
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<CohereCreds>('cohereApi');
    const model = this.getNodeParameter('modelName', itemIndex) as string;
    const http = this.helpers;
    // Cohere embeds stored documents and search queries differently
    const embed = (inputType: string) => (texts: string[]) =>
      inBatches(texts, 96, async (batch) => {
        const res = (await http.httpRequest({
          method: 'POST',
          url: `${cohereUrl(c)}/v2/embed`,
          headers: { authorization: `Bearer ${c.apiKey}` },
          body: { model, texts: batch, input_type: inputType, embedding_types: ['float'] },
          json: true,
        })) as { embeddings: { float: number[][] } };
        return res.embeddings.float;
      });
    const documents = embeddingsOf(embed('search_document'));
    return { response: { embedDocuments: documents.embedDocuments, embedQuery: async (text: string) => (await embed('search_query')([text]))[0] } };
  },
};

/* ---------------- Hugging Face ---------------- */

export const HuggingFaceChatModel = compatibleModel({
  name: 'lmOpenHuggingFaceInference',
  displayName: 'Hugging Face Inference Model',
  description: 'Open models served by Hugging Face Inference Providers',
  credential: 'huggingFaceApi',
  defaultUrl: 'https://router.huggingface.co/v1',
  defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
  maxTokensField: 'max_tokens',
});

/** Mean of token vectors, for feature-extraction models that answer one vector per token. */
const pooled = (v: number[] | number[][]): number[] => {
  if (!Array.isArray(v[0])) return v as number[];
  const rows = v as number[][];
  return rows[0].map((_, i) => rows.reduce((sum, r) => sum + r[i], 0) / rows.length);
};

export const EmbeddingsHuggingFace: INodeType = {
  description: {
    ...subNode('embeddingsHuggingFaceInference', 'Embeddings Hugging Face Inference', 'Turns text into vectors with a Hugging Face model', 'ai_embedding', 'fa:vector-square'),
    credentials: [{ name: 'huggingFaceApi', required: true }],
    properties: [
      { displayName: 'Model', name: 'modelName', type: 'string', default: 'sentence-transformers/all-MiniLM-L6-v2' },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [{ displayName: 'Custom Inference Endpoint', name: 'endpointUrl', type: 'string', default: '', description: 'A dedicated Inference Endpoint URL instead of the shared one' }],
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const { apiKey } = await this.getCredentials<{ apiKey: string }>('huggingFaceApi');
    const model = String(this.getNodeParameter('modelName', itemIndex)).trim();
    const o = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
    const url = String(o.endpointUrl || `https://router.huggingface.co/hf-inference/models/${model}/pipeline/feature-extraction`);
    const http = this.helpers;
    return {
      response: embeddingsOf((texts) =>
        inBatches(texts, 32, async (batch) => {
          const res = (await http.httpRequest({ method: 'POST', url, headers: { authorization: `Bearer ${apiKey}` }, body: { inputs: batch }, json: true })) as Array<number[] | number[][]>;
          return res.map(pooled);
        }),
      ),
    };
  },
};

/* ---------------- Google Vertex AI ---------------- */

interface GoogleServiceAccount {
  email: string;
  privateKey: string;
  region?: string;
}

const vertexTokens = new Map<string, { token: string; expires: number }>();

/** Service account → access token for Vertex AI (cloud-platform scope, whatever scopes the credential lists for other nodes). */
async function vertexToken(helpers: IHelpers, c: GoogleServiceAccount) {
  let cached = vertexTokens.get(c.email);
  if (!cached || cached.expires < Date.now() + 60_000) {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: c.email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(String(c.privateKey).replace(/\\n/g, '\n'), 'base64url');
    const res = (await helpers.httpRequest({
      method: 'POST',
      url: 'https://oauth2.googleapis.com/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString(),
      json: true,
    })) as { access_token: string; expires_in: number };
    cached = { token: res.access_token, expires: Date.now() + res.expires_in * 1000 };
    vertexTokens.set(c.email, cached);
  }
  return cached.token;
}

/** The project in the service account's address (name@PROJECT.iam.gserviceaccount.com) unless the node names one. */
function vertexModelUrl(c: GoogleServiceAccount, project: string, model: string, method: string) {
  const region = c.region || 'us-central1';
  const projectId = project || c.email.match(/@([^.]+)\.iam\.gserviceaccount\.com$/)?.[1];
  if (!projectId) throw new Error('Set the Google Cloud project ID in the Vertex node');
  const host = region === 'global' ? 'aiplatform.googleapis.com' : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(projectId)}/locations/${region}/publishers/google/models/${encodeURIComponent(model)}:${method}`;
}

const projectProp: INodeProperties = { displayName: 'Project ID', name: 'projectId', type: 'string', default: '', description: "Defaults to the service account's project" };

export const VertexChatModel: INodeType = {
  description: {
    ...subNode('lmChatGoogleVertex', 'Google Vertex Chat Model', 'Gemini models on Google Cloud Vertex AI', 'ai_languageModel', 'fa:robot'),
    credentials: [{ name: 'googleApi', required: true }],
    properties: [projectProp, { displayName: 'Model Name', name: 'modelName', type: 'string', default: 'gemini-2.5-flash', required: true }, modelOptions(2048)],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<GoogleServiceAccount>('googleApi');
    const model = String(this.getNodeParameter('modelName', itemIndex) ?? '').trim();
    if (!model) throw new Error('Set the model name in the Google Vertex Chat Model node');
    const url = vertexModelUrl(c, String(this.getNodeParameter('projectId', itemIndex, '') ?? '').trim(), model, 'generateContent');
    const helpers = this.helpers;
    return {
      response: {
        ...geminiModel({ apiKey: '', host: '', url, model, auth: async () => ({ authorization: `Bearer ${await vertexToken(helpers, c)}` }), ...optionsOf(this, itemIndex), signal: this.getExecutionCancelSignal() }),
        provider: 'vertex',
      },
    };
  },
};

export const EmbeddingsVertex: INodeType = {
  description: {
    ...subNode('embeddingsGoogleVertex', 'Embeddings Google Vertex', 'Turns text into vectors with Vertex AI', 'ai_embedding', 'fa:vector-square'),
    credentials: [{ name: 'googleApi', required: true }],
    properties: [projectProp, { displayName: 'Model Name', name: 'modelName', type: 'string', default: 'text-embedding-005' }],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<GoogleServiceAccount>('googleApi');
    const url = vertexModelUrl(c, String(this.getNodeParameter('projectId', itemIndex, '') ?? '').trim(), String(this.getNodeParameter('modelName', itemIndex)).trim(), 'predict');
    const http = this.helpers;
    return {
      response: embeddingsOf((texts) =>
        inBatches(texts, 16, async (batch) => {
          const res = (await http.httpRequest({ method: 'POST', url, headers: { authorization: `Bearer ${await vertexToken(http, c)}` }, body: { instances: batch.map((content) => ({ content })) }, json: true })) as {
            predictions: Array<{ embeddings: { values: number[] } }>;
          };
          return res.predictions.map((p) => p.embeddings.values);
        }),
      ),
    };
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
  {
    name: 'cohereApi',
    displayName: 'Cohere',
    documentationUrl: 'https://dashboard.cohere.com/api-keys',
    properties: [
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: password, default: '' },
      { displayName: 'Base URL', name: 'url', type: 'string', default: 'https://api.cohere.ai' },
    ],
    test: { request: { url: '={{$credentials.url || "https://api.cohere.ai"}}/v1/models', headers: { authorization: '=Bearer {{$credentials.apiKey}}' } } },
  },
  {
    name: 'huggingFaceApi',
    displayName: 'Hugging Face',
    documentationUrl: 'https://huggingface.co/settings/tokens',
    properties: [
      { displayName: 'Access Token', name: 'apiKey', type: 'string', typeOptions: password, default: '' },
      { displayName: 'Base URL', name: 'url', type: 'string', default: 'https://router.huggingface.co/v1', description: 'OpenAI-compatible endpoint for chat models' },
    ],
    test: { request: { url: 'https://huggingface.co/api/whoami-v2', headers: { authorization: '=Bearer {{$credentials.apiKey}}' } } },
  },
  { name: 'serpApi', displayName: 'SerpApi', documentationUrl: 'https://serpapi.com/manage-api-key', properties: [{ displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: password, default: '' }] },
];

export const modelNodes: INodeType[] = [
  MistralChatModel,
  GroqChatModel,
  DeepSeekChatModel,
  OpenRouterChatModel,
  XAiGrokChatModel,
  AzureOpenAiChatModel,
  BedrockChatModel,
  CohereChatModel,
  EmbeddingsCohere,
  HuggingFaceChatModel,
  EmbeddingsHuggingFace,
  VertexChatModel,
  EmbeddingsVertex,
];
