import nodemailer from 'nodemailer';
import { HttpError } from './errors.js';

export function getMailConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM } = process.env;
  const port = Number(SMTP_PORT);
  if (!SMTP_HOST || !Number.isInteger(port) || port < 1 || port > 65_535 || !EMAIL_FROM) {
    throw new HttpError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Password reset email is unavailable until SMTP_HOST, SMTP_PORT, and EMAIL_FROM are configured.',
    );
  }
  if (Boolean(SMTP_USER) !== Boolean(SMTP_PASSWORD)) {
    throw new HttpError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Configure both SMTP_USER and SMTP_PASSWORD, or leave both blank for an unauthenticated SMTP relay.',
    );
  }

  const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5173';
  let baseUrl;
  try {
    baseUrl = new URL(appBaseUrl);
  } catch {
    throw new HttpError(503, 'EMAIL_NOT_CONFIGURED', 'APP_BASE_URL must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new HttpError(503, 'EMAIL_NOT_CONFIGURED', 'APP_BASE_URL must be a valid HTTP or HTTPS URL.');
  }

  return {
    host: SMTP_HOST,
    port,
    secure: SMTP_SECURE === 'true',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
    from: EMAIL_FROM,
    resetBaseUrl: new URL('/reset-password', baseUrl).toString(),
  };
}

export async function sendPasswordResetEmail({ to, token }) {
  const config = getMailConfig();
  const resetUrl = new URL(config.resetBaseUrl);
  resetUrl.searchParams.set('token', token);
  const safeResetUrl = resetUrl.toString();
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  try {
    await transport.sendMail({
      from: config.from,
      to,
      subject: 'Reset your Giriraj Boys PG password',
      text: [
        'We received a request to reset the password for your Giriraj Boys PG account.',
        '',
        `Choose a new password using this link (valid for 30 minutes): ${safeResetUrl}`,
        '',
        'If you did not request this, you can ignore this email.',
      ].join('\n'),
      html: `<p>We received a request to reset the password for your Giriraj Boys PG account.</p><p><a href="${safeResetUrl}">Choose a new password</a>. This link is valid for 30 minutes.</p><p>If you did not request this, you can ignore this email.</p>`,
    });
  } catch (error) {
    console.error('Password reset email delivery failed:', error);
    throw new HttpError(
      503,
      'EMAIL_DELIVERY_FAILED',
      'The reset email could not be delivered. Check the SMTP configuration and try again.',
    );
  } finally {
    transport.close();
  }
}
