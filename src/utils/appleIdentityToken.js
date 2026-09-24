'use strict';

/**
 * appleIdentityToken.js
 *
 * Verifica l'identityToken di "Accedi con Apple" (JWT firmato da Apple con
 * RS256). Le chiavi pubbliche arrivano dal JWKS ufficiale
 * https://appleid.apple.com/auth/keys: jose le mette in cache e le ricarica
 * da solo quando compare un `kid` nuovo.
 *
 * Controlla firma, scadenza (exp), issuer e audience (= bundle ID dell'app,
 * cosi' un token emesso per un'altra app non viene accettato).
 */

const { createRemoteJWKSet, jwtVerify } = require('jose');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');
const DEFAULT_AUDIENCE = 'com.shopora';

let remoteJwks = null;
function getRemoteJwks() {
  remoteJwks ??= createRemoteJWKSet(APPLE_JWKS_URL);
  return remoteJwks;
}

/**
 * @param {string} identityToken JWT ricevuto dall'app
 * @param {object} [opts]
 * @param {Function} [opts.keyResolver] solo per i test: sostituisce il JWKS remoto
 * @param {string}   [opts.audience]    bundle ID atteso (default APPLE_BUNDLE_ID o com.shopora)
 * @returns {Promise<object>} payload del token; `sub` e' l'ID Apple stabile dell'utente
 */
async function verifyAppleIdentityToken(identityToken, { keyResolver, audience } = {}) {
  const { payload } = await jwtVerify(identityToken, keyResolver ?? getRemoteJwks(), {
    issuer: APPLE_ISSUER,
    audience: audience ?? process.env.APPLE_BUNDLE_ID ?? DEFAULT_AUDIENCE,
    algorithms: ['RS256'],
  });
  if (typeof payload.sub !== 'string' || !payload.sub) {
    const err = new Error('Token Apple senza sub');
    err.code = 'ERR_JWT_CLAIM_VALIDATION_FAILED';
    throw err;
  }
  return payload;
}

const INVALID_TOKEN_CODES = new Set([
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

/**
 * true se l'errore dice che il TOKEN e' sbagliato (firma, scadenza, claim,
 * formato) -> 401. false per problemi nostri o di rete (JWKS non raggiungibile)
 * -> il chiamante risponde 503 e l'utente puo' riprovare.
 */
function isInvalidAppleTokenError(e) {
  const code = e?.code;
  if (typeof code !== 'string') return false;
  return code.startsWith('ERR_JWT_') || code.startsWith('ERR_JWS_') ||
    code.startsWith('ERR_JOSE_ALG') || INVALID_TOKEN_CODES.has(code);
}

module.exports = { verifyAppleIdentityToken, isInvalidAppleTokenError };
