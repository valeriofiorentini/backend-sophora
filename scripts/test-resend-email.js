'use strict';

/**
 * Invia una email di prova reale con Resend, per verificare che la
 * configurazione (dominio verificato + RESEND_API_KEY nel .env) funzioni
 * davvero, senza dover passare da una registrazione vera nell'app.
 *
 * Uso: node scripts/test-resend-email.js tuamail@esempio.com
 */
require('dotenv').config();
const { sendOtpEmail } = require('../src/utils/email');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Uso: node scripts/test-resend-email.js tuamail@esempio.com');
    process.exit(1);
  }
  try {
    await sendOtpEmail(to, '123456');
    console.log(`✅ Email inviata a ${to}. Controlla la posta (anche lo spam, per stavolta).`);
  } catch (e) {
    console.error('❌ Invio fallito:', e.message);
    process.exitCode = 1;
  }
}

main();
