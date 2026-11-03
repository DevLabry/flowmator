import nodemailer from 'nodemailer';

/**
 * Emails for invitations and password resets, over SMTP
 * (FLOWMATOR_EMAIL_MODE=smtp, FLOWMATOR_SMTP_HOST, FLOWMATOR_SMTP_PORT, FLOWMATOR_SMTP_USER, FLOWMATOR_SMTP_PASS, FLOWMATOR_SMTP_SENDER, FLOWMATOR_SMTP_SSL).
 * Without them, the editor shows the links to copy instead.
 */
export class Mailer {
  private readonly env = process.env;

  get enabled() {
    return this.env.FLOWMATOR_EMAIL_MODE === 'smtp' && !!this.env.FLOWMATOR_SMTP_HOST;
  }

  async send(to: string, subject: string, text: string, link: string) {
    if (!this.enabled) return false;
    const transport = nodemailer.createTransport({
      host: this.env.FLOWMATOR_SMTP_HOST,
      port: Number(this.env.FLOWMATOR_SMTP_PORT ?? 465),
      secure: (this.env.FLOWMATOR_SMTP_SSL ?? 'true') !== 'false',
      ...(this.env.FLOWMATOR_SMTP_USER ? { auth: { user: this.env.FLOWMATOR_SMTP_USER, pass: this.env.FLOWMATOR_SMTP_PASS ?? '' } } : {}),
    });
    const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    await transport.sendMail({
      from: this.env.FLOWMATOR_SMTP_SENDER || this.env.FLOWMATOR_SMTP_USER,
      to,
      subject,
      text: `${text}\n\n${link}`,
      html: `<p>${escape(text)}</p><p><a href="${escape(link)}">${escape(link)}</a></p>`,
    });
    return true;
  }
}
