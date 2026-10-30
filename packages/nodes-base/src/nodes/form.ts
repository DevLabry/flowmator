import type { IDataObject, IExecuteFunctions, INode, INodeExecutionData, INodeProperties, INodeType, IWebhookFunctions, IWebhookResult } from '@8n8/workflow';

export interface FormField {
  fieldLabel: string;
  fieldType?: 'text' | 'textarea' | 'number' | 'email' | 'password' | 'date' | 'dropdown' | 'checkbox' | 'file';
  placeholder?: string;
  requiredField?: boolean;
  fieldOptions?: { values?: Array<{ option: string }> };
  multiselect?: boolean;
  multipleFiles?: boolean;
  acceptFileTypes?: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fieldName = (i: number) => `field-${i}`;

const PAGE_CSS = `
:root{--bg:#f6f6f9;--card:#fff;--text:#1d1d27;--muted:#5b5b6e;--border:#dcdce5;--accent:#5b5bd6;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#15151c;--card:#1e1e27;--text:#ececf3;--muted:#a9a9bb;--border:#33333f;--accent:#7b7bf0;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;justify-content:center;padding:40px 16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;width:100%;max-width:520px}
h1{font-size:22px;margin:0 0 6px}p.desc{color:var(--muted);margin:0 0 22px;white-space:pre-wrap}
label{display:block;font-weight:600;font-size:13px;margin:16px 0 6px}.req{color:#d63e3e}
input,select,textarea{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 11px}
textarea{min-height:90px}.opt{display:flex;gap:8px;align-items:center;font-weight:400;margin:4px 0}.opt input{width:auto}
button{margin-top:24px;width:100%;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:11px;font:inherit;font-weight:600;cursor:pointer}
.done{text-align:center}`;

export function renderPage(title: string, inner: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><div class="card">${inner}</div></body></html>`;
}

/** HTML for a form; it posts back (multipart) to the URL it was served from. */
export function renderForm(opts: { title?: string; description?: string; fields: FormField[]; buttonLabel?: string }) {
  const fields = opts.fields
    .map((f, i) => {
      const name = fieldName(i);
      const req = f.requiredField ? ' required' : '';
      const label = `<label for="${name}">${esc(f.fieldLabel)}${f.requiredField ? ' <span class="req">*</span>' : ''}</label>`;
      const options = f.fieldOptions?.values ?? [];
      switch (f.fieldType) {
        case 'textarea':
          return `${label}<textarea id="${name}" name="${name}" placeholder="${esc(f.placeholder)}"${req}></textarea>`;
        case 'dropdown':
          return `${label}<select id="${name}" name="${name}"${f.multiselect ? ' multiple' : ''}${req}>${f.multiselect ? '' : '<option value="">Select…</option>'}${options.map((o) => `<option>${esc(o.option)}</option>`).join('')}</select>`;
        case 'checkbox':
          return `${label}${options.map((o) => `<div class="opt"><input type="checkbox" name="${name}" value="${esc(o.option)}"> ${esc(o.option)}</div>`).join('')}`;
        case 'file':
          return `${label}<input type="file" id="${name}" name="${name}"${f.multipleFiles ? ' multiple' : ''}${f.acceptFileTypes ? ` accept="${esc(f.acceptFileTypes)}"` : ''}${req}>`;
        default:
          return `${label}<input type="${f.fieldType ?? 'text'}" id="${name}" name="${name}" placeholder="${esc(f.placeholder)}"${req}>`;
      }
    })
    .join('');
  return renderPage(
    opts.title || 'Form',
    `<h1>${esc(opts.title)}</h1>${opts.description ? `<p class="desc">${esc(opts.description)}</p>` : ''}<form method="POST" enctype="multipart/form-data">${fields}<button type="submit">${esc(opts.buttonLabel || 'Submit')}</button></form>`,
  );
}

export function renderSubmitted(title: string, message?: string) {
  return renderPage(title || 'Form', `<div class="done"><h1>${esc(title || 'Thanks!')}</h1><p class="desc">${esc(message || 'Your response has been recorded')}</p></div>`);
}

/** Maps posted fields (field-0, field-1…) back to their labels; files become binary data. */
export async function parseSubmission(
  body: unknown,
  files: Array<{ fieldName: string; fileName: string; mimeType: string; data: Buffer }> | undefined,
  fields: FormField[],
  prepare: (data: Buffer, fileName: string, mimeType: string) => Promise<INodeExecutionData['binary'] extends Record<string, infer B> | undefined ? B : never>,
): Promise<INodeExecutionData> {
  const raw = (body ?? {}) as IDataObject;
  const json: IDataObject = {};
  const binary: NonNullable<INodeExecutionData['binary']> = {};
  for (const [i, f] of fields.entries()) {
    const v = raw[fieldName(i)];
    if (f.fieldType === 'file') {
      const mine = (files ?? []).filter((x) => x.fieldName === fieldName(i) && x.fileName);
      json[f.fieldLabel] = mine.map((x) => x.fileName) as never;
      for (const [n, file] of mine.entries()) binary[`${fieldName(i)}${mine.length > 1 ? `_${n}` : ''}`] = await prepare(file.data, file.fileName, file.mimeType);
      continue;
    }
    if (f.fieldType === 'checkbox' || (f.fieldType === 'dropdown' && f.multiselect)) json[f.fieldLabel] = (v === undefined ? [] : Array.isArray(v) ? v : [v]) as never;
    else if (f.fieldType === 'number') json[f.fieldLabel] = v === undefined || v === '' ? null : Number(v);
    else json[f.fieldLabel] = (v ?? '') as never;
  }
  json.submittedAt = new Date().toISOString();
  return { json, ...(Object.keys(binary).length ? { binary } : {}) };
}

export const formFieldsProperty: INodeProperties = {
  displayName: 'Form Elements',
  name: 'formFields',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true, sortable: true, multipleValueButtonText: 'Add Form Element' },
  default: {},
  options: [
    {
      name: 'values',
      displayName: 'Values',
      values: [
        { displayName: 'Field Label', name: 'fieldLabel', type: 'string', default: '', required: true },
        {
          displayName: 'Element Type',
          name: 'fieldType',
          type: 'options',
          default: 'text',
          options: [
            { name: 'Checkboxes', value: 'checkbox' },
            { name: 'Date', value: 'date' },
            { name: 'Dropdown List', value: 'dropdown' },
            { name: 'Email', value: 'email' },
            { name: 'File', value: 'file' },
            { name: 'Number', value: 'number' },
            { name: 'Password', value: 'password' },
            { name: 'Text', value: 'text' },
            { name: 'Textarea', value: 'textarea' },
          ],
        },
        { displayName: 'Placeholder', name: 'placeholder', type: 'string', default: '', displayOptions: { hide: { fieldType: ['dropdown', 'checkbox', 'file', 'date'] } } },
        {
          displayName: 'Options',
          name: 'fieldOptions',
          type: 'fixedCollection',
          typeOptions: { multipleValues: true },
          default: { values: [{ option: '' }] },
          displayOptions: { show: { fieldType: ['dropdown', 'checkbox'] } },
          options: [{ name: 'values', displayName: 'Values', values: [{ displayName: 'Option', name: 'option', type: 'string', default: '' }] }],
        },
        { displayName: 'Multiple Choice', name: 'multiselect', type: 'boolean', default: false, displayOptions: { show: { fieldType: ['dropdown'] } } },
        { displayName: 'Multiple Files', name: 'multipleFiles', type: 'boolean', default: true, displayOptions: { show: { fieldType: ['file'] } } },
        { displayName: 'Accepted File Types', name: 'acceptFileTypes', type: 'string', default: '', placeholder: '.jpg, .png', displayOptions: { show: { fieldType: ['file'] } } },
        { displayName: 'Required Field', name: 'requiredField', type: 'boolean', default: false },
      ],
    },
  ],
};

export const FormTrigger: INodeType = {
  description: {
    name: '8n8.formTrigger',
    displayName: 'On Form Submission',
    description: 'Serves a web form and starts the workflow when it is submitted',
    group: ['trigger'],
    version: [2, 2.1, 2.2],
    defaults: { name: 'On form submission', color: '#6c5ce7' },
    icon: 'fa:list-alt',
    inputs: [],
    outputs: ['main'],
    codex: { alias: ['Form', 'Survey', 'Input', 'Questionnaire'] },
    webhooks: [
      { name: 'setup', httpMethod: 'GET', path: '={{$parameter["path"]}}', isFullPath: true },
      { name: 'default', httpMethod: 'POST', path: '={{$parameter["path"]}}', isFullPath: true },
    ],
    properties: [
      { displayName: 'Form Path', name: 'path', type: 'string', default: '', placeholder: 'contact-us', hint: 'Leave empty to use a generated id' },
      { displayName: 'Form Title', name: 'formTitle', type: 'string', default: '', required: true, placeholder: 'Contact us' },
      { displayName: 'Form Description', name: 'formDescription', type: 'string', typeOptions: { rows: 2 }, default: '' },
      formFieldsProperty,
      {
        displayName: 'Respond When',
        name: 'responseMode',
        type: 'options',
        default: 'onReceived',
        options: [
          { name: 'Form Is Submitted', value: 'onReceived' },
          { name: 'Workflow Finishes', value: 'lastNode' },
        ],
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Submit Button Label', name: 'buttonLabel', type: 'string', default: 'Submit' },
          { displayName: 'Form Submitted Text', name: 'formSubmittedText', type: 'string', default: 'Your response has been recorded' },
        ],
      },
    ],
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    const fields = ((this.getNodeParameter('formFields', {}) as { values?: FormField[] }).values ?? []) as FormField[];
    const title = this.getNodeParameter('formTitle', '') as string;
    const options = this.getNodeParameter('options', {}) as IDataObject;
    if (this.getWebhookName() === 'setup') {
      const html = renderForm({ title, description: this.getNodeParameter('formDescription', '') as string, fields, buttonLabel: options.buttonLabel as string });
      return { webhookResponse: { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html } };
    }
    const req = this.getRequestObject();
    const item = await parseSubmission(req.body, req.files, fields, (d, n, m) => this.helpers.prepareBinaryData(d, n, m));
    item.json.formMode = this.getMode() === 'manual' ? 'test' : 'production';
    const respond = this.getNodeParameter('responseMode', 'onReceived') === 'onReceived';
    return {
      workflowData: [[item]],
      ...(respond ? { webhookResponse: { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: renderSubmitted(title, options.formSubmittedText as string) } } : {}),
    };
  },
};

/* ---------------- Form (next page / ending) ---------------- */

/** The page a waiting Form node shows, or what its ending does. */
export interface FormNodePage {
  kind: 'page' | 'completion';
  title?: string;
  description?: string;
  fields: FormField[];
  buttonLabel?: string;
  respondWith?: 'text' | 'redirect' | 'showText';
  completionTitle?: string;
  completionMessage?: string;
  redirectUrl?: string;
  responseText?: string;
}

export const Form: INodeType = {
  description: {
    name: '8n8.form',
    displayName: 'Form',
    description: 'Adds a page or the ending screen to a form started by "On form submission"',
    group: ['input'],
    version: [1],
    defaults: { name: 'Form', color: '#6c5ce7' },
    icon: 'fa:list-alt',
    inputs: ['main'],
    outputs: ['main'],
    codex: { alias: ['Form', 'Multi-step', 'Page', 'Wizard'] },
    properties: [
      {
        displayName: 'Page Type',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'page',
        options: [
          { name: 'Next Form Page', value: 'page' },
          { name: 'Form Ending', value: 'completion' },
        ],
      },
      { ...formFieldsProperty, displayOptions: { show: { operation: ['page'] } } },
      {
        displayName: 'On n8n Form Submission',
        name: 'respondWith',
        type: 'options',
        default: 'text',
        displayOptions: { show: { operation: ['completion'] } },
        options: [
          { name: 'Show Completion Screen', value: 'text' },
          { name: 'Redirect to URL', value: 'redirect' },
          { name: 'Show Text', value: 'showText', description: 'Replace the page with your own HTML' },
        ],
      },
      { displayName: 'Completion Title', name: 'completionTitle', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['completion'], respondWith: ['text'] } } },
      { displayName: 'Completion Message', name: 'completionMessage', type: 'string', typeOptions: { rows: 2 }, default: '', displayOptions: { show: { operation: ['completion'], respondWith: ['text'] } } },
      { displayName: 'URL', name: 'redirectUrl', type: 'string', default: '', required: true, placeholder: 'https://example.com', displayOptions: { show: { operation: ['completion'], respondWith: ['redirect'] } } },
      { displayName: 'Text', name: 'responseText', type: 'string', typeOptions: { rows: 4 }, default: '', placeholder: '<h1>Thanks!</h1>', displayOptions: { show: { operation: ['completion'], respondWith: ['showText'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        displayOptions: { show: { operation: ['page'] } },
        options: [
          { displayName: 'Form Title', name: 'formTitle', type: 'string', default: '' },
          { displayName: 'Form Description', name: 'formDescription', type: 'string', typeOptions: { rows: 2 }, default: '' },
          { displayName: 'Button Label', name: 'buttonLabel', type: 'string', default: 'Submit' },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const input = this.getInputData();
    const resumed = this.getResumeData();
    if (resumed) return [this.getNodeParameter('operation', 0) === 'page' ? (resumed.data ?? input) : input];
    // the page is served (and the ending shown) by the form-waiting URL
    await this.putExecutionToWait(new Date('3000-01-01T00:00:00Z'));
    return [input];
  },
};

/**
 * What a waiting Form node (or a Wait node set to "On Form Submitted") shows; null for other nodes.
 * `param` reads the node's parameters with expressions resolved against its input.
 */
export function formPageOf(node: INode, param: (name: string, fallback?: unknown) => unknown): FormNodePage | null {
  const fields = () => (((param('formFields', {}) as { values?: FormField[] }).values ?? []) as FormField[]);
  if (node.type.endsWith('.wait')) {
    if (param('resume') !== 'form') return null;
    return { kind: 'page', title: param('formTitle', '') as string, description: param('formDescription', '') as string, fields: fields() };
  }
  if (!node.type.endsWith('.form')) return null;
  if (param('operation', 'page') === 'page') {
    const o = param('options', {}) as IDataObject;
    return { kind: 'page', title: o.formTitle as string, description: o.formDescription as string, buttonLabel: o.buttonLabel as string, fields: fields() };
  }
  const respondWith = (param('respondWith', 'text') as FormNodePage['respondWith']) ?? 'text';
  return {
    kind: 'completion',
    fields: [],
    respondWith,
    completionTitle: respondWith === 'text' ? (param('completionTitle', '') as string) : undefined,
    completionMessage: respondWith === 'text' ? (param('completionMessage', '') as string) : undefined,
    redirectUrl: respondWith === 'redirect' ? (param('redirectUrl', '') as string) : undefined,
    responseText: respondWith === 'showText' ? (param('responseText', '') as string) : undefined,
  };
}
