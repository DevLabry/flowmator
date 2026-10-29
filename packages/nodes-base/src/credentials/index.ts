import type { ICredentialType } from '@8n8/workflow';

const password = { password: true };

export const HttpBasicAuth: ICredentialType = {
  name: 'httpBasicAuth',
  displayName: 'Basic Auth',
  properties: [
    { displayName: 'User', name: 'user', type: 'string', default: '' },
    { displayName: 'Password', name: 'password', type: 'string', typeOptions: password, default: '' },
  ],
  authenticate: { type: 'generic', properties: { auth: { username: '={{$credentials.user}}', password: '={{$credentials.password}}' } } },
};

export const HttpHeaderAuth: ICredentialType = {
  name: 'httpHeaderAuth',
  displayName: 'Header Auth',
  properties: [
    { displayName: 'Name', name: 'name', type: 'string', default: '' },
    { displayName: 'Value', name: 'value', type: 'string', typeOptions: password, default: '' },
  ],
  authenticate: { type: 'generic', properties: { headers: { '={{$credentials.name}}': '={{$credentials.value}}' } } },
};

export const HttpQueryAuth: ICredentialType = {
  name: 'httpQueryAuth',
  displayName: 'Query Auth',
  properties: [
    { displayName: 'Name', name: 'name', type: 'string', default: '' },
    { displayName: 'Value', name: 'value', type: 'string', typeOptions: password, default: '' },
  ],
  authenticate: { type: 'generic', properties: { qs: { '={{$credentials.name}}': '={{$credentials.value}}' } } },
};

export const HttpBearerAuth: ICredentialType = {
  name: 'httpBearerAuth',
  displayName: 'Bearer Auth',
  properties: [{ displayName: 'Bearer Token', name: 'token', type: 'string', typeOptions: password, default: '' }],
  authenticate: { type: 'generic', properties: { headers: { Authorization: '=Bearer {{$credentials.token}}' } } },
};

/** JSON like {"headers": {...}, "qs": {...}, "body": {...}} merged into each request. */
export const HttpCustomAuth: ICredentialType = {
  name: 'httpCustomAuth',
  displayName: 'Custom Auth',
  properties: [{ displayName: 'JSON', name: 'json', type: 'json', typeOptions: password, default: '{\n  "headers": {}\n}' }],
};

export const OAuth2Api: ICredentialType = {
  name: 'oAuth2Api',
  displayName: 'OAuth2 API',
  properties: [
    {
      displayName: 'Grant Type',
      name: 'grantType',
      type: 'options',
      default: 'authorizationCode',
      options: [
        { name: 'Authorization Code', value: 'authorizationCode' },
        { name: 'Client Credentials', value: 'clientCredentials' },
        { name: 'PKCE', value: 'pkce' },
      ],
    },
    { displayName: 'Authorization URL', name: 'authUrl', type: 'string', default: '', displayOptions: { show: { grantType: ['authorizationCode', 'pkce'] } } },
    { displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'string', default: '' },
    { displayName: 'Client ID', name: 'clientId', type: 'string', default: '' },
    { displayName: 'Client Secret', name: 'clientSecret', type: 'string', typeOptions: password, default: '' },
    { displayName: 'Scope', name: 'scope', type: 'string', default: '' },
    { displayName: 'Auth URI Query Parameters', name: 'authQueryParameters', type: 'string', default: '', placeholder: 'access_type=offline&prompt=consent' },
    {
      displayName: 'Authentication',
      name: 'authentication',
      type: 'options',
      default: 'header',
      options: [
        { name: 'Send as Basic Auth Header', value: 'header' },
        { name: 'Send Credentials in Body', value: 'body' },
      ],
    },
    { displayName: 'Token Data', name: 'oauthTokenData', type: 'hidden', default: {} },
  ],
};

export const credentials: ICredentialType[] = [HttpBasicAuth, HttpHeaderAuth, HttpQueryAuth, HttpBearerAuth, HttpCustomAuth, OAuth2Api];
