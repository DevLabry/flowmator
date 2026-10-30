import { randomUUID } from 'node:crypto';
import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeInputConfiguration,
  type INodeProperties,
  type INodeType,
  type ISupplyDataFunctions,
  type ConnectionType,
} from '@8n8/workflow';
import { errorItem } from '../utils/object';
import { pgPool, type PgCreds } from '../nodes/integrations/postgres';
import { toToolName, type ChatModel, type ToolSpec } from './llm';
import { geminiHost, subNode, type OutputParser } from './subnodes';

/* ---------------- shared shapes ---------------- */

export interface AiDocument {
  pageContent: string;
  metadata: IDataObject;
}

export interface Embeddings {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export interface TextSplitter {
  splitText(text: string): string[];
}

/** Turns one input item into documents (already split into chunks). */
export interface DocumentLoader {
  loadItem(item: INodeExecutionData, itemIndex: number): Promise<AiDocument[]>;
}

export interface VectorStore {
  addDocuments(docs: AiDocument[]): Promise<void>;
  similaritySearch(query: string, k: number, filter?: IDataObject): Promise<Array<[AiDocument, number]>>;
}

export interface Retriever {
  retrieve(query: string): Promise<AiDocument[]>;
}

const asJson = (raw: unknown) => (typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : (raw ?? {}));

/** Sends one prompt to a chat model and returns its text answer. */
async function ask(model: ChatModel, system: string | undefined, prompt: string) {
  const turn = await model.createSession({ system, tools: [] }).sendUser(prompt);
  return turn.text;
}

/* ---------------- embeddings ---------------- */

async function inBatches<T>(texts: string[], size: number, embed: (batch: string[]) => Promise<T[]>) {
  const out: T[] = [];
  for (let i = 0; i < texts.length; i += size) out.push(...(await embed(texts.slice(i, i + size))));
  return out;
}

const embeddingsOf = (embedDocuments: (texts: string[]) => Promise<number[][]>): Embeddings => ({
  embedDocuments: (texts) => (texts.length ? embedDocuments(texts) : Promise.resolve([])),
  embedQuery: async (text) => (await embedDocuments([text]))[0],
});

export const EmbeddingsOpenAi: INodeType = {
  description: {
    ...subNode('embeddingsOpenAi', 'Embeddings OpenAI', 'Turns text into vectors with OpenAI (or a compatible API)', 'ai_embedding', 'fa:vector-square'),
    credentials: [{ name: 'openAiApi', required: true }],
    properties: [
      { displayName: 'Model', name: 'model', type: 'options', default: 'text-embedding-3-small', options: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'].map((m) => ({ name: m, value: m })) },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Dimensions', name: 'dimensions', type: 'number', default: 0, description: '0 = model default. Only the text-embedding-3 models accept other sizes.' },
          { displayName: 'Batch Size', name: 'batchSize', type: 'number', default: 512, description: 'Texts sent per request' },
        ],
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<{ apiKey: string; url?: string; organizationId?: string }>('openAiApi');
    const model = this.getNodeParameter('model', itemIndex) as string;
    const o = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
    const url = `${(c.url || 'https://api.openai.com/v1').replace(/\/$/, '')}/embeddings`;
    const http = this.helpers;
    return {
      response: embeddingsOf((texts) =>
        inBatches(texts, Number(o.batchSize) || 512, async (batch) => {
          const res = (await http.httpRequest({
            method: 'POST',
            url,
            headers: { authorization: `Bearer ${c.apiKey}`, ...(c.organizationId ? { 'openai-organization': c.organizationId } : {}) },
            body: { model, input: batch, ...(Number(o.dimensions) ? { dimensions: Number(o.dimensions) } : {}) },
            json: true,
          })) as { data: Array<{ index: number; embedding: number[] }> };
          return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
        }),
      ),
    };
  },
};

export const EmbeddingsOllama: INodeType = {
  description: {
    ...subNode('embeddingsOllama', 'Embeddings Ollama', 'Turns text into vectors with a local Ollama model', 'ai_embedding', 'fa:vector-square'),
    credentials: [{ name: 'ollamaApi', required: true }],
    properties: [{ displayName: 'Model', name: 'model', type: 'string', default: 'nomic-embed-text', description: 'Pull it first: ollama pull nomic-embed-text' }],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<{ baseUrl: string; apiKey?: string }>('ollamaApi');
    const model = this.getNodeParameter('model', itemIndex) as string;
    const http = this.helpers;
    return {
      response: embeddingsOf((texts) =>
        inBatches(texts, 64, async (batch) => {
          const res = (await http.httpRequest({
            method: 'POST',
            url: `${c.baseUrl.replace(/\/$/, '')}/api/embed`,
            headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {},
            body: { model, input: batch },
            json: true,
          })) as { embeddings: number[][] };
          return res.embeddings;
        }),
      ),
    };
  },
};

export const EmbeddingsGemini: INodeType = {
  description: {
    ...subNode('embeddingsGoogleGemini', 'Embeddings Google Gemini', 'Turns text into vectors with Gemini', 'ai_embedding', 'fa:vector-square'),
    credentials: [{ name: 'googlePalmApi', required: true }],
    properties: [{ displayName: 'Model', name: 'modelName', type: 'string', default: 'models/gemini-embedding-001' }],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const c = await this.getCredentials<{ host?: string; apiKey: string }>('googlePalmApi');
    const model = `models/${String(this.getNodeParameter('modelName', itemIndex)).replace(/^models\//, '')}`;
    const http = this.helpers;
    return {
      response: embeddingsOf((texts) =>
        inBatches(texts, 100, async (batch) => {
          const res = (await http.httpRequest({
            method: 'POST',
            url: `${geminiHost(c)}/v1beta/${model}:batchEmbedContents`,
            headers: { 'x-goog-api-key': c.apiKey },
            body: { requests: batch.map((text) => ({ model, content: { parts: [{ text }] } })) },
            json: true,
          })) as { embeddings: Array<{ values: number[] }> };
          return res.embeddings.map((e) => e.values);
        }),
      ),
    };
  },
};

/* ---------------- text splitters ---------------- */

/** Joins small pieces into chunks of at most `size` characters, repeating up to `overlap` characters between chunks. */
function mergeSplits(splits: string[], separator: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  const current: string[] = [];
  let total = 0;
  const sep = (n: number) => (n > 0 ? separator.length : 0);
  for (const piece of splits) {
    if (current.length && total + piece.length + sep(current.length) > size) {
      const chunk = current.join(separator).trim();
      if (chunk) chunks.push(chunk);
      // drop pieces from the front until what is left fits as overlap
      while (total > overlap || (total > 0 && total + piece.length + sep(current.length) > size)) {
        total -= current[0].length + sep(current.length - 1);
        current.shift();
      }
    }
    current.push(piece);
    total += piece.length + sep(current.length - 1);
  }
  const last = current.join(separator).trim();
  if (last) chunks.push(last);
  return chunks;
}

export function recursiveSplitter(chunkSize = 1000, chunkOverlap = 200, separators = ['\n\n', '\n', ' ', '']): TextSplitter {
  if (chunkOverlap >= chunkSize) throw new Error('Chunk Overlap must be smaller than Chunk Size');
  const split = (text: string, seps: string[]): string[] => {
    const idx = seps.findIndex((s) => s === '' || text.includes(s));
    const separator = seps[idx] ?? '';
    const rest = seps.slice(idx + 1);
    const pieces = (separator ? text.split(separator) : [...text]).filter((p) => p !== '');
    const out: string[] = [];
    let good: string[] = [];
    for (const piece of pieces) {
      if (piece.length < chunkSize) {
        good.push(piece);
        continue;
      }
      if (good.length) out.push(...mergeSplits(good, separator, chunkSize, chunkOverlap));
      good = [];
      out.push(...(rest.length ? split(piece, rest) : [piece]));
    }
    if (good.length) out.push(...mergeSplits(good, separator, chunkSize, chunkOverlap));
    return out;
  };
  return { splitText: (text) => split(text, separators) };
}

export function characterSplitter(separator = '\n\n', chunkSize = 1000, chunkOverlap = 200): TextSplitter {
  if (chunkOverlap >= chunkSize) throw new Error('Chunk Overlap must be smaller than Chunk Size');
  return { splitText: (text) => mergeSplits((separator ? text.split(separator) : [...text]).filter(Boolean), separator, chunkSize, chunkOverlap) };
}

/**
 * Splits by approximate tokens: words, numbers and single symbols each count as one, which is close to
 * how BPE tokenizers count English text (no tokenizer download needed).
 */
export function tokenSplitter(chunkSize = 1000, chunkOverlap = 0): TextSplitter {
  if (chunkOverlap >= chunkSize) throw new Error('Chunk Overlap must be smaller than Chunk Size');
  return {
    splitText(text) {
      const tokens = text.match(/\s*[\p{L}\p{N}_]+|\s*[^\s\p{L}\p{N}_]|\s+$/gu) ?? [];
      const chunks: string[] = [];
      for (let start = 0; start < tokens.length; start += chunkSize - chunkOverlap) {
        chunks.push(tokens.slice(start, start + chunkSize).join('').trim());
        if (start + chunkSize >= tokens.length) break;
      }
      return chunks.filter(Boolean);
    },
  };
}

const sizeProps = (size: number, overlap: number): INodeProperties[] => [
  { displayName: 'Chunk Size', name: 'chunkSize', type: 'number', default: size },
  { displayName: 'Chunk Overlap', name: 'chunkOverlap', type: 'number', default: overlap },
];
const sizes = (ctx: ISupplyDataFunctions, i: number, size: number, overlap: number) =>
  [Number(ctx.getNodeParameter('chunkSize', i, size)), Number(ctx.getNodeParameter('chunkOverlap', i, overlap))] as const;

export const RecursiveCharacterTextSplitter: INodeType = {
  description: {
    ...subNode('textSplitterRecursiveCharacterTextSplitter', 'Recursive Character Text Splitter', 'Splits text by paragraphs, then lines, then words, keeping chunks under a size', 'ai_textSplitter', 'fa:grip-lines-vertical'),
    properties: [
      ...sizeProps(1000, 200),
      {
        displayName: 'Split Code',
        name: 'splitCode',
        type: 'options',
        default: '',
        description: 'Prefer splitting at the structure of a language',
        options: [
          { name: 'Plain Text', value: '' },
          { name: 'Markdown', value: 'markdown' },
          { name: 'HTML', value: 'html' },
          { name: 'JavaScript / TypeScript', value: 'js' },
          { name: 'Python', value: 'python' },
        ],
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const [size, overlap] = sizes(this, itemIndex, 1000, 200);
    const code: Record<string, string[]> = {
      markdown: ['\n#{1,6} ', '\n## ', '\n### ', '\n```\n', '\n\n', '\n', ' ', ''],
      html: ['<body', '<div', '<p', '<br', '<li', '<h1', '<h2', '<h3', '<table', '\n\n', '\n', ' ', ''],
      js: ['\nfunction ', '\nconst ', '\nlet ', '\nclass ', '\nexport ', '\nif ', '\nfor ', '\n\n', '\n', ' ', ''],
      python: ['\nclass ', '\ndef ', '\n\tdef ', '\n\n', '\n', ' ', ''],
    };
    const lang = this.getNodeParameter('splitCode', itemIndex, '') as string;
    return { response: recursiveSplitter(size, overlap, code[lang]) };
  },
};

export const CharacterTextSplitter: INodeType = {
  description: {
    ...subNode('textSplitterCharacterTextSplitter', 'Character Text Splitter', 'Splits text at a separator, keeping chunks under a size', 'ai_textSplitter', 'fa:grip-lines-vertical'),
    properties: [{ displayName: 'Separator', name: 'separator', type: 'string', default: '\\n\\n', description: 'Escape sequences like \\n are understood' }, ...sizeProps(1000, 0)],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const [size, overlap] = sizes(this, itemIndex, 1000, 0);
    const separator = String(this.getNodeParameter('separator', itemIndex, '\\n\\n')).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    return { response: characterSplitter(separator, size, overlap) };
  },
};

export const TokenTextSplitter: INodeType = {
  description: {
    ...subNode('textSplitterTokenSplitter', 'Token Splitter', 'Splits text into chunks of about N tokens', 'ai_textSplitter', 'fa:grip-lines-vertical'),
    properties: sizeProps(1000, 0),
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const [size, overlap] = sizes(this, itemIndex, 1000, 0);
    return { response: tokenSplitter(size, overlap) };
  },
};

/* ---------------- document loader ---------------- */

/** "key: value" lines for every leaf, so the keys stay searchable next to their values. */
function flattenJson(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [`${prefix ? `${prefix}: ` : ''}${String(value)}`];
  return Object.entries(value as object).flatMap(([k, v]) => flattenJson(v, Array.isArray(value) ? `${prefix}[${k}]` : prefix ? `${prefix}.${k}` : k));
}

export const DefaultDataLoader: INodeType = {
  description: {
    ...subNode('documentDefaultDataLoader', 'Default Data Loader', 'Turns input items or files into documents for a vector store', 'ai_document', 'fa:file-import'),
    inputs: [],
    dynamicInputs: (p) => (p.textSplittingMode === 'custom' ? [{ type: 'ai_textSplitter', displayName: 'Text Splitter', required: true, maxConnections: 1 }] : []),
    properties: [
      { displayName: 'Type of Data', name: 'dataType', type: 'options', default: 'json', options: [{ name: 'JSON', value: 'json' }, { name: 'Binary', value: 'binary' }] },
      {
        displayName: 'Mode',
        name: 'jsonMode',
        type: 'options',
        default: 'allInputData',
        displayOptions: { show: { dataType: ['json'] } },
        options: [
          { name: 'Load All Input Data', value: 'allInputData' },
          { name: 'Load Specific Data', value: 'expressionData' },
        ],
      },
      { displayName: 'Data', name: 'jsonData', type: 'string', typeOptions: { rows: 3 }, default: '', required: true, displayOptions: { show: { dataType: ['json'], jsonMode: ['expressionData'] } }, placeholder: '={{ $json.text }}' },
      {
        displayName: 'Mode',
        name: 'binaryMode',
        type: 'options',
        default: 'allInputData',
        displayOptions: { show: { dataType: ['binary'] } },
        options: [
          { name: 'Load All Input Files', value: 'allInputData' },
          { name: 'Load Specific File', value: 'specificField' },
        ],
      },
      { displayName: 'Input Data Field Name', name: 'binaryDataKey', type: 'string', default: 'data', displayOptions: { show: { dataType: ['binary'], binaryMode: ['specificField'] } } },
      {
        displayName: 'Data Format',
        name: 'loader',
        type: 'options',
        default: 'auto',
        displayOptions: { show: { dataType: ['binary'] } },
        options: [
          { name: 'Automatically Detect by MIME Type', value: 'auto' },
          { name: 'CSV', value: 'csv' },
          { name: 'JSON', value: 'json' },
          { name: 'PDF', value: 'pdf' },
          { name: 'Text', value: 'text' },
        ],
      },
      {
        displayName: 'Text Splitting',
        name: 'textSplittingMode',
        type: 'options',
        default: 'simple',
        options: [
          { name: 'Simple', value: 'simple', description: 'Chunks of 1000 characters with 200 overlap' },
          { name: 'Custom', value: 'custom', description: 'Connect a text splitter sub-node' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          {
            displayName: 'Metadata',
            name: 'metadata',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            description: 'Stored with every chunk, e.g. to filter searches later',
            options: [{ name: 'metadataValues', displayName: 'Field', values: [{ displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' }] }],
          },
          { displayName: 'Split Pages in PDF', name: 'splitPages', type: 'boolean', default: true, displayOptions: { show: { '/loader': ['pdf', 'auto'] } } },
          { displayName: 'Separator (CSV)', name: 'separator', type: 'string', default: ',', displayOptions: { show: { '/loader': ['csv', 'auto'] } } },
        ],
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions) {
    const splitter =
      this.getNodeParameter('textSplittingMode', 0, 'simple') === 'custom'
        ? ((await this.getInputConnectionData('ai_textSplitter', 0)) as TextSplitter)
        : recursiveSplitter(1000, 200);
    const ctx = this;

    const fromText = (text: string, metadata: IDataObject): AiDocument[] =>
      splitter.splitText(text).map((pageContent, chunk) => ({ pageContent, metadata: { ...metadata, loc: { chunk } } }));

    const fromFile = async (i: number, key: string, item: INodeExecutionData, metadata: IDataObject): Promise<AiDocument[]> => {
      const bin = item.binary![key];
      const buffer = await ctx.helpers.getBinaryDataBuffer(i, key);
      const o = ctx.getNodeParameter('options', i, {}) as IDataObject;
      let format = ctx.getNodeParameter('loader', i, 'auto') as string;
      const mime = bin.mimeType ?? '';
      if (format === 'auto') format = mime === 'application/pdf' ? 'pdf' : mime.includes('csv') ? 'csv' : mime.includes('json') ? 'json' : 'text';
      const source = { source: bin.fileName ?? key, mimeType: mime, ...metadata };
      if (format === 'pdf') {
        const { extractText, getDocumentProxy } = await import('unpdf');
        const pdf = await getDocumentProxy(new Uint8Array(buffer));
        if (o.splitPages === false) {
          const { text } = await extractText(pdf, { mergePages: true });
          return fromText(text, source);
        }
        const { text } = await extractText(pdf, { mergePages: false });
        return text.flatMap((page, n) => fromText(page, { ...source, pdf: { page: n + 1, totalPages: text.length } }));
      }
      const text = buffer.toString('utf8');
      if (format === 'json') return fromText(flattenJson(JSON.parse(text)).join('\n'), source);
      if (format === 'csv') {
        const Papa = (await import('papaparse')).default;
        const rows = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true, delimiter: String(o.separator ?? ',') }).data;
        // one document per row, like LangChain's CSV loader
        return rows.flatMap((row, line) => fromText(Object.entries(row).map(([k, v]) => `${k}: ${v}`).join('\n'), { ...source, line: line + 1 }));
      }
      return fromText(text, source);
    };

    const loader: DocumentLoader = {
      async loadItem(item, i) {
        const values = (ctx.getNodeParameter('options.metadata.metadataValues', i, []) as Array<{ name: string; value: unknown }>) ?? [];
        const metadata = Object.fromEntries(values.filter((m) => m.name).map((m) => [m.name, m.value])) as IDataObject;
        if (ctx.getNodeParameter('dataType', i, 'json') === 'json') {
          const specific = ctx.getNodeParameter('jsonMode', i, 'allInputData') === 'expressionData';
          const text = specific ? ctx.getNodeParameter('jsonData', i) : flattenJson(item.json).join('\n');
          return fromText(typeof text === 'string' ? text : JSON.stringify(text), { source: 'json', ...metadata });
        }
        if (!item.binary || !Object.keys(item.binary).length) throw new Error(`Item ${i} has no binary data. Use "Type of Data: JSON" or read a file first.`);
        const keys = ctx.getNodeParameter('binaryMode', i, 'allInputData') === 'specificField' ? [ctx.getNodeParameter('binaryDataKey', i, 'data') as string] : Object.keys(item.binary);
        const docs: AiDocument[] = [];
        for (const key of keys) {
          if (!item.binary[key]) throw new Error(`Item ${i} has no binary field "${key}"`);
          docs.push(...(await fromFile(i, key, item, metadata)));
        }
        return docs;
      },
    };
    return { response: loader };
  },
};

/* ---------------- vector stores ---------------- */

/** One storage engine behind the vector store nodes. Vectors are stored with their document. */
export interface VectorBackend {
  add(rows: Array<{ vector: number[]; document: AiDocument }>): Promise<void>;
  search(vector: number[], k: number, filter?: IDataObject): Promise<Array<[AiDocument, number]>>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

type Mode = 'load' | 'insert' | 'retrieve' | 'retrieve-as-tool';

const embeddingInput: INodeInputConfiguration = { type: 'ai_embedding', displayName: 'Embedding', required: true, maxConnections: 1 };

function vectorStoreIO(mode: Mode) {
  if (mode === 'insert') {
    return { inputs: ['main', { type: 'ai_document', displayName: 'Document', required: true, maxConnections: 1 }, embeddingInput] as Array<ConnectionType | INodeInputConfiguration>, outputs: ['main'] as ConnectionType[] };
  }
  if (mode === 'load') return { inputs: ['main', embeddingInput] as Array<ConnectionType | INodeInputConfiguration>, outputs: ['main'] as ConnectionType[] };
  return { inputs: [embeddingInput], outputs: [mode === 'retrieve' ? 'ai_vectorStore' : 'ai_tool'] as ConnectionType[] };
}

export function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const matchesFilter = (metadata: IDataObject, filter?: IDataObject) => !filter || Object.entries(filter).every(([k, v]) => String(metadata[k]) === String(v));

export interface VectorStoreSpec {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  credentials?: INodeType['description']['credentials'];
  /** Where the vectors live (table, collection, memory key...) */
  properties: INodeProperties[];
  /** Options shown only when inserting */
  insertOptions?: INodeProperties[];
  open(ctx: IExecuteFunctions | ISupplyDataFunctions, itemIndex: number): Promise<VectorBackend>;
  methods?: INodeType['methods'];
}

/** Builds a vector store node with n8n's four modes: get many, insert, retrieve (for chains) and retrieve as tool. */
export function vectorStoreNode(spec: VectorStoreSpec): INodeType {
  const show = (...modes: Mode[]) => ({ show: { mode: modes } });
  const store = (backend: VectorBackend, embeddings: Embeddings): VectorStore => ({
    async addDocuments(docs) {
      const vectors = await embeddings.embedDocuments(docs.map((d) => d.pageContent));
      await backend.add(docs.map((document, i) => ({ vector: vectors[i], document })));
    },
    async similaritySearch(query, k, filter) {
      return backend.search(await embeddings.embedQuery(query), k, filter);
    },
  });
  const filterOf = (ctx: IExecuteFunctions | ISupplyDataFunctions, i: number) => {
    const values = (ctx.getNodeParameter('options.metadataFilter.metadataValues', i, []) as Array<{ name: string; value: unknown }>) ?? [];
    return values.length ? (Object.fromEntries(values.filter((v) => v.name).map((v) => [v.name, v.value])) as IDataObject) : undefined;
  };
  const docJson = (d: AiDocument, withMeta: boolean) => ({ pageContent: d.pageContent, ...(withMeta ? { metadata: d.metadata } : {}) });

  return {
    description: {
      name: `8n8-ai.${spec.name}`,
      displayName: spec.displayName,
      description: spec.description,
      group: ['transform'],
      version: 1,
      defaults: { name: spec.displayName, color: '#7b61ff' },
      icon: spec.icon,
      codex: { categories: ['AI'], alias: ['RAG', 'Vector', 'Embeddings', 'Knowledge base'] },
      credentials: spec.credentials,
      ...vectorStoreIO('insert'),
      dynamicInputs: (p) => vectorStoreIO((p.mode as Mode) ?? 'insert').inputs,
      dynamicOutputs: (p) => vectorStoreIO((p.mode as Mode) ?? 'insert').outputs,
      subNodeParameters: { ai_tool: { mode: 'retrieve-as-tool' }, ai_vectorStore: { mode: 'retrieve' } },
      properties: [
        {
          displayName: 'Operation Mode',
          name: 'mode',
          type: 'options',
          default: 'insert',
          options: [
            { name: 'Get Many', value: 'load', description: 'Find the documents closest to a prompt' },
            { name: 'Insert Documents', value: 'insert', description: 'Add documents to the store' },
            { name: 'Retrieve Documents (As Vector Store for Chain/Tool)', value: 'retrieve', description: 'Connect to a retriever or a vector store tool' },
            { name: 'Retrieve Documents (As Tool for AI Agent)', value: 'retrieve-as-tool', description: 'Let an agent search the store' },
          ],
        },
        { displayName: 'Description', name: 'toolDescription', type: 'string', typeOptions: { rows: 2 }, default: '', required: true, displayOptions: show('retrieve-as-tool'), description: 'Tells the agent what is in the store and when to search it' },
        ...spec.properties,
        { displayName: 'Prompt', name: 'prompt', type: 'string', default: '', required: true, displayOptions: show('load'), description: 'Text to search for. Documents are ranked by similarity.' },
        { displayName: 'Limit', name: 'topK', type: 'number', default: 4, displayOptions: show('load', 'retrieve-as-tool'), description: 'How many documents to return' },
        { displayName: 'Include Metadata', name: 'includeDocumentMetadata', type: 'boolean', default: true, displayOptions: show('load', 'retrieve-as-tool') },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [
            ...(spec.insertOptions ?? []).map((p) => ({ ...p, displayOptions: { show: { '/mode': ['insert'] } } })),
            {
              displayName: 'Metadata Filter',
              name: 'metadataFilter',
              type: 'fixedCollection',
              typeOptions: { multipleValues: true },
              default: {},
              description: 'Only return documents whose metadata has these values',
              displayOptions: { show: { '/mode': ['load', 'retrieve', 'retrieve-as-tool'] } },
              options: [{ name: 'metadataValues', displayName: 'Field', values: [{ displayName: 'Name', name: 'name', type: 'string', default: '' }, { displayName: 'Value', name: 'value', type: 'string', default: '' }] }],
            },
          ],
        },
      ],
    },
    methods: spec.methods,

    async execute(this: IExecuteFunctions) {
      const mode = this.getNodeParameter('mode', 0) as Mode;
      if (mode !== 'load' && mode !== 'insert') throw new NodeOperationError(this.getNode(), 'In this mode the node is a sub-node: connect it to an agent, retriever or tool');
      const items = this.getInputData();
      const embeddings = (await this.getInputConnectionData('ai_embedding', 0)) as Embeddings;
      const backend = await spec.open(this, 0);
      const out: INodeExecutionData[] = [];
      try {
        if (mode === 'insert') {
          const loader = (await this.getInputConnectionData('ai_document', 0)) as DocumentLoader;
          if (this.getNodeParameter('options.clearStore', 0, false)) await backend.clear();
          const vs = store(backend, embeddings);
          for (let i = 0; i < items.length; i++) {
            try {
              const docs = await loader.loadItem(items[i], i);
              await vs.addDocuments(docs);
              for (const d of docs) out.push({ json: docJson(d, true) as IDataObject, pairedItem: { item: i } });
            } catch (e) {
              if (!this.continueOnFail()) throw e instanceof NodeOperationError ? e : new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
              out.push(errorItem(e, i));
            }
          }
          return [out];
        }
        const vs = store(backend, embeddings);
        for (let i = 0; i < items.length; i++) {
          try {
            const prompt = String(this.getNodeParameter('prompt', i) ?? '');
            if (!prompt.trim()) throw new NodeOperationError(this.getNode(), 'The prompt is empty', { itemIndex: i });
            const withMeta = this.getNodeParameter('includeDocumentMetadata', i, true) as boolean;
            const found = await vs.similaritySearch(prompt, Number(this.getNodeParameter('topK', i, 4)), filterOf(this, i));
            for (const [doc, score] of found) out.push({ json: { document: docJson(doc, withMeta), score } as IDataObject, pairedItem: { item: i } });
          } catch (e) {
            if (!this.continueOnFail()) throw e instanceof NodeOperationError ? e : new NodeOperationError(this.getNode(), e as Error, { itemIndex: i });
            out.push(errorItem(e, i));
          }
        }
        return [out];
      } finally {
        await backend.close?.();
      }
    },

    async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
      const mode = this.getNodeParameter('mode', itemIndex) as Mode;
      const embeddings = (await this.getInputConnectionData('ai_embedding', itemIndex)) as Embeddings;
      const backend = await spec.open(this, itemIndex);
      const vs = store(backend, embeddings);
      const filter = filterOf(this, itemIndex);
      const closeFunction = backend.close ? () => backend.close!() : undefined;
      if (mode === 'retrieve') {
        // a filter set on the node always applies, on top of what the caller asks for
        const filtered: VectorStore = { ...vs, similaritySearch: (q, k, f) => vs.similaritySearch(q, k, { ...filter, ...f }) };
        return { response: filtered, closeFunction };
      }
      if (mode !== 'retrieve-as-tool') throw new Error('Set "Operation Mode" to a retrieve mode to use this node as a sub-node');
      const topK = Number(this.getNodeParameter('topK', itemIndex, 4));
      const withMeta = this.getNodeParameter('includeDocumentMetadata', itemIndex, true) as boolean;
      const tool: ToolSpec = {
        name: toToolName(this.getNode().name),
        description: this.getNodeParameter('toolDescription', itemIndex) as string,
        inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'What to search for' } }, required: ['input'] },
        async invoke(input) {
          const found = await vs.similaritySearch(String(input.input ?? input.query ?? ''), topK, filter);
          return JSON.stringify(found.map(([d]) => docJson(d, withMeta)));
        },
      };
      return { response: tool, closeFunction };
    },
  };
}

/* --- Simple (in memory) --- */

/** Shared by every workflow on this instance, like n8n's Simple Vector Store. Lost on restart. */
const memoryStores = new Map<string, Array<{ vector: number[]; document: AiDocument }>>();

export const SimpleVectorStore = vectorStoreNode({
  name: 'vectorStoreInMemory',
  displayName: 'Simple Vector Store',
  description: 'Keeps documents and their vectors in memory (cleared on restart)',
  icon: 'fa:database',
  properties: [{ displayName: 'Memory Key', name: 'memoryKey', type: 'string', default: 'vector_store_key', description: 'Stores with the same key share their documents, across workflows' }],
  insertOptions: [{ displayName: 'Clear Store', name: 'clearStore', type: 'boolean', default: false, description: 'Remove what the store holds before inserting' }],
  async open(ctx, i) {
    const key = String(ctx.getNodeParameter('memoryKey', i, 'vector_store_key'));
    return {
      async add(rows) {
        memoryStores.set(key, [...(memoryStores.get(key) ?? []), ...rows]);
      },
      async search(vector, k, filter) {
        return (memoryStores.get(key) ?? [])
          .filter((r) => matchesFilter(r.document.metadata, filter))
          .map((r) => [r.document, cosineSimilarity(vector, r.vector)] as [AiDocument, number])
          .sort((a, b) => b[1] - a[1])
          .slice(0, k);
      },
      async clear() {
        memoryStores.delete(key);
      },
    };
  },
});

/* --- PGVector --- */

const ident = (name: string) => {
  if (!/^[A-Za-z_][\w]*$/.test(name)) throw new Error(`Invalid name "${name}": use letters, numbers and underscores`);
  return `"${name}"`;
};

export const PGVectorStore = vectorStoreNode({
  name: 'vectorStorePGVector',
  displayName: 'Postgres PGVector Store',
  description: 'Stores documents and vectors in Postgres with the pgvector extension',
  icon: 'fa:database',
  credentials: [{ name: 'postgres', required: true }],
  properties: [
    { displayName: 'Table Name', name: 'tableName', type: 'string', default: 'n8n_vectors', description: 'Created (with the vector extension) when missing' },
    {
      displayName: 'Columns',
      name: 'columns',
      type: 'collection',
      default: {},
      options: [
        { displayName: 'ID Column', name: 'idColumnName', type: 'string', default: 'id' },
        { displayName: 'Vector Column', name: 'vectorColumnName', type: 'string', default: 'embedding' },
        { displayName: 'Content Column', name: 'contentColumnName', type: 'string', default: 'text' },
        { displayName: 'Metadata Column', name: 'metadataColumnName', type: 'string', default: 'metadata' },
      ],
    },
    {
      displayName: 'Distance Strategy',
      name: 'distanceStrategy',
      type: 'options',
      default: 'cosine',
      options: [
        { name: 'Cosine', value: 'cosine' },
        { name: 'Inner Product', value: 'innerProduct' },
        { name: 'Euclidean', value: 'euclidean' },
      ],
    },
  ],
  insertOptions: [{ displayName: 'Clear Table', name: 'clearStore', type: 'boolean', default: false, description: 'Delete every row before inserting' }],
  async open(ctx, i) {
    const cols = ctx.getNodeParameter('columns', i, {}) as IDataObject;
    const table = ident(String(ctx.getNodeParameter('tableName', i, 'n8n_vectors')));
    const id = ident(String(cols.idColumnName || 'id'));
    const vec = ident(String(cols.vectorColumnName || 'embedding'));
    const text = ident(String(cols.contentColumnName || 'text'));
    const meta = ident(String(cols.metadataColumnName || 'metadata'));
    const strategy = ctx.getNodeParameter('distanceStrategy', i, 'cosine') as string;
    const op = strategy === 'innerProduct' ? '<#>' : strategy === 'euclidean' ? '<->' : '<=>';
    // report a similarity (higher is closer) whatever the operator
    const score = (d: number) => (strategy === 'innerProduct' ? -d : strategy === 'euclidean' ? 1 / (1 + d) : 1 - d);
    const pool = pgPool(await ctx.getCredentials<PgCreds>('postgres'));
    let ready: Promise<unknown> | undefined;
    const ensure = () =>
      (ready ??= (async () => {
        await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (${id} uuid PRIMARY KEY, ${text} text, ${meta} jsonb, ${vec} vector)`);
      })());
    const literal = (v: number[]) => `[${v.join(',')}]`;
    return {
      async add(rows) {
        await ensure();
        for (let start = 0; start < rows.length; start += 200) {
          const batch = rows.slice(start, start + 200);
          const values = batch.map((_r, n) => `($${n * 4 + 1}, $${n * 4 + 2}, $${n * 4 + 3}, $${n * 4 + 4}::vector)`).join(', ');
          await pool.query(
            `INSERT INTO ${table} (${id}, ${text}, ${meta}, ${vec}) VALUES ${values}`,
            batch.flatMap((r) => [randomUUID(), r.document.pageContent, JSON.stringify(r.document.metadata), literal(r.vector)]),
          );
        }
      },
      async search(vector, k, filter) {
        await ensure();
        const { rows } = await pool.query(
          `SELECT ${text} AS text, ${meta} AS metadata, ${vec} ${op} $1::vector AS distance FROM ${table} WHERE ${meta} @> $2::jsonb ORDER BY distance LIMIT $3`,
          [literal(vector), JSON.stringify(filter ?? {}), k],
        );
        return rows.map((r: { text: string; metadata: IDataObject; distance: number }) => [{ pageContent: r.text, metadata: r.metadata ?? {} }, score(Number(r.distance))] as [AiDocument, number]);
      },
      async clear() {
        await ensure();
        await pool.query(`DELETE FROM ${table}`);
      },
      close: () => pool.end(),
    };
  },
});

/* --- Qdrant --- */

interface QdrantCreds { qdrantUrl: string; apiKey?: string }

export const QdrantVectorStore = vectorStoreNode({
  name: 'vectorStoreQdrant',
  displayName: 'Qdrant Vector Store',
  description: 'Stores documents and vectors in a Qdrant collection',
  icon: 'fa:database',
  credentials: [{ name: 'qdrantApi', required: true }],
  properties: [{ displayName: 'Qdrant Collection', name: 'qdrantCollection', type: 'string', default: '', required: true, description: 'Created when inserting into a collection that does not exist' }],
  insertOptions: [{ displayName: 'Clear Collection', name: 'clearStore', type: 'boolean', default: false, description: 'Delete the collection before inserting' }],
  async open(ctx, i) {
    const c = await ctx.getCredentials<QdrantCreds>('qdrantApi');
    const collection = String(ctx.getNodeParameter('qdrantCollection', i, '')).trim();
    if (!collection) throw new Error('Set the Qdrant collection');
    const base = `${c.qdrantUrl.replace(/\/$/, '')}/collections/${encodeURIComponent(collection)}`;
    const call = (method: string, url: string, body?: unknown) =>
      ctx.helpers.httpRequest({ method: method as 'GET', url, headers: c.apiKey ? { 'api-key': c.apiKey } : {}, ...(body ? { body } : {}), json: true, returnFullResponse: true, ignoreHttpStatusErrors: true }) as Promise<{
        statusCode: number;
        body: { result?: unknown; status?: { error?: string } };
      }>;
    const check = <R extends { statusCode: number; body: { status?: { error?: string } } }>(r: R) => {
      if (r.statusCode >= 400) throw new Error(`Qdrant: ${r.body?.status?.error ?? `HTTP ${r.statusCode}`}`);
      return r;
    };
    return {
      async add(rows) {
        if (!rows.length) return;
        if ((await call('GET', base)).statusCode === 404) check(await call('PUT', base, { vectors: { size: rows[0].vector.length, distance: 'Cosine' } }));
        for (let start = 0; start < rows.length; start += 256) {
          const points = rows.slice(start, start + 256).map((r) => ({ id: randomUUID(), vector: r.vector, payload: { content: r.document.pageContent, metadata: r.document.metadata } }));
          check(await call('PUT', `${base}/points?wait=true`, { points }));
        }
      },
      async search(vector, k, filter) {
        const must = Object.entries(filter ?? {}).map(([key, value]) => ({ key: `metadata.${key}`, match: { value } }));
        const r = check(await call('POST', `${base}/points/search`, { vector, limit: k, with_payload: true, ...(must.length ? { filter: { must } } : {}) }));
        return (r.body.result as Array<{ score: number; payload: { content?: string; metadata?: IDataObject } }>).map((p) => [{ pageContent: p.payload.content ?? '', metadata: p.payload.metadata ?? {} }, p.score] as [AiDocument, number]);
      },
      async clear() {
        await call('DELETE', base);
      },
    };
  },
});

/* --- Pinecone --- */

export const PineconeVectorStore = vectorStoreNode({
  name: 'vectorStorePinecone',
  displayName: 'Pinecone Vector Store',
  description: 'Stores documents and vectors in a Pinecone index',
  icon: 'fa:database',
  credentials: [{ name: 'pineconeApi', required: true }],
  properties: [
    { displayName: 'Pinecone Index', name: 'pineconeIndex', type: 'string', default: '', required: true, description: 'The index must exist, with the dimension of your embeddings model' },
    { displayName: 'Namespace', name: 'pineconeNamespace', type: 'string', default: '', description: 'Optional partition inside the index' },
  ],
  insertOptions: [{ displayName: 'Clear Namespace', name: 'clearStore', type: 'boolean', default: false, description: 'Delete every vector in the namespace before inserting' }],
  async open(ctx, i) {
    const { apiKey } = await ctx.getCredentials<{ apiKey: string }>('pineconeApi');
    const index = String(ctx.getNodeParameter('pineconeIndex', i, '')).trim();
    if (!index) throw new Error('Set the Pinecone index');
    const namespace = String(ctx.getNodeParameter('pineconeNamespace', i, '') ?? '');
    const headers = { 'Api-Key': apiKey, 'X-Pinecone-API-Version': '2025-04' };
    let host: string | undefined;
    const indexHost = async () =>
      (host ??= `https://${((await ctx.helpers.httpRequest({ url: `https://api.pinecone.io/indexes/${encodeURIComponent(index)}`, headers, json: true })) as { host: string }).host}`);
    const post = async (path: string, body: IDataObject) => ctx.helpers.httpRequest({ method: 'POST', url: `${await indexHost()}${path}`, headers, body, json: true });
    return {
      async add(rows) {
        for (let start = 0; start < rows.length; start += 100) {
          // LangChain's layout: the text lives in the metadata under "text"
          const vectors = rows.slice(start, start + 100).map((r) => ({ id: randomUUID(), values: r.vector, metadata: { ...r.document.metadata, text: r.document.pageContent } }));
          await post('/vectors/upsert', { vectors, namespace });
        }
      },
      async search(vector, k, filter) {
        const res = (await post('/query', { vector, topK: k, includeMetadata: true, namespace, ...(filter ? { filter: Object.fromEntries(Object.entries(filter).map(([key, v]) => [key, { $eq: v }])) } : {}) })) as {
          matches: Array<{ score: number; metadata?: IDataObject }>;
        };
        return res.matches.map(({ score, metadata = {} }) => {
          const { text, ...rest } = metadata;
          return [{ pageContent: String(text ?? ''), metadata: rest }, score] as [AiDocument, number];
        });
      },
      async clear() {
        await post('/vectors/delete', { deleteAll: true, namespace }).catch(() => undefined);
      },
    };
  },
});

/* ---------------- retriever, chains and the vector store tool ---------------- */

export const VectorStoreRetriever: INodeType = {
  description: {
    ...subNode('retrieverVectorStore', 'Vector Store Retriever', 'Finds documents in a vector store for a chain', 'ai_retriever', 'fa:box-open'),
    inputs: [{ type: 'ai_vectorStore', displayName: 'Vector Store', required: true, maxConnections: 1 }],
    properties: [{ displayName: 'Limit', name: 'topK', type: 'number', default: 4, description: 'How many documents to retrieve' }],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const store = (await this.getInputConnectionData('ai_vectorStore', itemIndex)) as VectorStore;
    const k = Number(this.getNodeParameter('topK', itemIndex, 4));
    const retriever: Retriever = { retrieve: async (q) => (await store.similaritySearch(q, k)).map(([d]) => d) };
    return { response: retriever };
  },
};

const promptProps: INodeProperties[] = [
  {
    displayName: 'Source for Prompt (User Message)',
    name: 'promptType',
    type: 'options',
    default: 'auto',
    options: [
      { name: 'Connected Chat Trigger Node', value: 'auto', description: 'Uses the chatInput field from the previous node' },
      { name: 'Define Below', value: 'define' },
    ],
  },
  { displayName: 'Prompt (User Message)', name: 'text', type: 'string', typeOptions: { rows: 2 }, default: '', required: true, displayOptions: { show: { promptType: ['define'] } } },
];

function promptOf(ctx: IExecuteFunctions, item: INodeExecutionData, i: number) {
  const prompt = ctx.getNodeParameter('promptType', i, 'auto') === 'define' ? String(ctx.getNodeParameter('text', i) ?? '') : String(item.json.chatInput ?? '');
  if (!prompt.trim()) {
    throw new NodeOperationError(ctx.getNode(), 'No prompt given', { itemIndex: i, description: 'Connect a Chat Trigger (it sends "chatInput") or set "Source for Prompt" to "Define Below"' });
  }
  return prompt;
}

/** Runs `fn` for every item with n8n's error handling. */
async function perItem(ctx: IExecuteFunctions, fn: (item: INodeExecutionData, i: number) => Promise<IDataObject>) {
  const out: INodeExecutionData[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      out.push({ json: await fn(items[i], i), pairedItem: { item: i } });
    } catch (e) {
      if (ctx.continueOnFail()) {
        out.push(errorItem(e, i));
        continue;
      }
      throw e instanceof NodeOperationError ? e : new NodeOperationError(ctx.getNode(), e as Error, { itemIndex: i });
    }
  }
  return [out];
}

const formatContext = (docs: AiDocument[]) => docs.map((d) => d.pageContent).join('\n\n');

const DEFAULT_QA_SYSTEM = `Use the following pieces of context to answer the user's question.
If you don't know the answer, just say that you don't know, don't try to make up an answer.
----------------
Context: {context}`;

export const RetrievalQaChain: INodeType = {
  description: {
    name: '8n8-ai.chainRetrievalQa',
    displayName: 'Question and Answer Chain',
    description: 'Answers a question with documents found by a retriever',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Question and Answer Chain', color: '#7b61ff' },
    icon: 'fa:link',
    inputs: [
      'main',
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      { type: 'ai_retriever', displayName: 'Retriever', required: true, maxConnections: 1 },
    ],
    outputs: ['main'],
    codex: { categories: ['AI'], alias: ['RAG', 'Q&A', 'Knowledge base'] },
    properties: [
      ...promptProps,
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [{ displayName: 'System Prompt Template', name: 'systemPromptTemplate', type: 'string', typeOptions: { rows: 6 }, default: DEFAULT_QA_SYSTEM, description: '{context} is replaced with the retrieved documents' }],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return perItem(this, async (item, i) => {
      const model = (await this.getInputConnectionData('ai_languageModel', i)) as ChatModel;
      const retriever = (await this.getInputConnectionData('ai_retriever', i)) as Retriever;
      const question = promptOf(this, item, i);
      const docs = await retriever.retrieve(question);
      const template = String(this.getNodeParameter('options.systemPromptTemplate', i, DEFAULT_QA_SYSTEM));
      const system = template.includes('{context}') ? template.replaceAll('{context}', formatContext(docs)) : `${template}\n\nContext:\n${formatContext(docs)}`;
      return { response: await ask(model, system, question) };
    });
  },
};

export const BasicLlmChain: INodeType = {
  description: {
    name: '8n8-ai.chainLlm',
    displayName: 'Basic LLM Chain',
    description: 'Sends a prompt to a chat model and returns its answer',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Basic LLM Chain', color: '#7b61ff' },
    icon: 'fa:link',
    inputs: [
      'main',
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      { type: 'ai_outputParser', displayName: 'Output Parser', maxConnections: 1 },
    ],
    outputs: ['main'],
    codex: { categories: ['AI'], alias: ['LLM', 'Prompt', 'Completion'] },
    properties: [
      ...promptProps,
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [{ displayName: 'System Message', name: 'systemMessage', type: 'string', typeOptions: { rows: 4 }, default: '' }],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return perItem(this, async (item, i) => {
      const model = (await this.getInputConnectionData('ai_languageModel', i)) as ChatModel;
      const parser = (await this.getInputConnectionData('ai_outputParser', i)) as OutputParser | undefined;
      const system = [String(this.getNodeParameter('options.systemMessage', i, '') ?? ''), parser?.instructions].filter(Boolean).join('\n\n') || undefined;
      const session = model.createSession({ system, tools: [] });
      const turn = await session.sendUser(promptOf(this, item, i));
      if (!parser) return { text: turn.text };
      try {
        return { output: parser.parse(turn.text) as IDataObject };
      } catch (e) {
        const retry = await session.sendUser(`${(e as Error).message}. Reply again with only the JSON.`);
        return { output: parser.parse(retry.text) as IDataObject };
      }
    });
  },
};

export const VectorStoreTool: INodeType = {
  description: {
    ...subNode('toolVectorStore', 'Answer Questions with a Vector Store', 'A tool that answers from your documents, using its own chat model', 'ai_tool', 'fa:database'),
    inputs: [
      { type: 'ai_vectorStore', displayName: 'Vector Store', required: true, maxConnections: 1 },
      { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 },
    ],
    properties: [
      { displayName: 'Description of Data', name: 'description', type: 'string', typeOptions: { rows: 2 }, default: '', required: true, placeholder: 'Details about our products and their prices', description: 'Tells the agent what it can ask about' },
      { displayName: 'Limit', name: 'topK', type: 'number', default: 4, description: 'How many documents to use for each answer' },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const store = (await this.getInputConnectionData('ai_vectorStore', itemIndex)) as VectorStore;
    const model = (await this.getInputConnectionData('ai_languageModel', itemIndex)) as ChatModel;
    const k = Number(this.getNodeParameter('topK', itemIndex, 4));
    const data = this.getNodeParameter('description', itemIndex) as string;
    const tool: ToolSpec = {
      name: toToolName(this.getNode().name),
      description: `Useful for when you need to answer questions about ${data}. Whenever you need information about ${data}, use this tool. Input should be a fully formed question.`,
      inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'A fully formed question' } }, required: ['input'] },
      async invoke(input) {
        const question = String(input.input ?? input.query ?? '');
        const docs = (await store.similaritySearch(question, k)).map(([d]) => d);
        return ask(model, DEFAULT_QA_SYSTEM.replace('{context}', formatContext(docs)), question);
      },
    };
    return { response: tool };
  },
};

export const ragNodes: INodeType[] = [
  EmbeddingsOpenAi,
  EmbeddingsOllama,
  EmbeddingsGemini,
  RecursiveCharacterTextSplitter,
  CharacterTextSplitter,
  TokenTextSplitter,
  DefaultDataLoader,
  SimpleVectorStore,
  PGVectorStore,
  QdrantVectorStore,
  PineconeVectorStore,
  VectorStoreRetriever,
  RetrievalQaChain,
  BasicLlmChain,
  VectorStoreTool,
];
