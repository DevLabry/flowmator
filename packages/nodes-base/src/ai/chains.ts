import {
  NodeOperationError,
  type ConnectionType,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeInputConfiguration,
  type INodeParameters,
  type INodeType,
} from '@flowmator/workflow';
import { deepCopy, errorItem } from '../utils/object';
import type { ChatModel } from './llm';
import { recursiveSplitter, type AiDocument, type DocumentLoader, type TextSplitter } from './rag';
import { checkSchema, extractJson, schemaFromExample } from './subnodes';

/* ---------------- shared ---------------- */

const modelInput: INodeInputConfiguration = { type: 'ai_languageModel', displayName: 'Model', required: true, maxConnections: 1 };

const chainNode = (name: string, displayName: string, description: string, icon: string, alias: string[]) => ({
  name: `flowmator-ai.${name}`,
  displayName,
  description,
  group: ['transform' as const],
  version: 1,
  defaults: { name: displayName, color: '#7b61ff' },
  icon,
  codex: { categories: ['AI'], alias },
});

/**
 * Asks for a JSON answer that matches `schema`. A reply that is not valid JSON or does not match
 * is sent back once with the problem, then the error is raised.
 */
export async function askJson(model: ChatModel, system: string, prompt: string, schema: Record<string, unknown>): Promise<unknown> {
  const session = model.createSession({
    system: `${system}\n\nReply with only a JSON value (no other text, no code fence) that matches this JSON Schema:\n${JSON.stringify(schema, null, 2)}`,
    tools: [],
  });
  let turn = await session.sendUser(prompt);
  for (let attempt = 0; ; attempt++) {
    try {
      const value = extractJson(turn.text);
      const errors = checkSchema(value, schema);
      if (errors.length) throw new Error(`The reply does not match the schema: ${errors.slice(0, 5).join('; ')}`);
      return value;
    } catch (e) {
      if (attempt >= 1) throw e;
      turn = await session.sendUser(`${(e as Error).message}. Reply again with only the JSON.`);
    }
  }
}

/** Runs `fn` for each item; it returns the item(s) to send to each output. */
async function routeItems(ctx: IExecuteFunctions, outputs: number, fn: (item: INodeExecutionData, i: number) => Promise<Array<[number, INodeExecutionData]>>) {
  const result: INodeExecutionData[][] = Array.from({ length: outputs }, () => []);
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      for (const [output, item] of await fn(items[i], i)) result[output].push({ ...item, pairedItem: { item: i } });
    } catch (e) {
      if (ctx.continueOnFail()) {
        result[0].push(errorItem(e, i));
        continue;
      }
      throw e instanceof NodeOperationError ? e : new NodeOperationError(ctx.getNode(), e as Error, { itemIndex: i });
    }
  }
  return result;
}

const textParam = (ctx: IExecuteFunctions, name: string, i: number) => {
  const text = ctx.getNodeParameter(name, i, '') as unknown;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  if (!s?.trim()) throw new NodeOperationError(ctx.getNode(), 'The text to analyze is empty', { itemIndex: i });
  return s;
};

const systemPromptOption = (defaultPrompt: string, description?: string) => ({
  displayName: 'System Prompt Template',
  name: 'systemPromptTemplate',
  type: 'string' as const,
  typeOptions: { rows: 6 },
  default: defaultPrompt,
  ...(description ? { description } : {}),
});

/* ---------------- Information Extractor ---------------- */

type Attribute = { name: string; type?: 'string' | 'number' | 'boolean' | 'date'; description?: string; required?: boolean };

export function schemaFromAttributes(attributes: Attribute[]): Record<string, unknown> {
  const properties = Object.fromEntries(
    attributes.map((a) => [
      a.name,
      {
        type: a.type === 'date' ? 'string' : (a.type ?? 'string'),
        description: [a.description, a.type === 'date' ? 'An ISO 8601 date' : ''].filter(Boolean).join('. ') || undefined,
      },
    ]),
  );
  return { type: 'object', properties, required: attributes.filter((a) => a.required).map((a) => a.name) };
}

const EXTRACTOR_PROMPT = `You are an expert extraction algorithm.
Only extract relevant information from the text.
If you do not know the value of an attribute asked to extract, you may omit the attribute's value.`;

