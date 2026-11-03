import { load } from 'cheerio';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { marked } from 'marked';
import TurndownService from 'turndown';
import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType } from '@flowmator/workflow';
import { deepCopy, errorItem, getValue, setValue } from '../utils/object';

/** Runs `fn` per item with continue-on-fail handling and pairedItem set. */
async function perItem(ctx: IExecuteFunctions, fn: (item: INodeExecutionData, i: number) => Promise<INodeExecutionData | INodeExecutionData[]>) {
  const out: INodeExecutionData[] = [];
  const items = ctx.getInputData();
  for (let i = 0; i < items.length; i++) {
    try {
      const r = await fn(items[i], i);
      for (const item of Array.isArray(r) ? r : [r]) out.push({ ...item, pairedItem: item.pairedItem ?? { item: i } });
    } catch (e) {
      if (ctx.continueOnFail()) out.push(errorItem(e, i));
      else throw e instanceof NodeOperationError ? e : new NodeOperationError(ctx.getNode(), e as Error, { itemIndex: i });
    }
  }
  return out;
}

/* ---------------- XML ---------------- */

export const Xml: INodeType = {
  description: {
    name: 'flowmator.xml',
    displayName: 'XML',
    description: 'Converts data between JSON and XML',
    group: ['transform'],
    version: 1,
    defaults: { name: 'XML', color: '#333377' },
    icon: 'fa:file-code',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Mode', name: 'mode', type: 'options', default: 'xmlToJson', options: [{ name: 'JSON to XML', value: 'jsonToxml' }, { name: 'XML to JSON', value: 'xmlToJson' }] },
      { displayName: 'Property Name', name: 'dataPropertyName', type: 'string', default: 'data', description: 'Field holding the XML (XML to JSON) or receiving it (JSON to XML)' },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Attribute Prefix', name: 'attrkey', type: 'string', default: '$', description: 'Prefix for attribute keys' },
          { displayName: 'Text Key', name: 'charkey', type: 'string', default: '_', description: 'Key for text content of elements that also have attributes' },
          { displayName: 'Ignore Attributes', name: 'ignoreAttrs', type: 'boolean', default: false },
          { displayName: 'Always Use Arrays', name: 'explicitArray', type: 'boolean', default: false },
          { displayName: 'Parse Numbers and Booleans', name: 'parseValues', type: 'boolean', default: false },
          { displayName: 'Trim Text', name: 'trim', type: 'boolean', default: true },
          { displayName: 'Root Name', name: 'rootName', type: 'string', default: 'root', description: 'JSON to XML: wrapper element when the object has several top-level keys' },
          { displayName: 'Headless', name: 'headless', type: 'boolean', default: false, description: 'JSON to XML: omit the <?xml?> header' },
          { displayName: 'Pretty Print', name: 'pretty', type: 'boolean', default: true },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      await perItem(this, async (item, i) => {
        const mode = this.getNodeParameter('mode', i) as string;
        const prop = this.getNodeParameter('dataPropertyName', i) as string;
        const o = this.getNodeParameter('options', i, {}) as IDataObject;
        const attrPrefix = String(o.attrkey ?? '$');
        const textKey = String(o.charkey ?? '_');
        if (mode === 'xmlToJson') {
          const xml = getValue(item.json, prop);
          if (typeof xml !== 'string') throw new Error(`Item has no XML string in property "${prop}"`);
          const parser = new XMLParser({
            ignoreAttributes: !!o.ignoreAttrs,
            attributeNamePrefix: attrPrefix,
            textNodeName: textKey,
            parseTagValue: !!o.parseValues,
            parseAttributeValue: !!o.parseValues,
            trimValues: o.trim !== false,
            isArray: () => !!o.explicitArray,
            ignoreDeclaration: true,
          });
          return { json: parser.parse(xml) as IDataObject };
        }
        let data: IDataObject = deepCopy(item.json);
        if (Object.keys(data).length !== 1) data = { [String(o.rootName || 'root')]: data };
        const builder = new XMLBuilder({ ignoreAttributes: !!o.ignoreAttrs, attributeNamePrefix: attrPrefix, textNodeName: textKey, format: o.pretty !== false, indentBy: '  ', suppressEmptyNode: true });
        const body = builder.build(data) as string;
        return { json: { [prop]: o.headless ? body : `<?xml version="1.0" encoding="UTF-8"?>\n${body}` } };
      }),
    ];
  },
};

/* ---------------- HTML ---------------- */

interface Extraction {
  key: string;
  cssSelector: string;
  returnValue: 'attribute' | 'html' | 'text' | 'value';
  attribute?: string;
  skipSelectors?: string;
  returnArray?: boolean;
}

