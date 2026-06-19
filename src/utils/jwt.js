/**
 * jwt.js
 *
 * Fix sicurezza:
 *  - Access token ridotto a 15 minuti (default) — era 24h
 *  - Refresh token gestito via POST body, non URL param (evita log exposure)
 *  - Verifica JWT_SECRET all'import — crash immediato se mancante
 *  - rotateRefreshToken: controlla scadenza prima di ruotare
 */

const jwt   = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../config/database');

// Fail-fast: se JWT_SECRET non è configurato il server non parte
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET non configurato o troppo corto (minimo 32 caratteri). ' +
    'Imposta JWT_SECRET nel file .env prima di avviare il server.',
  );
}

const ACCESS_TOKEN_TTL  = process.env.JWT_EXPIRES_IN  || '15m'; // 15 minuti
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;             // 30 giorni (ms)

/**
 * Genera un JWT di accesso con scadenza breve.
 * @param {string} userId
 * @returns {string} JWT firmato
 */
function generateAccessToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' },
  );
}

/**
 * Genera un refresh token opaco (UUID v4) e lo persiste nel DB.
 * @param {string} userId
 * @returns {string} token opaco
 */
async function generateRefreshToken(userId) {
  const token     = uuidv4();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL);
  await prisma.refreshToken.create({ data: { userId, token, expiresAt } });
  return token;
}

/**
 * Ruota il refresh token (rotation anti-replay):
 *  - invalida il vecchio token
 *  - emette nuovo access token + nuovo refresh token
 *
 * Se il token è già stato usato (non trovato nel DB) → possibile token theft,
 * in questo caso si potrebbe revocare tutti i token dell'utente.
 *
 * @param {string} oldToken
 * @returns {{ accessToken, refreshToken }}
 */
async function rotateRefreshToken(oldToken) {
  if (!oldToken) throw new Error('Refresh token mancante');

  const existing = await prisma.refreshToken.findUnique({ where: { token: oldToken } });

  if (!existing) {
    // Token non trovato — potrebbe indicare token theft (già ruotato da altri)
    // In produzione: considera di revocare tutti i token dell'utente associato
    throw Object.assign(new Error('Refresh token non valido'), { statusCode: 401 });
  }

  if (existing.expiresAt < new Date()) {
    await prisma.refreshToken.delete({ where: { id: existing.id } }).catch(() => {});
    throw Object.assign(new Error('Refresh token scaduto, effettua di nuovo il login'), { statusCode: 401 });
  }

  // Invalida il vecchio token immediatamente (rotation)
  await prisma.refreshToken.delete({ where: { id: existing.id } });

  const accessToken  = generateAccessToken(existing.userId);
  const refreshToken = await generateRefreshToken(existing.userId);

  return { accessToken, refreshToken };
}

/**
 * Revoca tutti i refresh token di un utente (logout da tutti i dispositivi).
 * @param {string} userId
 */
async function revokeAllTokens(userId) {
  await prisma.refreshToken.deleteMany({ where: { userId } });
}

module.exports = { generateAccessToken, generateRefreshToken, rotateRefreshToken, revokeAllTokens };
