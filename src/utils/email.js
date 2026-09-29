/**
 * email.js — Email transazionali via Resend.
 *
 * Prima: Gmail via SMTP. Un account Gmail normale non ha nessuna
 * autenticazione di dominio (SPF/DKIM/DMARC) dietro — le email finivano
 * spesso nello spam. Ora si manda dal dominio vero (shopora.it), verificato
 * su Resend con i record DNS giusti.
 *
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

const FROM = () => process.env.EMAIL_FROM || 'Shopora <onboarding@resend.dev>';
const LOGO_URL = 'https://www.shopora.it/assets/logo.png';
const LOGO_HTML = `<img src="${LOGO_URL}" alt="Shopora" width="120" height="120" style="display:block;margin:0 auto 20px;border-radius:24px">`;

// Il SDK Resend NON lancia un'eccezione se l'invio viene rifiutato: risponde
// con { data, error } anche in caso di errore. Senza questo controllo il
// codice sopra pensava che l'email fosse partita anche quando Resend la
// scartava in silenzio (es. dominio non ancora verificato, chiave sbagliata).
async function send(payload) {
  const {data, error} = await client().emails.send(payload);
  if (error) {
    throw new Error(`Resend ha rifiutato l'invio: ${error.message || JSON.stringify(error)}`);
  }
  return data;
}

async function sendOtpEmail(to, otp) {
  await send({
    from: FROM(),
    to,
    subject: 'Shopora — Codice di verifica',
    html: `
      <div style="font-family:sans-serif;max-width:400px;margin:auto;text-align:center">
        ${LOGO_HTML}
        <h2>Shopora</h2>
        <p>Il tuo codice di verifica è:</p>
        <h1 style="letter-spacing:8px;color:#2563eb">${otp}</h1>
        <p>Scade tra 10 minuti.</p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(to, otp) {
  await send({
    from: FROM(),
    to,
    subject: 'Shopora — Reset password',
    html: `
      <div style="font-family:sans-serif;max-width:400px;margin:auto;text-align:center">
        ${LOGO_HTML}
        <h2>Shopora</h2>
        <p>Usa questo codice per reimpostare la password:</p>
        <h1 style="letter-spacing:8px;color:#2563eb">${otp}</h1>
        <p>Scade tra 10 minuti. Se non hai richiesto il reset, ignora questa email.</p>
      </div>
    `,
  });
}

async function sendMonthlyReportEmail(to, report, user) {
  const monthNames = [
    'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
    'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
  ];
  const monthName = monthNames[report.month - 1] || `${report.month}`;

  let itemsHtml = '';
  for (const item of report.items) {
    const formattedDate = new Date(item.timestamp).toLocaleDateString('it-IT');
    itemsHtml += `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${formattedDate}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${item.name}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">€ ${item.price.toFixed(2)}</td>
        <td style="padding: 8px; border-bottom: 1px solid #ddd;">${item.storeName}</td>
      </tr>
    `;
  }

  let categoriesHtml = '';
  for (const [cat, sum] of Object.entries(report.categoryTotals)) {
    categoriesHtml += `
      <li><strong>${cat}</strong>: € ${sum.toFixed(2)}</li>
    `;
  }

  await send({
    from: FROM(),
    to,
    subject: `Shopora — Report Spesa di ${monthName} ${report.year}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: auto; color: #333;">
        ${LOGO_HTML}
        <h2 style="color: #2563eb; border-bottom: 2px solid #2563eb; padding-bottom: 10px;">Shopora — Report Spesa</h2>
        <p>Ciao ${user.name || 'utente'},</p>
        <p>Ecco il riepilogo delle tue spese per il mese di <strong>${monthName} ${report.year}</strong>.</p>

        <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #1f2937;">Sintesi</h3>
          <p style="font-size: 18px; margin-bottom: 5px;">Spesa Totale: <strong style="color: #ef4444;">€ ${report.total.toFixed(2)}</strong></p>
          <p>Numero totali articoli / transazioni: <strong>${report.itemCount}</strong></p>
        </div>

        <h3 style="color: #1f2937;">Spesa per Categoria</h3>
        <ul>
          ${categoriesHtml}
        </ul>

        <h3 style="color: #1f2937;">Dettaglio Acquisti</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr style="background-color: #f3f4f6;">
              <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Data</th>
              <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Prodotto</th>
              <th style="padding: 8px; text-align: center; border-bottom: 2px solid #ddd;">Qtà</th>
              <th style="padding: 8px; text-align: right; border-bottom: 2px solid #ddd;">Prezzo</th>
              <th style="padding: 8px; text-align: left; border-bottom: 2px solid #ddd;">Negozio</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <p style="margin-top: 30px; font-size: 12px; color: #6b7280; text-align: center;">
          Generato automaticamente da Shopora AI.
        </p>
      </div>
    `,
  });
}

module.exports = { sendOtpEmail, sendPasswordResetEmail, sendMonthlyReportEmail };
