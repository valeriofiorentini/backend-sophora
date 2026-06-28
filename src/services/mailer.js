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

// Supporta sia SMTP_USER/SMTP_PASS (naming vecchio) che EMAIL_USER/EMAIL_PASS
const smtpUser = () => process.env.SMTP_USER || process.env.EMAIL_USER;
const smtpPass = () => process.env.SMTP_PASS || process.env.EMAIL_PASS;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!smtpUser() || !smtpPass()) {
    throw new Error('Variabili email non configurate nel .env (EMAIL_USER/EMAIL_PASS)');
  }

  _transporter = nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.EMAIL_PORT || '587'),
    secure: false,
    auth: {
      user: smtpUser(),
      pass: smtpPass(),
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
    from:    process.env.EMAIL_FROM || process.env.SMTP_FROM || smtpUser(),
    to,
    subject,
    html,
    attachments: attachment ? [attachment] : [],
  });
}

module.exports = { sendMailWithAttachment };
