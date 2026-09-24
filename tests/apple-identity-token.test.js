const { test } = require('node:test');
const assert = require('node:assert');
const { generateKeyPair, SignJWT } = require('jose');
const {
  verifyAppleIdentityToken,
  isInvalidAppleTokenError,
} = require('../src/utils/appleIdentityToken');

const ISS = 'https://appleid.apple.com';
const AUD = 'com.shopora';

async function makeKey() {
  return generateKeyPair('RS256');
}

function sign(privateKey, { iss = ISS, aud = AUD, sub = '001234.abcdef', exp = '5m', alg = 'RS256', extra = {} } = {}) {
  const jwt = new SignJWT({ email: 'a@privaterelay.appleid.com', email_verified: 'true', ...extra })
    .setProtectedHeader({ alg, kid: 'test-key' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt();
  if (sub !== null) jwt.setSubject(sub);
  jwt.setExpirationTime(exp);
  return jwt.sign(privateKey);
}

test('token valido: ritorna il payload con sub', async () => {
  const { publicKey, privateKey } = await makeKey();
  const token = await sign(privateKey);
  const payload = await verifyAppleIdentityToken(token, { keyResolver: async () => publicKey });
  assert.strictEqual(payload.sub, '001234.abcdef');
  assert.strictEqual(payload.email, 'a@privaterelay.appleid.com');
});

test('audience di un\'altra app viene rifiutata', async () => {
  const { publicKey, privateKey } = await makeKey();
  const token = await sign(privateKey, { aud: 'com.altra.app' });
  await assert.rejects(
    verifyAppleIdentityToken(token, { keyResolver: async () => publicKey }),
    e => isInvalidAppleTokenError(e),
  );
});

test('issuer diverso da Apple viene rifiutato', async () => {
  const { publicKey, privateKey } = await makeKey();
  const token = await sign(privateKey, { iss: 'https://evil.example.com' });
  await assert.rejects(
    verifyAppleIdentityToken(token, { keyResolver: async () => publicKey }),
    e => isInvalidAppleTokenError(e),
  );
});

test('token scaduto viene rifiutato', async () => {
  const { publicKey, privateKey } = await makeKey();
  const token = await sign(privateKey, { exp: Math.floor(Date.now() / 1000) - 60 });
  await assert.rejects(
    verifyAppleIdentityToken(token, { keyResolver: async () => publicKey }),
    e => e.code === 'ERR_JWT_EXPIRED' && isInvalidAppleTokenError(e),
  );
});

test('firma con una chiave diversa da quella pubblicata viene rifiutata', async () => {
  const good = await makeKey();
  const attacker = await makeKey();
  const token = await sign(attacker.privateKey);
  await assert.rejects(
    verifyAppleIdentityToken(token, { keyResolver: async () => good.publicKey }),
    e => isInvalidAppleTokenError(e),
  );
});

test('token manomesso (payload cambiato) viene rifiutato', async () => {
  const { publicKey, privateKey } = await makeKey();
  const token = await sign(privateKey);
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ iss: ISS, aud: AUD, sub: 'vittima', exp: 4102444800 })).toString('base64url');
  await assert.rejects(
    verifyAppleIdentityToken(`${h}.${forged}.${s}`, { keyResolver: async () => publicKey }),
    e => isInvalidAppleTokenError(e),
  );
});

test('token senza sub viene rifiutato', async () => {
  const { publicKey, privateKey } = await makeKey();
  const token = await sign(privateKey, { sub: null });
  await assert.rejects(
    verifyAppleIdentityToken(token, { keyResolver: async () => publicKey }),
    e => isInvalidAppleTokenError(e),
  );
});

test('spazzatura non-JWT viene rifiutata come token invalido', async () => {
  const { publicKey } = await makeKey();
  await assert.rejects(
    verifyAppleIdentityToken('non-un-jwt', { keyResolver: async () => publicKey }),
    e => isInvalidAppleTokenError(e),
  );
});

test('errori di rete/JWKS non contano come token invalido (-> 503)', () => {
  assert.strictEqual(isInvalidAppleTokenError(new TypeError('fetch failed')), false);
  assert.strictEqual(isInvalidAppleTokenError({ code: 'ERR_JWKS_TIMEOUT' }), false);
  assert.strictEqual(isInvalidAppleTokenError(undefined), false);
});