export const InformationExtractor: INodeType = {
  description: {
    ...chainNode('informationExtractor', 'Information Extractor', 'Pulls structured fields out of text with a chat model', 'fa:project-diagram', ['Extract', 'Parse', 'Structured', 'NER']),
    inputs: ['main', modelInput],
    outputs: ['main'],
    properties: [
      { displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 2 }, default: '', required: true, placeholder: '={{ $json.text }}', description: 'The text to extract information from' },
      {
        displayName: 'Schema Type',
        name: 'schemaType',
        type: 'options',
        default: 'fromAttributes',
        options: [
          { name: 'From Attribute Descriptions', value: 'fromAttributes', description: 'List the fields to extract' },
          { name: 'Generate From JSON Example', value: 'fromJson' },
          { name: 'Define Using JSON Schema', value: 'manual' },
        ],
      },
      {
        displayName: 'Attributes',
        name: 'attributes',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, multipleValueButtonText: 'Add Attribute' },
        default: {},
        displayOptions: { show: { schemaType: ['fromAttributes'] } },
        options: [
          {
            name: 'attributes',
            displayName: 'Attribute',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '', placeholder: 'e.g. company_name' },
              { displayName: 'Type', name: 'type', type: 'options', default: 'string', options: ['string', 'number', 'boolean', 'date'].map((t) => ({ name: t[0].toUpperCase() + t.slice(1), value: t })) },
              { displayName: 'Description', name: 'description', type: 'string', default: '', placeholder: 'Describe your attribute' },
              { displayName: 'Required', name: 'required', type: 'boolean', default: false, description: 'Fail if the attribute is missing from the answer' },
            ],
          },
        ],
      },
      { displayName: 'JSON Example', name: 'jsonSchemaExample', type: 'json', default: '{\n  "company": "Acme",\n  "amount": 1200,\n  "paid": false\n}', displayOptions: { show: { schemaType: ['fromJson'] } } },
      { displayName: 'Input Schema', name: 'inputSchema', type: 'json', default: '{\n  "type": "object",\n  "properties": {\n    "company": { "type": "string" }\n  }\n}', displayOptions: { show: { schemaType: ['manual'] } } },
      { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [systemPromptOption(EXTRACTOR_PROMPT)] },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return routeItems(this, 1, async (_item, i) => {
      const model = (await this.getInputConnectionData('ai_languageModel', i)) as ChatModel;
      const type = this.getNodeParameter('schemaType', i, 'fromAttributes') as string;
      let schema: Record<string, unknown>;
      if (type === 'fromAttributes') {
        const attributes = ((this.getNodeParameter('attributes.attributes', i, []) as Attribute[]) ?? []).filter((a) => a.name);
        if (!attributes.length) throw new NodeOperationError(this.getNode(), 'Add at least one attribute to extract', { itemIndex: i });
        schema = schemaFromAttributes(attributes);
      } else {
        const raw = this.getNodeParameter(type === 'fromJson' ? 'jsonSchemaExample' : 'inputSchema', i);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        schema = type === 'fromJson' ? schemaFromExample(parsed) : (parsed as Record<string, unknown>);
      }
      const system = String(this.getNodeParameter('options.systemPromptTemplate', i, EXTRACTOR_PROMPT) || EXTRACTOR_PROMPT);
      const output = await askJson(model, system, textParam(this, 'text', i), schema);
      return [[0, { json: { output: output as IDataObject } }]];
    });
  },
};

/* ---------------- Text Classifier ---------------- */

type Category = { category: string; description?: string };
const categoriesOf = (p: INodeParameters) => (((p.categories as { categories?: Category[] })?.categories ?? []) as Category[]).filter((c) => c.category);
const fallbackOf = (p: INodeParameters) => ((p.options as { fallback?: string })?.fallback ?? 'discard');

const CLASSIFIER_PROMPT = "Please classify the text provided by the user into one of the following categories: {categories}, and use the provided formatting instructions below. Don't explain, and only output the json.";

