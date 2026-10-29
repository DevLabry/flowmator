import type { ICredentialType, INodeProperties } from '@8n8/workflow';

const password = { password: true };

/** Fixed OAuth2 settings are hidden properties with defaults; the user only enters client id/secret. */
const oauth2 = (o: { authUrl: string; accessTokenUrl: string; scope: string; authQueryParameters?: string; authentication?: 'header' | 'body'; scopeEditable?: boolean }): INodeProperties[] => [
  { displayName: 'Client ID', name: 'clientId', type: 'string', default: '' },
  { displayName: 'Client Secret', name: 'clientSecret', type: 'string', typeOptions: password, default: '' },
  { displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'authorizationCode' },
  { displayName: 'Authorization URL', name: 'authUrl', type: 'hidden', default: o.authUrl },
  { displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'hidden', default: o.accessTokenUrl },
  o.scopeEditable
    ? { displayName: 'Scope', name: 'scope', type: 'string', default: o.scope, description: 'Space separated' }
    : { displayName: 'Scope', name: 'scope', type: 'hidden', default: o.scope },
  { displayName: 'Auth URI Query Parameters', name: 'authQueryParameters', type: 'hidden', default: o.authQueryParameters ?? '' },
  { displayName: 'Authentication', name: 'authentication', type: 'hidden', default: o.authentication ?? 'body' },
  { displayName: 'Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
];

const GOOGLE = { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', accessTokenUrl: 'https://oauth2.googleapis.com/token', authQueryParameters: 'access_type=offline&prompt=consent' };

export const integrationCredentials: ICredentialType[] = [
  /* ---------- Slack ---------- */
  {
    name: 'slackApi',
    displayName: 'Slack API (token)',
    documentationUrl: 'https://api.slack.com/apps',
    properties: [{ displayName: 'Access Token', name: 'accessToken', type: 'string', typeOptions: password, default: '', placeholder: 'xoxb-…', description: 'Bot User OAuth Token of your Slack app' }],
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } } },
    test: { request: { url: 'https://slack.com/api/auth.test', method: 'POST' } },
  },
  {
    name: 'slackOAuth2Api',
    displayName: 'Slack OAuth2',
    extends: ['oAuth2Api'],
    properties: oauth2({
      authUrl: 'https://slack.com/oauth/v2/authorize',
      accessTokenUrl: 'https://slack.com/api/oauth.v2.access',
      scope: 'chat:write channels:read channels:history groups:read groups:history im:read users:read reactions:write files:write',
      scopeEditable: true,
    }),
  },

  /* ---------- Telegram ---------- */
  {
    name: 'telegramApi',
    displayName: 'Telegram API',
    documentationUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
    properties: [
      { displayName: 'Access Token', name: 'accessToken', type: 'string', typeOptions: password, default: '', description: 'The token @BotFather gave you' },
      { displayName: 'Base URL', name: 'baseUrl', type: 'string', default: 'https://api.telegram.org', description: 'Change only for a self-hosted Bot API server' },
    ],
    test: { request: { url: '={{$credentials.baseUrl}}/bot{{$credentials.accessToken}}/getMe' } },
  },

  /* ---------- Google ---------- */
  {
    name: 'googleOAuth2Api',
    displayName: 'Google OAuth2 (any API)',
    extends: ['oAuth2Api'],
    properties: oauth2({ ...GOOGLE, scope: 'https://www.googleapis.com/auth/userinfo.email', scopeEditable: true }),
  },
  {
    name: 'gmailOAuth2',
    displayName: 'Gmail OAuth2',
    extends: ['googleOAuth2Api', 'oAuth2Api'],
    properties: oauth2({ ...GOOGLE, scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels https://www.googleapis.com/auth/gmail.compose' }),
  },
  {
    name: 'googleSheetsOAuth2Api',
    displayName: 'Google Sheets OAuth2',
    extends: ['googleOAuth2Api', 'oAuth2Api'],
    properties: oauth2({ ...GOOGLE, scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file' }),
  },
  {
    name: 'googleApi',
    displayName: 'Google Service Account',
    documentationUrl: 'https://cloud.google.com/iam/docs/service-accounts-create',
    properties: [
      { displayName: 'Service Account Email', name: 'email', type: 'string', default: '', placeholder: 'name@project.iam.gserviceaccount.com' },
      { displayName: 'Private Key', name: 'privateKey', type: 'string', typeOptions: { password: true, rows: 4 }, default: '', description: 'The private_key from the JSON key file (including the BEGIN/END lines)' },
      { displayName: 'Impersonate a User', name: 'delegatedEmail', type: 'string', default: '', description: 'For Gmail: the mailbox to act as (needs domain-wide delegation)' },
      {
        displayName: 'Scopes',
        name: 'scopes',
        type: 'string',
        default: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.modify',
        description: 'Space separated',
      },
    ],
  },

  /* ---------- Notion ---------- */
  {
    name: 'notionApi',
    displayName: 'Notion API',
    documentationUrl: 'https://www.notion.so/my-integrations',
    properties: [{ displayName: 'Internal Integration Secret', name: 'apiKey', type: 'string', typeOptions: password, default: '' }],
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}', 'Notion-Version': '2022-06-28' } } },
    test: { request: { url: 'https://api.notion.com/v1/users/me' } },
  },

  /* ---------- GitHub ---------- */
  {
    name: 'githubApi',
    displayName: 'GitHub API (token)',
    documentationUrl: 'https://github.com/settings/tokens',
    properties: [
      { displayName: 'GitHub Server', name: 'server', type: 'string', default: 'https://api.github.com', description: 'For GitHub Enterprise: https://<host>/api/v3' },
      { displayName: 'User', name: 'user', type: 'string', default: '' },
      { displayName: 'Access Token', name: 'accessToken', type: 'string', typeOptions: password, default: '' },
    ],
    authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.accessToken}}' } } },
    test: { request: { url: '={{$credentials.server}}/user', headers: { 'User-Agent': '8n8' } } },
  },
  {
    name: 'githubOAuth2Api',
    displayName: 'GitHub OAuth2',
    extends: ['oAuth2Api'],
    properties: [
      { displayName: 'GitHub Server', name: 'server', type: 'string', default: 'https://api.github.com' },
      ...oauth2({ authUrl: 'https://github.com/login/oauth/authorize', accessTokenUrl: 'https://github.com/login/oauth/access_token', scope: 'repo,admin:repo_hook,admin:org,user:email', authentication: 'body' }),
    ],
  },

  /* ---------- Postgres ---------- */
  {
    name: 'postgres',
    displayName: 'Postgres',
    properties: [
      { displayName: 'Host', name: 'host', type: 'string', default: 'localhost' },
      { displayName: 'Database', name: 'database', type: 'string', default: 'postgres' },
      { displayName: 'User', name: 'user', type: 'string', default: 'postgres' },
      { displayName: 'Password', name: 'password', type: 'string', typeOptions: password, default: '' },
      { displayName: 'Port', name: 'port', type: 'number', default: 5432 },
      {
        displayName: 'SSL',
        name: 'ssl',
        type: 'options',
        default: 'disable',
        options: [
          { name: 'Disable', value: 'disable' },
          { name: 'Allow (do not verify certificate)', value: 'allow' },
          { name: 'Require (verify certificate)', value: 'require' },
        ],
      },
    ],
  },
];
