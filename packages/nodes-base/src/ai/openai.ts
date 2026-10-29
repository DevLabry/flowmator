import type { IDataObject, IExecuteFunctions, IHttpRequestOptions, ILoadOptionsFunctions, INodeExecutionData, INodeType } from '@8n8/workflow';
import { forEachItem, forOp, operationProp } from '../utils/api';

interface OpenAiCreds {
  apiKey: string;
  url?: string;
  organizationId?: string;
}

type Ctx = (IExecuteFunctions | ILoadOptionsFunctions) & { getCredentials<T>(type: string): Promise<T> };
type Request = Omit<IHttpRequestOptions, 'url'> & { path: string };

/** Calls the configured OpenAI-compatible endpoint; errors come back as { error: { message } }. */
async function openai<T = IDataObject>(ctx: Ctx, options: Request, i = 0): Promise<T> {
  const c = await ctx.getCredentials<OpenAiCreds>('openAiApi');
  const { path, ...rest } = options;
  try {
    return (await ctx.helpers.httpRequestWithAuthentication(
      'openAiApi',
      {
        json: true,
        ...rest,
        url: `${(c.url || 'https://api.openai.com/v1').replace(/\/$/, '')}${path}`,
        headers: { ...(c.organizationId ? { 'OpenAI-Organization': c.organizationId } : {}), ...(rest.headers ?? {}) },
      },
      i,
    )) as T;
  } catch (e) {
    const err = (e as { body?: { error?: { message?: string } } }).body?.error;
    if (err?.message) throw new Error(`OpenAI error: ${err.message}`);
    throw e;
  }
}

/** Chat Completions content: text, or the first text part when the model returns parts. */
const textOf = (content: unknown) => (Array.isArray(content) ? content.map((p) => (p as IDataObject).text ?? '').join('') : String(content ?? ''));

