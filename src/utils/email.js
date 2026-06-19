const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: false,
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});

// Verifica SMTP all'avvio: senza questo, una configurazione email rotta
// (credenziali Gmail scadute, app password revocata) falliva in silenzio a
// ogni invio OTP e l'utente non riceveva mai il codice senza che nessuno
// se ne accorgesse. Ora il problema è visibile subito nei log del server.
if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.warn('[email] ⚠️  Config SMTP incompleta (EMAIL_HOST/USER/PASS) — le email OTP NON partiranno.');
} else {
  transporter.verify()
    .then(() => console.info(`[email] ✓ SMTP pronto (${process.env.EMAIL_HOST} come ${process.env.EMAIL_USER})`))
    .catch(e => console.error(`[email] ✗ SMTP NON raggiungibile: ${e.message} — le email OTP falliranno!`));
}

// Email transazionali multilingua — la lingua segue User.language
const EMAIL_TEXTS = {
  it: {
    otpSubject:   'Shopora — Codice di verifica',
    otpIntro:     'Il tuo codice di verifica è:',
    otpExpiry:    'Scade tra 10 minuti.',
    resetSubject: 'Shopora — Reset password',
    resetIntro:   'Usa questo codice per reimpostare la password:',
    resetExpiry:  'Scade tra 10 minuti. Se non hai richiesto il reset, ignora questa email.',
  },
  en: {
    otpSubject:   'Shopora — Verification code',
    otpIntro:     'Your verification code is:',
    otpExpiry:    'It expires in 10 minutes.',
    resetSubject: 'Shopora — Password reset',
    resetIntro:   'Use this code to reset your password:',
    resetExpiry:  'It expires in 10 minutes. If you did not request a reset, ignore this email.',
  },
  fr: {
    otpSubject:   'Shopora — Code de vérification',
    otpIntro:     'Votre code de vérification est :',
    otpExpiry:    'Il expire dans 10 minutes.',
    resetSubject: 'Shopora — Réinitialisation du mot de passe',
    resetIntro:   'Utilisez ce code pour réinitialiser votre mot de passe :',
    resetExpiry:  'Il expire dans 10 minutes. Si vous n\'avez pas demandé de réinitialisation, ignorez cet email.',
  },
  es: {
    otpSubject:   'Shopora — Código de verificación',
    otpIntro:     'Tu código de verificación es:',
    otpExpiry:    'Caduca en 10 minutos.',
    resetSubject: 'Shopora — Restablecer contraseña',
    resetIntro:   'Usa este código para restablecer tu contraseña:',
    resetExpiry:  'Caduca en 10 minutos. Si no solicitaste el restablecimiento, ignora este correo.',
  },
  de: {
    otpSubject:   'Shopora — Bestätigungscode',
    otpIntro:     'Dein Bestätigungscode lautet:',
    otpExpiry:    'Er läuft in 10 Minuten ab.',
    resetSubject: 'Shopora — Passwort zurücksetzen',
    resetIntro:   'Verwende diesen Code, um dein Passwort zurückzusetzen:',
    resetExpiry:  'Er läuft in 10 Minuten ab. Falls du das nicht angefordert hast, ignoriere diese E-Mail.',
  },
};

function texts(lang) {
  return EMAIL_TEXTS[lang] ?? EMAIL_TEXTS.it;
}

function codeHtml(intro, otp, expiry) {
  return `
    <div style="font-family:sans-serif;max-width:400px;margin:auto">
      <h2>Shopora</h2>
      <p>${intro}</p>
      <h1 style="letter-spacing:8px;color:#2563eb">${otp}</h1>
      <p>${expiry}</p>
    </div>
  `;
}

async function sendOtpEmail(to, otp, lang = 'it') {
  const t = texts(lang);
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: t.otpSubject,
    html: codeHtml(t.otpIntro, otp, t.otpExpiry),
  });
}

async function sendPasswordResetEmail(to, otp, lang = 'it') {
  const t = texts(lang);
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: t.resetSubject,
    html: codeHtml(t.resetIntro, otp, t.resetExpiry),
  });
}

module.exports = { sendOtpEmail, sendPasswordResetEmail };
