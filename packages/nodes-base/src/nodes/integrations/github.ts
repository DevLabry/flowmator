import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IDataObject, IExecuteFunctions, IHookFunctions, INodeType, IWebhookFunctions, IWebhookResult } from '@8n8/workflow';
import { apiRequest, collectPages, forEachItem, forOp, listLimit, operationProp, returnAllProps } from '../../utils/api';

type Ctx = IExecuteFunctions | IHookFunctions;

const credTypeOf = (auth: unknown) => (auth === 'oAuth2' ? 'githubOAuth2Api' : 'githubApi');

async function github(ctx: Ctx, auth: unknown, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: IDataObject, qs?: IDataObject, i = 0) {
  const credType = credTypeOf(auth);
  const creds = await ctx.getCredentials<{ server?: string }>(credType, i);
  const base = (creds.server || 'https://api.github.com').replace(/\/$/, '');
  return apiRequest(ctx as IExecuteFunctions, credType, {
    url: `${base}${path}`,
    method,
    ...(body ? { body } : {}),
    ...(qs ? { qs } : {}),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  }, i);
}

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

const ownerRepo = [
  { displayName: 'Repository Owner', name: 'owner', type: 'string' as const, default: '', required: true, placeholder: 'octocat' },
  { displayName: 'Repository Name', name: 'repository', type: 'string' as const, default: '', required: true, placeholder: 'hello-world' },
];