export const OpenAi: INodeType = {
  description: {
    name: '8n8-ai.openAi',
    displayName: 'OpenAI',
    description: 'Message models, analyze and generate images, and generate or transcribe audio with OpenAI',
    group: ['transform'],
    version: [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8],
    defaults: { name: 'OpenAI', color: '#10a37f' },
    icon: 'fa:robot',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'openAiApi', required: true }],
    codex: { categories: ['AI'], subcategories: { AI: ['Root Nodes'] }, alias: ['ChatGPT', 'GPT', 'DALL-E', 'Whisper', 'LLM'] },
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'text',
        options: [{ name: 'Text', value: 'text' }, { name: 'Image', value: 'image' }, { name: 'Audio', value: 'audio' }],
      },
      operationProp('text', [{ name: 'Message a Model', value: 'message' }, { name: 'Classify Text for Violations', value: 'classify' }]),
      operationProp('image', [{ name: 'Generate an Image', value: 'generate' }, { name: 'Analyze Image', value: 'analyze' }]),
      operationProp('audio', [{ name: 'Generate Audio', value: 'generate' }, { name: 'Transcribe a Recording', value: 'transcribe' }, { name: 'Translate a Recording', value: 'translate' }]),

      // text: message
      ...forOp('text', 'message', [
        { displayName: 'Model', name: 'modelId', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getChatModels' } },
        {
          displayName: 'Messages',
          name: 'messages',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: { values: [{ role: 'user', content: '' }] },
          options: [
            {
              name: 'values',
              displayName: 'Message',
              values: [
                { displayName: 'Role', name: 'role', type: 'options', default: 'user', options: [{ name: 'User', value: 'user' }, { name: 'Assistant', value: 'assistant' }, { name: 'System', value: 'system' }] },
                { displayName: 'Text', name: 'content', type: 'string', typeOptions: { rows: 3 }, default: '' },
              ],
            },
          ],
        },
        { displayName: 'Simplify Output', name: 'simplify', type: 'boolean', default: true, description: 'Only the reply instead of the whole API response' },
        { displayName: 'Output Content as JSON', name: 'jsonOutput', type: 'boolean', default: false, description: 'Ask for a JSON object and parse it (mention JSON in your messages)' },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Maximum Number of Tokens', name: 'maxTokens', type: 'number', default: 0, description: '0 = model default' },
            { displayName: 'Reasoning Effort', name: 'reasoningEffort', type: 'options', default: '', options: [{ name: 'Model Default', value: '' }, { name: 'Low', value: 'low' }, { name: 'Medium', value: 'medium' }, { name: 'High', value: 'high' }], description: 'Reasoning models only' },
            { displayName: 'Sampling Temperature', name: 'temperature', type: 'number', default: 1, typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 }, description: 'Not supported by reasoning models' },
            { displayName: 'Top P', name: 'topP', type: 'number', default: 1, typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 } },
            { displayName: 'Frequency Penalty', name: 'frequencyPenalty', type: 'number', default: 0 },
            { displayName: 'Presence Penalty', name: 'presencePenalty', type: 'number', default: 0 },
            { displayName: 'Number of Completions', name: 'n', type: 'number', default: 1, typeOptions: { minValue: 1 } },
          ],
        },
      ]),
      ...forOp('text', 'classify', [
        { displayName: 'Text Input', name: 'input', type: 'string', typeOptions: { rows: 3 }, default: '' },
        { displayName: 'Model', name: 'moderationModel', type: 'string', default: 'omni-moderation-latest' },
        { displayName: 'Simplify Output', name: 'simplify', type: 'boolean', default: true },
      ]),

      // image
      ...forOp('image', 'generate', [
        { displayName: 'Model', name: 'imageModel', type: 'string', default: 'gpt-image-1', description: 'e.g. gpt-image-1, dall-e-3' },
        { displayName: 'Prompt', name: 'prompt', type: 'string', typeOptions: { rows: 3 }, default: '' },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Size', name: 'size', type: 'options', default: '1024x1024', options: ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', 'auto'].map((s) => ({ name: s, value: s })) },
            { displayName: 'Quality', name: 'quality', type: 'options', default: 'auto', options: ['auto', 'low', 'medium', 'high', 'standard', 'hd'].map((q) => ({ name: q, value: q })) },
            { displayName: 'Number of Images', name: 'n', type: 'number', default: 1, typeOptions: { minValue: 1, maxValue: 10 } },
            { displayName: 'Put Output in Field', name: 'binaryPropertyOutput', type: 'string', default: 'data' },
          ],
        },
      ]),
      ...forOp('image', 'analyze', [
        { displayName: 'Model', name: 'modelId', type: 'options', default: '', required: true, typeOptions: { loadOptionsMethod: 'getChatModels' } },
        { displayName: 'Text Input', name: 'text', type: 'string', typeOptions: { rows: 2 }, default: "What's in this image?" },
        { displayName: 'Input Type', name: 'inputType', type: 'options', default: 'url', options: [{ name: 'Image URL(s)', value: 'url' }, { name: 'Binary File(s)', value: 'base64' }] },
        { displayName: 'URL(s)', name: 'imageUrls', type: 'string', default: '', displayOptions: { show: { inputType: ['url'] } }, description: 'Comma separated' },
        { displayName: 'Input Data Field Name(s)', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { inputType: ['base64'] } }, description: 'Comma separated' },
        { displayName: 'Simplify Output', name: 'simplify', type: 'boolean', default: true },
        { displayName: 'Options', name: 'options', type: 'collection', default: {}, options: [{ displayName: 'Detail', name: 'detail', type: 'options', default: 'auto', options: ['auto', 'low', 'high'].map((d) => ({ name: d, value: d })) }, { displayName: 'Maximum Number of Tokens', name: 'maxTokens', type: 'number', default: 0 }] },
      ]),

      // audio
      ...forOp('audio', 'generate', [
        { displayName: 'Model', name: 'ttsModel', type: 'string', default: 'gpt-4o-mini-tts', description: 'e.g. gpt-4o-mini-tts, tts-1, tts-1-hd' },
        { displayName: 'Text Input', name: 'input', type: 'string', typeOptions: { rows: 3 }, default: '' },
        { displayName: 'Voice', name: 'voice', type: 'options', default: 'alloy', options: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((v) => ({ name: v, value: v })) },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Response Format', name: 'response_format', type: 'options', default: 'mp3', options: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].map((f) => ({ name: f, value: f })) },
            { displayName: 'Speed', name: 'speed', type: 'number', default: 1, typeOptions: { minValue: 0.25, maxValue: 4, numberPrecision: 2 } },
            { displayName: 'Instructions', name: 'instructions', type: 'string', default: '', description: 'Tone and style (gpt-4o-mini-tts only)' },
            { displayName: 'Put Output in Field', name: 'binaryPropertyOutput', type: 'string', default: 'data' },
          ],
        },
      ]),
      ...forOp('audio', ['transcribe', 'translate'], [
        { displayName: 'Model', name: 'sttModel', type: 'string', default: 'whisper-1', description: 'e.g. whisper-1, gpt-4o-transcribe (transcribe only)' },
        { displayName: 'Input Data Field Name', name: 'binaryPropertyName', type: 'string', default: 'data' },
        {
          displayName: 'Options',
          name: 'options',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Language of the Audio (ISO-639-1)', name: 'language', type: 'string', default: '', displayOptions: { show: { '/operation': ['transcribe'] } } },
            { displayName: 'Prompt', name: 'prompt', type: 'string', default: '', description: 'Spelling of names and terms, or the previous segment' },
            { displayName: 'Output Randomness (Temperature)', name: 'temperature', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 1 } },
          ],
        },
      ]),
    ],
  },
  methods: {
    loadOptions: {
      async getChatModels(this: ILoadOptionsFunctions) {
        const r = await openai<{ data: Array<{ id: string }> }>(this as Ctx, { path: '/models' });
        // the official API also lists embedding, audio and image models
        const skip = /embedding|whisper|tts|dall-e|image|moderation|transcribe|realtime|audio|search|davinci|babbage/i;
        return r.data.filter((m) => !skip.test(m.id)).map((m) => ({ name: m.id, value: m.id })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i, item) => {
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = <T = IDataObject>(options: Request) => openai<T>(this as Ctx, options, i);
        const resource = p('resource');
        const op = p('operation');
        const options = p<IDataObject>('options', {});
        const binaryOut = String(options.binaryPropertyOutput ?? 'data');

        if (resource === 'text' && op === 'classify') {
          const r = await call({ path: '/moderations', method: 'POST', body: { model: p('moderationModel', 'omni-moderation-latest'), input: p('input') } });
          if (!p('simplify', true)) return r;
          const result = (r.results as IDataObject[])[0];
          return { flagged: result.flagged, categories: result.categories, category_scores: result.category_scores };
        }

        if ((resource === 'text' && op === 'message') || (resource === 'image' && op === 'analyze')) {
          let messages: IDataObject[];
          if (resource === 'text') {
            messages = ((p<IDataObject>('messages', {}).values as Array<{ role: string; content: string }>) ?? []).filter((m) => m.content).map(({ role, content }) => ({ role, content }));
            if (!messages.length) throw new Error('Add at least one message');
          } else {
            const detail = String(options.detail ?? 'auto');
            const images: string[] = [];
            if (p('inputType', 'url') === 'url') images.push(...p('imageUrls', '').split(',').map((u) => u.trim()).filter(Boolean));
            else {
              for (const prop of p('binaryPropertyName', 'data').split(',').map((s) => s.trim()).filter(Boolean)) {
                const bin = this.helpers.assertBinaryData(i, prop);
                images.push(`data:${bin.mimeType};base64,${(await this.helpers.getBinaryDataBuffer(i, prop)).toString('base64')}`);
              }
            }
            if (!images.length) throw new Error('No image to analyze');
            messages = [{ role: 'user', content: [{ type: 'text', text: p('text') }, ...images.map((url) => ({ type: 'image_url', image_url: { url, detail } }))] }];
          }
          const body: IDataObject = { model: p('modelId'), messages };
          if (Number(options.maxTokens) > 0) body.max_completion_tokens = Number(options.maxTokens);
          // only what the user changed: reasoning models reject sampling parameters
          if (options.temperature !== undefined) body.temperature = options.temperature;
          if (options.topP !== undefined) body.top_p = options.topP;
          if (options.frequencyPenalty) body.frequency_penalty = options.frequencyPenalty;
          if (options.presencePenalty) body.presence_penalty = options.presencePenalty;
          if (Number(options.n) > 1) body.n = Number(options.n);
          if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
          const json = resource === 'text' && p('jsonOutput', false);
          if (json) body.response_format = { type: 'json_object' };
          const r = await call({ path: '/chat/completions', method: 'POST', body });
          if (!p('simplify', true)) return r;
          return (r.choices as IDataObject[]).map((choice) => {
            const message = choice.message as IDataObject;
            let content: IDataObject['x'] = textOf(message.content);
            if (json) {
              try {
                content = JSON.parse(String(content)) as IDataObject;
              } catch {
                // keep the text: the model ignored the JSON instruction
              }
            }
            const reply: IDataObject = resource === 'text' ? { index: choice.index, message: { role: message.role, content, ...(message.refusal ? { refusal: message.refusal } : {}) }, finish_reason: choice.finish_reason } : { content };
            return reply;
          });
        }

        if (resource === 'image') {
          const model = p('imageModel', 'gpt-image-1');
          const body: IDataObject = { model, prompt: p('prompt'), n: Number(options.n ?? 1) };
          if (options.size) body.size = options.size;
          if (options.quality && options.quality !== 'auto') body.quality = options.quality;
          // gpt-image models always return base64; DALL-E needs asking for it
          if (model.startsWith('dall-e')) body.response_format = 'b64_json';
          const r = await call({ path: '/images/generations', method: 'POST', body });
          const out: INodeExecutionData[] = [];
          for (const [n, img] of ((r.data as IDataObject[]) ?? []).entries()) {
            const data = Buffer.from(String(img.b64_json), 'base64');
            out.push({ json: { ...(img.revised_prompt ? { revised_prompt: img.revised_prompt } : {}) }, binary: { [binaryOut]: await this.helpers.prepareBinaryData(data, `image-${n + 1}.png`, 'image/png') } });
          }
          return out;
        }

        // audio
        if (op === 'generate') {
          const format = String(options.response_format ?? 'mp3');
          const body: IDataObject = { model: p('ttsModel', 'gpt-4o-mini-tts'), input: p('input'), voice: p('voice', 'alloy'), response_format: format };
          if (options.speed !== undefined && Number(options.speed) !== 1) body.speed = options.speed;
          if (options.instructions) body.instructions = options.instructions;
          const audio = await call<Buffer>({ path: '/audio/speech', method: 'POST', body, encoding: 'arraybuffer', json: false, headers: { 'Content-Type': 'application/json' } });
          const mime = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' }[format] ?? 'audio/mpeg';
          const out: INodeExecutionData = { json: { ...item.json }, binary: { ...(item.binary ?? {}), [binaryOut]: await this.helpers.prepareBinaryData(audio, `audio.${format}`, mime) } };
          return out;
        }
        const prop = p('binaryPropertyName', 'data');
        const bin = this.helpers.assertBinaryData(i, prop);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(await this.helpers.getBinaryDataBuffer(i, prop))], { type: bin.mimeType }), bin.fileName ?? `audio.${bin.fileExtension ?? 'mp3'}`);
        form.append('model', p('sttModel', 'whisper-1'));
        if (op === 'transcribe' && options.language) form.append('language', String(options.language));
        if (options.prompt) form.append('prompt', String(options.prompt));
        if (options.temperature) form.append('temperature', String(options.temperature));
        return call({ path: op === 'transcribe' ? '/audio/transcriptions' : '/audio/translations', method: 'POST', body: form });
      }),
    ];
  },
};
