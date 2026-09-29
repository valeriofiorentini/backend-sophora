/**
 * mailer.js — Email transazionali con allegato, via Resend.
 *
 * Prima: Gmail via SMTP (vedi utils/email.js per il motivo del cambio).
 * .env: RESEND_API_KEY, EMAIL_FROM (es. "Shopora <noreply@shopora.it>")
 */

const {Resend} = require('resend');

let _resend = null;
function client() {
  if (_resend) return _resend;
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY non configurata nel .env');
  }
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Invia un'email con allegato (es. CSV).
 * @param {string} to  - indirizzo destinatario
 * @param {string} subject
 * @param {string} html - corpo HTML
 * @param {{ filename: string, content: string, encoding?: string }} attachment
 */
async function sendMailWithAttachment(to, subject, html, attachment) {
  const attachments = attachment
    ? [{
        filename: attachment.filename,
        // Resend vuole il contenuto in base64; l'allegato arriva qui come
        // stringa utf8 (es. il CSV già pronto), va prima convertito.
        content: Buffer.from(attachment.content, attachment.encoding || 'utf8').toString('base64'),
      }]
    : undefined;

  await client().emails.send({
    from: process.env.EMAIL_FROM || 'Shopora <onboarding@resend.dev>',
    to,
    subject,
    html,
    attachments,
  });
}

module.exports = { sendMailWithAttachment };