export const TextClassifier: INodeType = {
  description: {
    ...chainNode('textClassifier', 'Text Classifier', 'Sends each item to an output by the category a chat model picks', 'fa:tags', ['Classify', 'Categorize', 'Route', 'Label']),
    inputs: ['main', modelInput],
    outputs: ['main'],
    dynamicOutputs: (p) => Array.from({ length: categoriesOf(p).length + (fallbackOf(p) === 'other' ? 1 : 0) }, () => 'main' as ConnectionType),
    dynamicOutputNames: (p) => [...categoriesOf(p).map((c) => c.category), ...(fallbackOf(p) === 'other' ? ['Other'] : [])],
    properties: [
      { displayName: 'Text to Classify', name: 'inputText', type: 'string', typeOptions: { rows: 2 }, default: '', required: true, placeholder: '={{ $json.text }}' },
      {
        displayName: 'Categories',
        name: 'categories',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true, multipleValueButtonText: 'Add Category' },
        default: {},
        options: [
          {
            name: 'categories',
            displayName: 'Category',
            values: [
              { displayName: 'Category', name: 'category', type: 'string', default: '', placeholder: 'e.g. Support' },
              { displayName: 'Description', name: 'description', type: 'string', default: '', placeholder: 'What belongs in this category' },
            ],
          },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Allow Multiple Classes To Be True', name: 'multiClass', type: 'boolean', default: false, description: 'Send the item to every matching output' },
          {
            displayName: 'When No Clear Match',
            name: 'fallback',
            type: 'options',
            default: 'discard',
            options: [
              { name: 'Discard Item', value: 'discard', description: 'Ignore the item' },
              { name: "Output on Extra, 'Other' Branch", value: 'other', description: 'Send the item to an extra output' },
            ],
          },
          systemPromptOption(CLASSIFIER_PROMPT, '{categories} is replaced with the category names'),
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const params = { categories: this.getNodeParameter('categories', 0, {}), options: this.getNodeParameter('options', 0, {}) } as INodeParameters;
    const categories = categoriesOf(params);
    if (!categories.length) throw new NodeOperationError(this.getNode(), 'Add at least one category');
    const fallback = fallbackOf(params);
    return routeItems(this, categories.length + (fallback === 'other' ? 1 : 0), async (item, i) => {
      const model = (await this.getInputConnectionData('ai_languageModel', i)) as ChatModel;
      const multi = !!this.getNodeParameter('options.multiClass', i, false);
      const properties: Record<string, unknown> = Object.fromEntries(categories.map((c) => [c.category, { type: 'boolean', ...(c.description ? { description: c.description } : {}) }]));
      if (fallback === 'other') properties.fallback = { type: 'boolean', description: 'Should be true if none of the other categories apply' };
      const schema = { type: 'object', properties, required: Object.keys(properties) };
      const template = String(this.getNodeParameter('options.systemPromptTemplate', i, CLASSIFIER_PROMPT) || CLASSIFIER_PROMPT);
      const system = `${template.replaceAll('{categories}', categories.map((c) => c.category).join(', '))}\n${multi ? 'Several categories can be true.' : 'Only one category can be true.'}`;
      const answer = (await askJson(model, system, textParam(this, 'inputText', i), schema)) as Record<string, boolean>;
      let hits = categories.map((c, idx) => (answer[c.category] ? idx : -1)).filter((idx) => idx >= 0);
      if (!multi) hits = hits.slice(0, 1);
      if (!hits.length) return fallback === 'other' ? [[categories.length, item]] : [];
      return hits.map((idx) => [idx, item] as [number, INodeExecutionData]);
    });
  },
};

/* ---------------- Sentiment Analysis ---------------- */

const DEFAULT_SENTIMENTS = 'Positive, Neutral, Negative';
const sentimentsOf = (p: INodeParameters) =>
  String((p.options as { categories?: string })?.categories || DEFAULT_SENTIMENTS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const SENTIMENT_PROMPT = `You are highly intelligent and accurate sentiment analyzer. Analyze the sentiment of the provided text. Categorize it into one of the following: {categories}. Use the provided formatting instructions. Only output the JSON.`;

export const SentimentAnalysis: INodeType = {
  description: {
    ...chainNode('sentimentAnalysis', 'Sentiment Analysis', 'Sends each item to an output by the sentiment of its text', 'fa:balance-scale-left', ['Sentiment', 'Emotion', 'Mood', 'Classify']),
    inputs: ['main', modelInput],
    outputs: ['main', 'main', 'main'],
    outputNames: DEFAULT_SENTIMENTS.split(', '),
    dynamicOutputs: (p) => sentimentsOf(p).map(() => 'main' as ConnectionType),
    dynamicOutputNames: (p) => sentimentsOf(p),
    properties: [
      { displayName: 'Text to Analyze', name: 'inputText', type: 'string', typeOptions: { rows: 2 }, default: '', required: true, placeholder: '={{ $json.text }}' },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Sentiment Categories', name: 'categories', type: 'string', default: DEFAULT_SENTIMENTS, description: 'Comma-separated; each one becomes an output' },
          { displayName: 'Include Detailed Results', name: 'includeDetailedResults', type: 'boolean', default: false, description: 'Add the strength and confidence of the sentiment (0 to 1)' },
          systemPromptOption(SENTIMENT_PROMPT, '{categories} is replaced with the sentiment categories'),
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const categories = sentimentsOf({ options: this.getNodeParameter('options', 0, {}) } as INodeParameters);
    return routeItems(this, categories.length, async (item, i) => {
      const model = (await this.getInputConnectionData('ai_languageModel', i)) as ChatModel;
      const detailed = !!this.getNodeParameter('options.includeDetailedResults', i, false);
      const schema = {
        type: 'object',
        properties: {
          sentiment: { type: 'string', enum: categories },
          ...(detailed
            ? { strength: { type: 'number', description: 'How strong the sentiment is, from 0 to 1' }, confidence: { type: 'number', description: 'How sure you are, from 0 to 1' } }
            : {}),
        },
        required: ['sentiment', ...(detailed ? ['strength', 'confidence'] : [])],
      };
      const template = String(this.getNodeParameter('options.systemPromptTemplate', i, SENTIMENT_PROMPT) || SENTIMENT_PROMPT);
      const answer = (await askJson(model, template.replaceAll('{categories}', categories.join(', ')), textParam(this, 'inputText', i), schema)) as IDataObject;
      // models may change the case of a category
      const index = categories.findIndex((c) => c.toLowerCase() === String(answer.sentiment).toLowerCase());
      if (index < 0) throw new Error(`The model answered "${answer.sentiment}", which is not one of: ${categories.join(', ')}`);
      const result: IDataObject = { category: categories[index], ...(detailed ? { strength: answer.strength, confidence: answer.confidence } : {}) };
      return [[index, { json: { ...deepCopy(item.json), sentimentAnalysis: result }, ...(item.binary ? { binary: item.binary } : {}) }]];
    });
  },
};

/* ---------------- Summarization Chain ---------------- */

const SUMMARY_PROMPT = `Write a concise summary of the following:


"{text}"


CONCISE SUMMARY:`;

const REFINE_PROMPT = `Your job is to produce a final summary
We have provided an existing summary up to a certain point: "{existing_answer}"
We have the opportunity to refine the existing summary
(only if needed) with some more context below.
------------
"{text}"
------------

Given the new context, refine the original summary
If the context isn't useful, return the original summary.

REFINED SUMMARY:`;

type Method = 'map_reduce' | 'stuff' | 'refine';

/** Summarizes chunks of text with one of LangChain's three strategies. */
export async function summarize(model: ChatModel, chunks: string[], method: Method, prompts: { prompt?: string; combinePrompt?: string; refinePrompt?: string }) {
  const ask = async (template: string, values: Record<string, string>) => {
    let prompt = template;
    for (const [k, v] of Object.entries(values)) prompt = prompt.replaceAll(`{${k}}`, v);
    return (await model.createSession({ tools: [] }).sendUser(prompt)).text.trim();
  };
  const prompt = prompts.prompt || SUMMARY_PROMPT;
  if (!chunks.length) return '';
  if (method === 'stuff') return ask(prompt, { text: chunks.join('\n\n') });
  if (method === 'refine') {
    let summary = await ask(prompt, { text: chunks[0] });
    for (const chunk of chunks.slice(1)) summary = await ask(prompts.refinePrompt || REFINE_PROMPT, { existing_answer: summary, text: chunk });
    return summary;
  }
  // map_reduce: summarize every chunk, then summarize the summaries
  const partial = chunks.length === 1 ? chunks : await Promise.all(chunks.map((c) => ask(prompt, { text: c })));
  return ask(prompts.combinePrompt || SUMMARY_PROMPT, { text: partial.join('\n\n') });
}

function summarizationIO(p: INodeParameters): Array<ConnectionType | INodeInputConfiguration> {
  const inputs: Array<ConnectionType | INodeInputConfiguration> = ['main', modelInput];
  if (p.operationMode === 'documentLoader') inputs.push({ type: 'ai_document', displayName: 'Document', required: true, maxConnections: 1 });
  else if ((p.options as { chunkingMode?: string } | undefined)?.chunkingMode === 'advanced') inputs.push({ type: 'ai_textSplitter', displayName: 'Text Splitter', maxConnections: 1 });
  return inputs;
}

export const SummarizationChain: INodeType = {
  description: {
    ...chainNode('chainSummarization', 'Summarization Chain', 'Summarizes text, item data or documents with a chat model', 'fa:link', ['Summarize', 'Summary', 'TL;DR', 'Condense']),
    inputs: ['main', modelInput],
    dynamicInputs: summarizationIO,
    outputs: ['main'],
    properties: [
      {
        displayName: 'Data to Summarize',
        name: 'operationMode',
        type: 'options',
        default: 'nodeInputJson',
        options: [
          { name: 'Use Node Input (JSON)', value: 'nodeInputJson', description: 'Summarize the JSON of each item' },
          { name: 'Use Document Loader', value: 'documentLoader', description: 'Load files or text with a connected Document Loader' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          {
            displayName: 'Summarization Method',
            name: 'summarizationMethod',
            type: 'options',
            default: 'map_reduce',
            options: [
              { name: 'Map Reduce (Recommended)', value: 'map_reduce', description: 'Summarize each chunk, then combine the summaries' },
              { name: 'Refine', value: 'refine', description: 'Summarize the first chunk, then refine it with each following one' },
              { name: 'Stuff', value: 'stuff', description: 'Send all the text in one prompt (short texts only)' },
            ],
          },
          { displayName: 'Summary Prompt', name: 'prompt', type: 'string', typeOptions: { rows: 6 }, default: SUMMARY_PROMPT, description: '{text} is replaced with the text to summarize' },
          { displayName: 'Combine Prompt', name: 'combinePrompt', type: 'string', typeOptions: { rows: 6 }, default: SUMMARY_PROMPT, description: 'Map Reduce: combines the summaries of the chunks ({text})', displayOptions: { show: { summarizationMethod: ['map_reduce'] } } },
          { displayName: 'Refine Prompt', name: 'refinePrompt', type: 'string', typeOptions: { rows: 8 }, default: REFINE_PROMPT, description: 'Refine: {existing_answer} is the summary so far, {text} the next chunk', displayOptions: { show: { summarizationMethod: ['refine'] } } },
          {
            displayName: 'Chunking Strategy',
            name: 'chunkingMode',
            type: 'options',
            default: 'simple',
            displayOptions: { show: { '/operationMode': ['nodeInputJson'] } },
            options: [
              { name: 'Simple (Define Below)', value: 'simple' },
              { name: 'Advanced', value: 'advanced', description: 'Use a connected Text Splitter' },
            ],
          },
          { displayName: 'Characters Per Chunk', name: 'chunkSize', type: 'number', default: 1000, displayOptions: { show: { chunkingMode: ['simple'] } } },
          { displayName: 'Chunk Overlap (Characters)', name: 'chunkOverlap', type: 'number', default: 200, displayOptions: { show: { chunkingMode: ['simple'] } } },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const mode = this.getNodeParameter('operationMode', 0, 'nodeInputJson') as string;
    return routeItems(this, 1, async (item, i) => {
      const model = (await this.getInputConnectionData('ai_languageModel', i)) as ChatModel;
      const o = this.getNodeParameter('options', i, {}) as IDataObject;
      let chunks: string[];
      if (mode === 'documentLoader') {
        const loader = (await this.getInputConnectionData('ai_document', i)) as DocumentLoader;
        chunks = (await loader.loadItem(item, i)).map((d: AiDocument) => d.pageContent);
      } else {
        const splitter =
          o.chunkingMode === 'advanced'
            ? ((await this.getInputConnectionData('ai_textSplitter', i)) as TextSplitter | undefined)
            : recursiveSplitter(Number(o.chunkSize ?? 1000), Number(o.chunkOverlap ?? 200));
        if (!splitter) throw new NodeOperationError(this.getNode(), 'Connect a Text Splitter or use the simple chunking strategy', { itemIndex: i });
        chunks = splitter.splitText(JSON.stringify(item.json));
      }
      const text = await summarize(model, chunks, (o.summarizationMethod as Method) ?? 'map_reduce', {
        prompt: o.prompt as string,
        combinePrompt: o.combinePrompt as string,
        refinePrompt: o.refinePrompt as string,
      });
      return [[0, { json: { response: { text } } }]];
    });
  },
};

export const chainNodes: INodeType[] = [InformationExtractor, TextClassifier, SentimentAnalysis, SummarizationChain];
