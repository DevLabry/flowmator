import { exec } from 'node:child_process';
import nodemailer from 'nodemailer';
import { NodeOperationError, type IDataObject, type IExecuteFunctions, type INodeExecutionData, type INodeType } from '@flowmator/workflow';
import { fieldList } from '../utils/object';
import { perItem } from './markup';

/* ---------------- Send Email (SMTP) ---------------- */

interface SmtpCredentials {
  user?: string;
  password?: string;
  host: string;
  port?: number;
  secure?: boolean;
  disableStartTls?: boolean;
  hostName?: string;
}

export const SendEmail: INodeType = {
  description: {
    name: 'flowmator.emailSend',
    displayName: 'Send Email',
    description: 'Sends an email through an SMTP server',
    group: ['output'],
    version: [2, 2.1],
    defaults: { name: 'Send Email', color: '#00bb88' },
    icon: 'fa:envelope',
    inputs: ['main'],
    outputs: ['main'],
    credentials: [{ name: 'smtp', required: true }],
    properties: [
      { displayName: 'From Email', name: 'fromEmail', type: 'string', default: '', required: true, placeholder: 'Me <me@example.com>' },
      { displayName: 'To Email', name: 'toEmail', type: 'string', default: '', required: true, placeholder: 'a@example.com, b@example.com' },
      { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
      { displayName: 'Email Format', name: 'emailFormat', type: 'options', default: 'html', options: [{ name: 'Text', value: 'text' }, { name: 'HTML', value: 'html' }, { name: 'Both', value: 'both' }] },
      { displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 5 }, default: '', displayOptions: { show: { emailFormat: ['text', 'both'] } } },
      { displayName: 'HTML', name: 'html', type: 'string', typeOptions: { rows: 5 }, default: '', displayOptions: { show: { emailFormat: ['html', 'both'] } } },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'Attachments', name: 'attachments', type: 'string', default: '', description: 'Comma-separated binary field names to attach' },
          { displayName: 'CC Email', name: 'ccEmail', type: 'string', default: '' },
          { displayName: 'BCC Email', name: 'bccEmail', type: 'string', default: '' },
          { displayName: 'Reply To', name: 'replyTo', type: 'string', default: '' },
          { displayName: 'Ignore SSL Issues (Insecure)', name: 'allowUnauthorizedCerts', type: 'boolean', default: false },
        ],
      },
    ],
  },
  async execute(this: IExecuteFunctions) {
    const creds = await this.getCredentials<SmtpCredentials>('smtp');
    const opts0 = this.getNodeParameter('options', 0, {}) as IDataObject;
    const transport = nodemailer.createTransport({
      host: creds.host,
      port: Number(creds.port ?? 465),
      secure: creds.secure ?? true,
      ignoreTLS: !!creds.disableStartTls,
      name: creds.hostName || undefined,
      auth: creds.user ? { user: creds.user, pass: creds.password } : undefined,
      tls: opts0.allowUnauthorizedCerts ? { rejectUnauthorized: false } : undefined,
    });
    try {
      return [
        await perItem(this, async (item, i) => {
          const format = this.getNodeParameter('emailFormat', i) as string;
          const o = this.getNodeParameter('options', i, {}) as IDataObject;
          const attachments = [];
          for (const field of fieldList(o.attachments)) {
            for (const [key, bin] of Object.entries(item.binary ?? {})) {
              if (key !== field && !(field.endsWith('*') && key.startsWith(field.slice(0, -1)))) continue;
              attachments.push({ filename: bin.fileName ?? key, contentType: bin.mimeType, content: await this.helpers.getBinaryDataBuffer(i, key) });
            }
          }
          const info = await transport.sendMail({
            from: this.getNodeParameter('fromEmail', i) as string,
            to: this.getNodeParameter('toEmail', i) as string,
            cc: (o.ccEmail as string) || undefined,
            bcc: (o.bccEmail as string) || undefined,
            replyTo: (o.replyTo as string) || undefined,
            subject: this.getNodeParameter('subject', i, '') as string,
            text: format !== 'html' ? (this.getNodeParameter('text', i, '') as string) : undefined,
            html: format !== 'text' ? (this.getNodeParameter('html', i, '') as string) : undefined,
            attachments,
          });
          return { json: { messageId: info.messageId, accepted: info.accepted as string[], rejected: info.rejected as string[], response: info.response } };
        }),
      ];
    } finally {
      transport.close();
    }
  },
};

/* ---------------- Execute Command ---------------- */

export const ExecuteCommand: INodeType = {
  description: {
    name: 'flowmator.executeCommand',
    displayName: 'Execute Command',
    description: 'Runs a shell command on the computer running Flowmator',
    group: ['transform'],
    version: 1,
    defaults: { name: 'Execute Command', color: '#886644' },
    icon: 'fa:terminal',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Execute Once', name: 'executeOnce', type: 'boolean', default: true, description: 'Run the command once instead of once per input item' },
      { displayName: 'Command', name: 'command', type: 'string', typeOptions: { rows: 4 }, default: '', placeholder: 'echo "hello"', required: true },
    ],
  },
  async execute(this: IExecuteFunctions) {
    if (process.env.FLOWMATOR_DISABLE_EXECUTE_COMMAND === 'true') {
      throw new NodeOperationError(this.getNode(), 'The Execute Command node is disabled on this instance (FLOWMATOR_DISABLE_EXECUTE_COMMAND)');
    }
    const items = this.getInputData();
    const once = this.getNodeParameter('executeOnce', 0, true) as boolean;
    const out: INodeExecutionData[] = [];
    for (let i = 0; i < (once ? Math.min(1, items.length || 1) : items.length); i++) {
      const command = this.getNodeParameter('command', i) as string;
      const result = await new Promise<IDataObject>((resolve) => {
        exec(command, { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024, signal: this.getExecutionCancelSignal() }, (error, stdout, stderr) => {
          resolve({ exitCode: error ? ((error as { code?: number }).code ?? 1) : 0, stdout: stdout.trim(), stderr: stderr.trim(), ...(error && !stderr ? { error: error.message } : {}) });
        });
      });
      if (result.exitCode !== 0 && !this.continueOnFail()) {
        throw new NodeOperationError(this.getNode(), `Command failed with exit code ${result.exitCode}`, { description: String(result.stderr || result.error || ''), itemIndex: i });
      }
      out.push({ json: result, pairedItem: once ? items.map((_, j) => ({ item: j })) : { item: i } });
    }
    return [out];
  },
};
