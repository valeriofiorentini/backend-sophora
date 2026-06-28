/**
 * mailer.js — Email transazionale via Nodemailer + Gmail
 *
 * Setup:
 *  1. Abilita 2FA su Gmail
 *  2. Crea App Password: https://myaccount.google.com/apppasswords
 *  3. Aggiungi al .env: SMTP_USER, SMTP_PASS, SMTP_FROM
 */

const nodemailer = require('nodemailer');

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('SMTP_USER e SMTP_PASS non configurati nel .env');
  }

  _transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return _transporter;
}

/**
 * Invia un'email con allegato CSV.
 * @param {string} to  - indirizzo destinatario
 * @param {string} subject
 * @param {string} html - corpo HTML
 * @param {{ filename: string, content: string }} attachment - allegato CSV
 */
async function sendMailWithAttachment(to, subject, html, attachment) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    attachments: attachment ? [attachment] : [],
  });
}

module.exports = { sendMailWithAttachment };