export const GitHub: INodeType = {
  description: {
    name: '8n8.github',
    displayName: 'GitHub',
    description: 'Work with issues, files, repositories and releases on GitHub',
    group: ['input'],
    version: [1, 1.1],
    defaults: { name: 'GitHub', color: '#000000' },
    icon: 'fa:github',
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'githubApi', required: true, displayOptions: { show: { authentication: ['accessToken'] } } },
      { name: 'githubOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    codex: { categories: ['Development'] },
    properties: [
      { displayName: 'Authentication', name: 'authentication', type: 'options', default: 'accessToken', options: [{ name: 'Access Token', value: 'accessToken' }, { name: 'OAuth2', value: 'oAuth2' }] },
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        default: 'issue',
        options: ['file', 'issue', 'release', 'repository', 'user'].map((r) => ({ name: r[0].toUpperCase() + r.slice(1), value: r })),
      },
      operationProp('issue', [
        { name: 'Create', value: 'create' },
        { name: 'Get', value: 'get' },
        { name: 'Get Many', value: 'getAll' },
        { name: 'Edit', value: 'edit' },
        { name: 'Create Comment', value: 'createComment' },
        { name: 'Lock', value: 'lock' },
      ]),
      operationProp('file', [
        { name: 'Get', value: 'get' },
        { name: 'List', value: 'list' },
        { name: 'Create', value: 'create' },
        { name: 'Edit', value: 'edit' },
        { name: 'Delete', value: 'delete' },
      ]),
      operationProp('repository', [{ name: 'Get', value: 'get' }, { name: 'Get Pull Requests', value: 'getPullRequests' }, { name: 'Get Issues', value: 'getIssues' }]),
      operationProp('release', [{ name: 'Create', value: 'create' }, { name: 'Get Many', value: 'getAll' }]),
      operationProp('user', [{ name: 'Get Repositories', value: 'getRepositories' }, { name: 'Invite to Organization', value: 'invite' }]),

      ...forOp('issue', ['create', 'get', 'getAll', 'edit', 'createComment', 'lock'], ownerRepo),
      ...forOp('file', ['get', 'list', 'create', 'edit', 'delete'], ownerRepo),
      ...forOp('repository', ['get', 'getPullRequests', 'getIssues'], ownerRepo),
      ...forOp('release', ['create', 'getAll'], ownerRepo),

      ...forOp('issue', ['get', 'edit', 'createComment', 'lock'], [{ displayName: 'Issue Number', name: 'issueNumber', type: 'number', default: 0, required: true }]),
      ...forOp('issue', 'create', [
        { displayName: 'Title', name: 'title', type: 'string', default: '', required: true },
        { displayName: 'Body', name: 'body', type: 'string', typeOptions: { rows: 4 }, default: '' },
        { displayName: 'Labels', name: 'labels', type: 'string', default: '', description: 'Comma separated' },
        { displayName: 'Assignees', name: 'assignees', type: 'string', default: '', description: 'Comma separated logins' },
      ]),
      ...forOp('issue', 'edit', [
        {
          displayName: 'Edit Fields',
          name: 'editFields',
          type: 'collection',
          default: {},
          options: [
            { displayName: 'Title', name: 'title', type: 'string', default: '' },
            { displayName: 'Body', name: 'body', type: 'string', typeOptions: { rows: 4 }, default: '' },
            { displayName: 'State', name: 'state', type: 'options', default: 'open', options: [{ name: 'Open', value: 'open' }, { name: 'Closed', value: 'closed' }] },
            { displayName: 'State Reason', name: 'state_reason', type: 'options', default: 'completed', options: ['completed', 'not_planned', 'reopened'].map((s) => ({ name: s, value: s })) },
            { displayName: 'Labels', name: 'labels', type: 'string', default: '' },
            { displayName: 'Assignees', name: 'assignees', type: 'string', default: '' },
          ],
        },
      ]),
      ...forOp('issue', 'createComment', [{ displayName: 'Comment', name: 'body', type: 'string', typeOptions: { rows: 4 }, default: '', required: true }]),
      ...forOp('issue', 'lock', [{ displayName: 'Lock Reason', name: 'lockReason', type: 'options', default: 'resolved', options: ['off-topic', 'too heated', 'resolved', 'spam'].map((r) => ({ name: r, value: r })) }]),
      ...forOp('issue', 'getAll', [
        { displayName: 'State', name: 'state', type: 'options', default: 'open', options: ['open', 'closed', 'all'].map((s) => ({ name: s, value: s })) },
        { displayName: 'Labels', name: 'labels', type: 'string', default: '' },
        ...returnAllProps({ resource: ['issue'], operation: ['getAll'] }),
      ]),
      ...forOp('repository', ['getIssues', 'getPullRequests'], [
        { displayName: 'State', name: 'state', type: 'options', default: 'open', options: ['open', 'closed', 'all'].map((s) => ({ name: s, value: s })) },
      ]),
      ...forOp('repository', 'getIssues', returnAllProps({ resource: ['repository'], operation: ['getIssues'] })),
      ...forOp('repository', 'getPullRequests', returnAllProps({ resource: ['repository'], operation: ['getPullRequests'] })),

      ...forOp('file', ['get', 'list', 'create', 'edit', 'delete'], [{ displayName: 'File Path', name: 'filePath', type: 'string', default: '', placeholder: 'docs/README.md', description: 'For "List": a folder (empty = root)' }]),
      ...forOp('file', ['get', 'list'], [{ displayName: 'Reference (branch, tag or SHA)', name: 'reference', type: 'string', default: '' }]),
      ...forOp('file', 'get', [
        { displayName: 'As Binary File', name: 'asBinaryProperty', type: 'boolean', default: true },
        { displayName: 'Put Output File in Field', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { asBinaryProperty: [true] } } },
      ]),
      ...forOp('file', ['create', 'edit'], [
        { displayName: 'Binary File', name: 'binaryData', type: 'boolean', default: false },
        { displayName: 'File Content', name: 'fileContent', type: 'string', typeOptions: { rows: 4 }, default: '', displayOptions: { show: { binaryData: [false] } } },
        { displayName: 'Input Binary Field', name: 'binaryPropertyName', type: 'string', default: 'data', displayOptions: { show: { binaryData: [true] } } },
      ]),
      ...forOp('file', ['create', 'edit', 'delete'], [
        { displayName: 'Commit Message', name: 'commitMessage', type: 'string', default: '', required: true },
        { displayName: 'Branch', name: 'branch', type: 'string', default: '', description: 'Default branch when empty' },
      ]),

      ...forOp('release', 'create', [
        { displayName: 'Tag', name: 'releaseTag', type: 'string', default: '', required: true },
        { displayName: 'Name', name: 'name', type: 'string', default: '' },
        { displayName: 'Body', name: 'body', type: 'string', typeOptions: { rows: 4 }, default: '' },
        { displayName: 'Draft', name: 'draft', type: 'boolean', default: false },
        { displayName: 'Pre-release', name: 'prerelease', type: 'boolean', default: false },
        { displayName: 'Generate Release Notes', name: 'generate_release_notes', type: 'boolean', default: false },
      ]),
      ...forOp('release', 'getAll', returnAllProps({ resource: ['release'], operation: ['getAll'] })),

      ...forOp('user', 'getRepositories', [
        { displayName: 'User', name: 'owner', type: 'string', default: '', required: true },
        ...returnAllProps({ resource: ['user'], operation: ['getRepositories'] }),
      ]),
      ...forOp('user', 'invite', [
        { displayName: 'Organization', name: 'organization', type: 'string', default: '', required: true },
        { displayName: 'Email', name: 'email', type: 'string', default: '', required: true },
      ]),
    ],
  },
  async execute(this: IExecuteFunctions) {
    return [
      await forEachItem(this, async (i) => {
        const resource = this.getNodeParameter('resource', i) as string;
        const op = this.getNodeParameter('operation', i) as string;
        const auth = this.getNodeParameter('authentication', i, 'accessToken');
        const p = <T = string>(name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback) as T;
        const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: IDataObject, qs?: IDataObject) => github(this, auth, method, path, body, qs, i);
        const list = (path: string, qs: IDataObject = {}) =>
          collectPages(async (page, size) => {
            const n = page ? Number(page) : 1;
            const rows = (await call('GET', path, undefined, { ...qs, per_page: size, page: n })) as IDataObject[];
            return { items: rows, next: rows.length === size ? String(n + 1) : null };
          }, listLimit(this, i), 100);
        const csv = (v: unknown) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

        if (resource === 'user') {
          if (op === 'invite') return call('POST', `/orgs/${encodeURIComponent(p('organization'))}/invitations`, { email: p('email') });
          return list(`/users/${encodeURIComponent(p('owner'))}/repos`);
        }

        const repo = repoPath(p('owner'), p('repository'));

        if (resource === 'issue') {
          const num = p<number>('issueNumber', 0);
          switch (op) {
            case 'create':
              return call('POST', `${repo}/issues`, { title: p('title'), body: p('body', ''), labels: csv(p('labels', '')), assignees: csv(p('assignees', '')) });
            case 'get':
              return call('GET', `${repo}/issues/${num}`);
            case 'edit': {
              const f = { ...p<IDataObject>('editFields', {}) };
              if (f.labels !== undefined) f.labels = csv(f.labels) as never;
              if (f.assignees !== undefined) f.assignees = csv(f.assignees) as never;
              return call('PATCH', `${repo}/issues/${num}`, f);
            }
            case 'createComment':
              return call('POST', `${repo}/issues/${num}/comments`, { body: p('body') });
            case 'lock':
              await call('PUT', `${repo}/issues/${num}/lock`, { lock_reason: p('lockReason') });
              return { locked: true, issue: num };
            default:
              return list(`${repo}/issues`, { state: p('state', 'open'), ...(p('labels', '') ? { labels: p('labels') } : {}) });
          }
        }

        if (resource === 'repository') {
          if (op === 'get') return call('GET', repo);
          if (op === 'getPullRequests') return list(`${repo}/pulls`, { state: p('state', 'open') });
          return list(`${repo}/issues`, { state: p('state', 'open') });
        }

        if (resource === 'release') {
          if (op === 'getAll') return list(`${repo}/releases`);
          return call('POST', `${repo}/releases`, {
            tag_name: p('releaseTag'), name: p('name', ''), body: p('body', ''), draft: p('draft', false), prerelease: p('prerelease', false), generate_release_notes: p('generate_release_notes', false),
          });
        }

        // file
        const path = `${repo}/contents/${enc(p('filePath', ''))}`;
        const ref = p('reference', '');
        if (op === 'get') {
          const file = (await call('GET', path, undefined, ref ? { ref } : undefined)) as IDataObject;
          const content = Buffer.from(String(file.content ?? ''), 'base64');
          const { content: _c, ...meta } = file;
          if (!p('asBinaryProperty', true)) return { ...meta, content: content.toString('utf8') };
          return { json: meta, binary: { [p('binaryPropertyName', 'data')]: await this.helpers.prepareBinaryData(content, String(file.name)) } };
        }
        if (op === 'list') return (await call('GET', path, undefined, ref ? { ref } : undefined)) as IDataObject[];

        const branch = p('branch', '');
        // edit and delete need the current blob sha
        const sha = async () => ((await call('GET', path, undefined, branch ? { ref: branch } : undefined)) as IDataObject).sha as string;
        if (op === 'delete') return call('DELETE', path, { message: p('commitMessage'), sha: await sha(), ...(branch ? { branch } : {}) });
        const content = p('binaryData', false)
          ? (await this.helpers.getBinaryDataBuffer(i, p('binaryPropertyName', 'data'))).toString('base64')
          : Buffer.from(p('fileContent', ''), 'utf8').toString('base64');
        return call('PUT', path, { message: p('commitMessage'), content, ...(branch ? { branch } : {}), ...(op === 'edit' ? { sha: await sha() } : {}) });
      }),
    ];
  },
};