const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const Html: INodeType = {
  description: {
    name: 'flowmator.html',
    displayName: 'HTML',
    description: 'Builds HTML from a template, extracts content with CSS selectors, or turns items into a table',
    group: ['transform'],
    version: [1, 1.1, 1.2],
    defaults: { name: 'HTML', color: '#333377' },
    icon: 'fa:code',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'generateHtmlTemplate',
        options: [
          { name: 'Generate HTML Template', value: 'generateHtmlTemplate' },
          { name: 'Extract HTML Content', value: 'extractHtmlContent' },
          { name: 'Convert to HTML Table', value: 'convertToHtmlTable' },
        ],
      },
      { displayName: 'HTML Template', name: 'html', type: 'string', typeOptions: { editor: 'htmlEditor', editorLanguage: 'html' }, default: '<!DOCTYPE html>\n<html>\n<body>\n  <h1>{{ $json.title }}</h1>\n</body>\n</html>', displayOptions: { show: { operation: ['generateHtmlTemplate'] } }, hint: 'Use {{ }} expressions; they are evaluated per item' },
      { displayName: 'Source Data', name: 'sourceData', type: 'options', default: 'json', displayOptions: { show: { operation: ['extractHtmlContent'] } }, options: [{ name: 'JSON', value: 'json' }, { name: 'Binary', value: 'binary' }] },
      { displayName: 'Property Name', name: 'dataPropertyName', type: 'string', default: 'data', displayOptions: { show: { operation: ['extractHtmlContent'] } } },
      {
        displayName: 'Extraction Values',
        name: 'extractionValues',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        displayOptions: { show: { operation: ['extractHtmlContent'] } },
        options: [
          {
            name: 'values',
            displayName: 'Values',
            values: [
              { displayName: 'Key', name: 'key', type: 'string', default: '' },
              { displayName: 'CSS Selector', name: 'cssSelector', type: 'string', default: '', placeholder: '.price, h1, a[href]' },
              { displayName: 'Return Value', name: 'returnValue', type: 'options', default: 'text',
                options: [{ name: 'Attribute', value: 'attribute' }, { name: 'HTML', value: 'html' }, { name: 'Text', value: 'text' }, { name: 'Value', value: 'value' }] },
              { displayName: 'Attribute', name: 'attribute', type: 'string', default: '', displayOptions: { show: { returnValue: ['attribute'] } } },
              { displayName: 'Skip Selectors', name: 'skipSelectors', type: 'string', default: '', displayOptions: { show: { returnValue: ['text'] } } },
              { displayName: 'Return Array', name: 'returnArray', type: 'boolean', default: false },
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
          { displayName: 'Trim Values', name: 'trimValues', type: 'boolean', default: true },
          { displayName: 'Clean Up Text', name: 'cleanUpText', type: 'boolean', default: true, description: 'Collapse whitespace and line breaks' },
          { displayName: 'Capitalize Headers', name: 'capitalize', type: 'boolean', default: false },
          { displayName: 'Table Caption', name: 'caption', type: 'string', default: '' },
          { displayName: 'Table Attributes', name: 'tableAttributes', type: 'string', default: '', placeholder: 'class="report" border="1"' },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const op = this.getNodeParameter('operation', 0) as string;
    if (op === 'convertToHtmlTable') {
      const items = this.getInputData();
      const o = this.getNodeParameter('options', 0, {}) as IDataObject;
      const cols = [...new Set(items.flatMap((i) => Object.keys(i.json)))];
      const head = cols.map((c) => `<th>${escapeHtml(o.capitalize ? c.charAt(0).toUpperCase() + c.slice(1) : c)}</th>`).join('');
      const rows = items.map((i) => `<tr>${cols.map((c) => `<td>${escapeHtml(typeof i.json[c] === 'object' ? JSON.stringify(i.json[c]) : i.json[c])}</td>`).join('')}</tr>`).join('\n');
      const caption = o.caption ? `<caption>${escapeHtml(o.caption)}</caption>` : '';
      const table = `<table${o.tableAttributes ? ` ${o.tableAttributes}` : ''}>${caption}<thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table>`;
      return [[{ json: { table }, pairedItem: items.map((_, i) => ({ item: i })) }]];
    }
    return [
      await perItem(this, async (item, i) => {
        if (op === 'generateHtmlTemplate') {
          // the template is always evaluated, whether or not it was saved as an expression
          const raw = String(this.getNodeParameter('html', i, '', { rawExpressions: true }) ?? '');
          return { json: { ...deepCopy(item.json), html: String(this.evaluateExpression(raw, i) ?? '') } };
        }
        const prop = this.getNodeParameter('dataPropertyName', i) as string;
        const html = this.getNodeParameter('sourceData', i) === 'binary'
          ? (await this.helpers.getBinaryDataBuffer(i, prop)).toString('utf8')
          : getValue(item.json, prop);
        if (typeof html !== 'string') throw new Error(`Item has no HTML string in property "${prop}"`);
        const o = this.getNodeParameter('options', i, {}) as IDataObject;
        const $ = load(html);
        const json: IDataObject = {};
        for (const ex of (this.getNodeParameter('extractionValues.values', i, []) as Extraction[])) {
          const clean = (v: string | undefined) => {
            let s = v ?? '';
            if (o.cleanUpText !== false) s = s.replace(/\s+/g, ' ');
            return o.trimValues !== false ? s.trim() : s;
          };
          const valueOf = (el: Parameters<typeof $>[0]) => {
            const node = $(el);
            switch (ex.returnValue) {
              case 'attribute':
                return node.attr(ex.attribute ?? '');
              case 'html':
                return node.html() ?? '';
              case 'value':
                return node.val() as string | undefined;
              default: {
                const copy = node.clone();
                if (ex.skipSelectors) copy.find(ex.skipSelectors).remove();
                return clean(copy.text());
              }
            }
          };
          const els = $(ex.cssSelector).toArray();
          json[ex.key] = (ex.returnArray ? els.map(valueOf) : els.length ? valueOf(els[0]) : undefined) as never;
        }
        return { json };
      }),
    ];
  },
};

/* ---------------- Markdown ---------------- */

export const Markdown: INodeType = {
  description: {
    name: 'flowmator.markdown',
    displayName: 'Markdown',
    description: 'Converts between Markdown and HTML',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Markdown', color: '#000000' },
    icon: 'fa:markdown',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Mode', name: 'mode', type: 'options', default: 'htmlToMarkdown', options: [{ name: 'Markdown to HTML', value: 'markdownToHtml' }, { name: 'HTML to Markdown', value: 'htmlToMarkdown' }] },
      { displayName: 'HTML', name: 'html', type: 'string', default: '', displayOptions: { show: { mode: ['htmlToMarkdown'] } } },
      { displayName: 'Markdown', name: 'markdown', type: 'string', typeOptions: { rows: 4 }, default: '', displayOptions: { show: { mode: ['markdownToHtml'] } } },
      { displayName: 'Destination Key', name: 'destinationKey', type: 'string', default: 'data' },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Heading Style (HTML → MD)', name: 'headingStyle', type: 'options', default: 'atx', options: [{ name: '# ATX', value: 'atx' }, { name: 'Setext (underlined)', value: 'setext' }] },
          { displayName: 'Bullet Marker (HTML → MD)', name: 'bulletListMarker', type: 'options', default: '*', options: ['*', '-', '+'].map((m) => ({ name: m, value: m })) },
          { displayName: 'Code Block Style (HTML → MD)', name: 'codeBlockStyle', type: 'options', default: 'fenced', options: [{ name: 'Fenced', value: 'fenced' }, { name: 'Indented', value: 'indented' }] },
          { displayName: 'GitHub Flavored (MD → HTML)', name: 'gfm', type: 'boolean', default: true },
          { displayName: 'Line Breaks as <br> (MD → HTML)', name: 'breaks', type: 'boolean', default: false },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      await perItem(this, async (item, i) => {
        const mode = this.getNodeParameter('mode', i) as string;
        const dest = this.getNodeParameter('destinationKey', i) as string;
        const o = this.getNodeParameter('options', i, {}) as IDataObject;
        let value: string;
        if (mode === 'markdownToHtml') {
          value = await marked.parse(String(this.getNodeParameter('markdown', i) ?? ''), { gfm: o.gfm !== false, breaks: !!o.breaks });
        } else {
          const td = new TurndownService({
            headingStyle: (o.headingStyle as 'atx' | 'setext') ?? 'atx',
            bulletListMarker: (o.bulletListMarker as '*' | '-' | '+') ?? '*',
            codeBlockStyle: (o.codeBlockStyle as 'fenced' | 'indented') ?? 'fenced',
          });
          value = td.turndown(String(this.getNodeParameter('html', i) ?? ''));
        }
        const json = deepCopy(item.json);
        setValue(json, dest, value);
        return { json, ...(item.binary ? { binary: item.binary } : {}) };
      }),
    ];
  },
};

export { perItem };
