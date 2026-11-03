import type { IDataObject, INodeType, ISupplyDataFunctions } from '@flowmator/workflow';
import type { ToolSpec } from './llm';
import { subNode } from './subnodes';

/* ---------------- Think ---------------- */

const THINK_DESCRIPTION =
  'Use the tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.';

export const ThinkTool: INodeType = {
  description: {
    ...subNode('toolThink', 'Think Tool', 'Gives the agent a place to reason step by step before acting', 'ai_tool', 'fa:brain'),
    properties: [{ displayName: 'Think Tool Description', name: 'description', type: 'string', typeOptions: { rows: 3 }, default: THINK_DESCRIPTION }],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const tool: ToolSpec = {
      name: 'think',
      description: String(this.getNodeParameter('description', itemIndex, THINK_DESCRIPTION) || THINK_DESCRIPTION),
      inputSchema: { type: 'object', properties: { thought: { type: 'string', description: 'Your thoughts' } }, required: ['thought'] },
      async invoke(input) {
        return String(input.thought ?? input.input ?? '');
      },
    };
    return { response: tool };
  },
};

/* ---------------- Wikipedia ---------------- */

const USER_AGENT = 'Flowmator workflow automation (https://github.com/flowmator)';

export const WikipediaTool: INodeType = {
  description: {
    ...subNode('toolWikipedia', 'Wikipedia', 'Lets the agent look things up on Wikipedia', 'ai_tool', 'fa:wikipedia-w'),
    properties: [
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Language', name: 'language', type: 'string', default: 'en', description: 'Wikipedia language code, e.g. en, es, de' },
          { displayName: 'Number of Pages', name: 'topKResults', type: 'number', default: 3, typeOptions: { minValue: 1, maxValue: 10 } },
          { displayName: 'Max Characters per Page', name: 'maxDocContentLength', type: 'number', default: 4000 },
        ],
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const o = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
    const lang = String(o.language || 'en').replace(/[^a-z-]/gi, '');
    const k = Math.max(1, Number(o.topKResults ?? 3));
    const maxChars = Math.max(100, Number(o.maxDocContentLength ?? 4000));
    const api = `https://${lang}.wikipedia.org/w/api.php`;
    const helpers = this.helpers;
    const get = (qs: IDataObject) => helpers.httpRequest({ url: api, qs: { format: 'json', formatversion: 2, ...qs }, headers: { 'user-agent': USER_AGENT }, json: true }) as Promise<IDataObject>;
    const tool: ToolSpec = {
      name: 'wikipedia',
      description: 'A tool for interacting with and fetching data from the Wikipedia API. The input should always be a string query.',
      inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'What to search for' } }, required: ['input'] },
      async invoke(input) {
        const query = String(input.input ?? input.query ?? '').trim();
        if (!query) return 'Give a search query.';
        const found = ((await get({ action: 'query', list: 'search', srsearch: query, srlimit: k })).query as { search?: Array<{ title: string }> })?.search ?? [];
        if (!found.length) return 'No good Wikipedia Search Result was found';
        const pages: string[] = [];
        for (const { title } of found) {
          const res = (await get({ action: 'query', prop: 'extracts', explaintext: 1, redirects: 1, titles: title })).query as { pages?: Array<{ title: string; extract?: string }> };
          const page = res?.pages?.[0];
          if (page?.extract) pages.push(`Page: ${page.title}\nSummary: ${page.extract.slice(0, maxChars)}`);
        }
        return pages.join('\n\n') || 'No good Wikipedia Search Result was found';
      },
    };
    return { response: tool };
  },
};

/* ---------------- SerpAPI (Google Search) ---------------- */

interface SerpResult {
  error?: string;
  answer_box?: { answer?: string; snippet?: string; snippet_highlighted_words?: string[]; result?: string };
  sports_results?: { game_spotlight?: string };
  knowledge_graph?: { title?: string; type?: string; description?: string };
  organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
}

/** The useful part of a Google result page, most direct answer first. */
export function serpSummary(r: SerpResult, maxResults = 5) {
  if (r.error) throw new Error(`SerpAPI: ${r.error}`);
  const lines: string[] = [];
  const box = r.answer_box;
  const direct = box?.answer ?? box?.result ?? box?.snippet_highlighted_words?.join(', ') ?? box?.snippet;
  if (direct) lines.push(`Answer: ${direct}`);
  if (r.sports_results?.game_spotlight) lines.push(`Sports: ${r.sports_results.game_spotlight}`);
  const kg = r.knowledge_graph;
  if (kg?.description) lines.push(`${kg.title ?? ''}${kg.type ? ` (${kg.type})` : ''}: ${kg.description}`);
  for (const o of (r.organic_results ?? []).slice(0, maxResults)) lines.push(`- ${o.title ?? ''}\n  ${o.link ?? ''}\n  ${o.snippet ?? ''}`.trimEnd());
  return lines.join('\n') || 'No good search result found';
}

export const SerpApiTool: INodeType = {
  description: {
    ...subNode('toolSerpApi', 'SerpApi (Google Search)', 'Lets the agent search Google through SerpApi', 'ai_tool', 'fa:search'),
    credentials: [{ name: 'serpApi', required: true }],
    properties: [
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Country', name: 'gl', type: 'string', default: 'us', description: 'Two-letter country code (gl)' },
          { displayName: 'Device', name: 'device', type: 'options', default: 'desktop', options: ['desktop', 'mobile', 'tablet'].map((d) => ({ name: d[0].toUpperCase() + d.slice(1), value: d })) },
          { displayName: 'Skip Cache', name: 'no_cache', type: 'boolean', default: false, description: 'Skip the SerpApi cache' },
          { displayName: 'Google Domain', name: 'google_domain', type: 'string', default: 'google.com' },
          { displayName: 'Language', name: 'hl', type: 'string', default: 'en', description: 'Two-letter language code (hl)' },
          { displayName: 'Number of Results', name: 'num', type: 'number', default: 5 },
        ],
      },
    ],
  },
  async supplyData(this: ISupplyDataFunctions, itemIndex: number) {
    const { apiKey } = await this.getCredentials<{ apiKey: string }>('serpApi');
    const o = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
    const helpers = this.helpers;
    const tool: ToolSpec = {
      name: 'serpapi',
      description: 'A search engine. Useful for when you need to answer questions about current events. Input should be a search query.',
      inputSchema: { type: 'object', properties: { input: { type: 'string', description: 'The search query' } }, required: ['input'] },
      async invoke(input) {
        const q = String(input.input ?? input.query ?? '').trim();
        const { num, ...rest } = o;
        const res = (await helpers.httpRequest({
          url: 'https://serpapi.com/search.json',
          qs: { engine: 'google', q, api_key: apiKey, ...rest, ...(num ? { num } : {}) },
          json: true,
          ignoreHttpStatusErrors: true,
        })) as SerpResult;
        return serpSummary(res, Number(num) || 5);
      },
    };
    return { response: tool };
  },
};

export const toolNodes: INodeType[] = [ThinkTool, WikipediaTool, SerpApiTool];