const EVENTS = ['*', 'push', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'issues', 'issue_comment', 'release', 'create', 'delete', 'fork', 'star', 'watch', 'workflow_run', 'check_run', 'deployment', 'deployment_status', 'discussion', 'member', 'public'];

export const GitHubTrigger: INodeType = {
  description: {
    name: '8n8.githubTrigger',
    displayName: 'GitHub Trigger',
    description: 'Starts the workflow on GitHub events (creates a repository webhook; needs a public URL)',
    group: ['trigger'],
    version: [1],
    defaults: { name: 'GitHub Trigger', color: '#000000' },
    icon: 'fa:github',
    inputs: [],
    outputs: ['main'],
    credentials: [
      { name: 'githubApi', required: true, displayOptions: { show: { authentication: ['accessToken'] } } },
      { name: 'githubOAuth2Api', required: true, displayOptions: { show: { authentication: ['oAuth2'] } } },
    ],
    webhooks: [{ name: 'default', httpMethod: 'POST', path: 'webhook', isFullPath: false }],
    properties: [
      { displayName: 'Authentication', name: 'authentication', type: 'options', default: 'accessToken', options: [{ name: 'Access Token', value: 'accessToken' }, { name: 'OAuth2', value: 'oAuth2' }] },
      ...ownerRepo,
      { displayName: 'Events', name: 'events', type: 'multiOptions', default: ['push'], options: EVENTS.map((e) => ({ name: e === '*' ? '* (all events)' : e, value: e })) },
    ],
  },
  webhookMethods: {
    default: {
      async checkExists(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        if (!data.webhookId) return false;
        const repo = repoPath(this.getNodeParameter('owner') as string, this.getNodeParameter('repository') as string);
        try {
          await github(this, this.getNodeParameter('authentication', 'accessToken'), 'GET', `${repo}/hooks/${data.webhookId}`);
          return true;
        } catch {
          delete data.webhookId;
          return false;
        }
      },
      async create(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        const repo = repoPath(this.getNodeParameter('owner') as string, this.getNodeParameter('repository') as string);
        data.secret = randomBytes(24).toString('hex');
        const hook = (await github(this, this.getNodeParameter('authentication', 'accessToken'), 'POST', `${repo}/hooks`, {
          name: 'web',
          active: true,
          events: this.getNodeParameter('events', ['push']) as string[],
          config: { url: this.getNodeWebhookUrl('default'), content_type: 'json', secret: data.secret, insecure_ssl: '0' },
        })) as IDataObject;
        data.webhookId = hook.id as number;
        return true;
      },
      async delete(this: IHookFunctions) {
        const data = this.getWorkflowStaticData('node');
        if (!data.webhookId) return true;
        const repo = repoPath(this.getNodeParameter('owner') as string, this.getNodeParameter('repository') as string);
        await github(this, this.getNodeParameter('authentication', 'accessToken'), 'DELETE', `${repo}/hooks/${data.webhookId}`).catch(() => {});
        delete data.webhookId;
        delete data.secret;
        return true;
      },
    },
  },
  async webhook(this: IWebhookFunctions): Promise<IWebhookResult> {
    const req = this.getRequestObject();
    const headers = this.getHeaderData();
    const secret = this.getWorkflowStaticData('node').secret as string | undefined;
    if (secret) {
      const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(req.rawBody ?? Buffer.from('')).digest('hex')}`);
      const got = Buffer.from(String(headers['x-hub-signature-256'] ?? ''));
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        return { webhookResponse: { statusCode: 401, body: { message: 'Invalid signature' } } };
      }
    }
    const event = String(headers['x-github-event'] ?? '');
    // GitHub sends a "ping" right after the hook is created
    if (event === 'ping') return { webhookResponse: { statusCode: 200, body: { ok: true } } };
    return {
      workflowData: [[{ json: { event, delivery: String(headers['x-github-delivery'] ?? ''), body: this.getBodyData(), headers } }]],
      webhookResponse: { statusCode: 200, body: { ok: true } },
    };
  },
};
