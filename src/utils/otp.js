/**
 * otp.js
 *
 * Fix sicurezza:
 *  - OTP generato con crypto.randomInt (CSPRNG) invece di Math.random
 *  - Limite tentativi falliti: dopo MAX_ATTEMPTS il record viene eliminato
 *    (previene brute-force anche se il rate limiter viene bypassato)
 */

const crypto = require('crypto');
const prisma  = require('../config/database');

const OTP_TTL_MS      = 10 * 60 * 1000; // 10 minuti
const MAX_ATTEMPTS    = 5;               // blocca dopo 5 tentativi errati

/** Genera un OTP a 6 cifre crittograficamente sicuro. */
function generateOtp() {
  // crypto.randomInt(min, max) → intero in [min, max)
  return String(crypto.randomInt(100_000, 1_000_000));
}

/**
 * Crea un nuovo OTP per l'utente, eliminando quelli precedenti.
 * @returns {string} codice OTP (da inviare via email)
 */
async function createOtp(userId) {
  await prisma.otp.deleteMany({ where: { userId } });

  const code      = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.otp.create({ data: { userId, code, expiresAt } });
  return code;
}

/**
 * Verifica un OTP. Elimina il record dopo verifica (monouso).
 * Se il codice è sbagliato per MAX_ATTEMPTS volte elimina il record
 * per forzare una nuova richiesta OTP.
 *
 * @returns {boolean} true se valido, false altrimenti
 */
async function verifyOtp(userId, code) {
  const otp = await prisma.otp.findFirst({
    where: { userId, expiresAt: { gt: new Date() } },
  });

  if (!otp) return false;

  // Confronto a tempo costante per evitare timing attacks
  const expected = Buffer.from(otp.code.padStart(10, '0'));
  const received = Buffer.from(String(code ?? '').padStart(10, '0'));
  const matches  = expected.length === received.length &&
                   crypto.timingSafeEqual(expected, received);

  if (!matches) {
    // Incrementa contatore tentativi falliti
    const attempts = (otp.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      // Troppi tentativi → elimina OTP, obbliga nuova richiesta
      await prisma.otp.delete({ where: { id: otp.id } });
    } else {
      await prisma.otp.update({
        where: { id: otp.id },
        data:  { attempts },
      }).catch(() => {}); // ignora se non esiste il campo (schema vecchio)
    }
    return false;
  }

  // OTP corretto → elimina (monouso)
  await prisma.otp.delete({ where: { id: otp.id } });
  return true;
}

module.exports = { createOtp, verifyOtp };
