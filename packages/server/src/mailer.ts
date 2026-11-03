import nodemailer from 'nodemailer';

/**
 * Emails for invitations and password resets, over SMTP with n8n's variables
 * (N8N_EMAIL_MODE=smtp, N8N_SMTP_HOST, N8N_SMTP_PORT, N8N_SMTP_USER, N8N_SMTP_PASS, N8N_SMTP_SENDER, N8N_SMTP_SSL).
 * Without them, the editor shows the links to copy instead.
 */
export class Mailer {
  private readonly env = process.env;

  get enabled() {
    return this.env.N8N_EMAIL_MODE === 'smtp' && !!this.env.N8N_SMTP_HOST;
  }

  async send(to: string, subject: string, text: string, link: string) {
    if (!this.enabled) return false;
    const transport = nodemailer.createTransport({
      host: this.env.N8N_SMTP_HOST,
      port: Number(this.env.N8N_SMTP_PORT ?? 465),
      secure: (this.env.N8N_SMTP_SSL ?? 'true') !== 'false',
      ...(this.env.N8N_SMTP_USER ? { auth: { user: this.env.N8N_SMTP_USER, pass: this.env.N8N_SMTP_PASS ?? '' } } : {}),
    });
    const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    await transport.sendMail({
      from: this.env.N8N_SMTP_SENDER || this.env.N8N_SMTP_USER,
      to,
      subject,
      text: `${text}\n\n${link}`,
      html: `<p>${escape(text)}</p><p><a href="${escape(link)}">${escape(link)}</a></p>`,
    });
    return true;
  }
}
