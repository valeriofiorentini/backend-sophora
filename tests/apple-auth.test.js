// Logica di POST /api/user/apple-auth con database e verifica token finti:
// interessa soprattutto che non si possa collegare un account altrui.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

function stub(rel, exports) {
  const file = require.resolve(path.join('..', 'src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

// ─── DB in memoria (solo le chiamate che appleAuth usa) ──────────────────────
let users;
let nextId;
const db = {
  user: {
    async findUnique({ where }) {
      const [k, v] = Object.entries(where)[0];
      return users.find(u => u[k] === v) ?? null;
    },
    async create({ data }) {
      const u = { id: `u${nextId++}`, googleId: null, appleId: null, isProfileCompleted: false, password: 'x', fcmToken: 't', ...data };
      users.push(u);
      return u;
    },
    async update({ where, data }) {
      const u = users.find(x => x.id === where.id);
      Object.assign(u, data);
      return u;
    },
  },
};

let tokenResult; // payload da restituire, oppure errore da lanciare
stub('config/database', db);
stub('config/s3', { uploadToS3: async () => {} });
stub('utils/otp', { createOtp: async () => {}, verifyOtp: async () => {} });
stub('utils/email', { sendOtpEmail: async () => {}, sendPasswordResetEmail: async () => {} });
stub('utils/jwt', {
  generateAccessToken: id => `AT-${id}`,
  generateRefreshToken: async id => `RT-${id}`,
  rotateRefreshToken: async () => {},
  revokeAllTokens: async () => {},
});
const realTokenUtil = require('../src/utils/appleIdentityToken');
stub('utils/appleIdentityToken', {
  isInvalidAppleTokenError: realTokenUtil.isInvalidAppleTokenError,
  verifyAppleIdentityToken: async () => {
    if (tokenResult instanceof Error) throw tokenResult;
    return tokenResult;
  },
});

const { appleAuth } = require('../src/controllers/user.controller');

async function call(body, headers = {}) {
  let out;
  const res = { status(c) { this.code = c; return this; }, json(b) { out = { code: this.code, body: b }; return this; } };
  await appleAuth({ body, headers }, res);
  return out;
}

const validToken = (over = {}) => ({ sub: 'apple-sub-1', email: 'x@privaterelay.appleid.com', email_verified: 'true', ...over });

beforeEach(() => { users = []; nextId = 1; tokenResult = validToken(); });

test('senza identityToken -> 400', async () => {
  const r = await call({});
  assert.strictEqual(r.code, 400);
});

test('token non valido -> 401', async () => {
  tokenResult = Object.assign(new Error('scaduto'), { code: 'ERR_JWT_EXPIRED' });
  const r = await call({ identityToken: 'x' });
  assert.strictEqual(r.code, 401);
});

test('JWKS Apple non raggiungibile -> 503, non 401', async () => {
  tokenResult = new TypeError('fetch failed');
  const r = await call({ identityToken: 'x' });
  assert.strictEqual(r.code, 503);
});

test('primo login: crea utente con email del token, nome dal body, stessa forma di google-auth', async () => {
  const r = await call({ identityToken: 'x', user: { givenName: 'Mario', familyName: 'Rossi', email: 'ignorata@x.it' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.success, true);
  assert.strictEqual(r.body.data.accessToken, 'AT-u1');
  assert.strictEqual(r.body.data.refreshToken, 'RT-u1');
  const u = r.body.data.user;
  assert.strictEqual(u.email, 'x@privaterelay.appleid.com');
  assert.strictEqual(u.name, 'Mario');
  assert.strictEqual(u.surname, 'Rossi');
  // false: il signup dell'app usa questo flag per aprire "completa profilo"
  assert.strictEqual(u.isProfileCompleted, false);
  for (const secret of ['appleId', 'googleId', 'password', 'fcmToken']) {
    assert.ok(!(secret in u), `${secret} non deve arrivare al client`);
  }
  assert.strictEqual(users[0].appleId, 'apple-sub-1');
});

test('login successivo (Apple non rimanda user): ritrova l\'utente per sub, nessun duplicato', async () => {
  await call({ identityToken: 'x', user: { givenName: 'Mario' } });
  tokenResult = validToken({ email: undefined, email_verified: undefined });
  const r = await call({ identityToken: 'x' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(users.length, 1);
  assert.strictEqual(r.body.data.user.name, 'Mario');
  // dal secondo login il profilo risulta completo: la schermata compare una volta sola
  assert.strictEqual(r.body.data.user.isProfileCompleted, true);
});

test('collega un account esistente solo tramite email verificata nel token', async () => {
  users.push({ id: 'u9', email: 'mario@gmail.com', appleId: null, googleId: 'g1', isProfileCompleted: true });
  tokenResult = validToken({ email: 'Mario@Gmail.com' });
  const r = await call({ identityToken: 'x' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].appleId, 'apple-sub-1');
  assert.strictEqual(r.body.data.accessToken, 'AT-u9');
});

test('3.1.1: un abbonato (Stripe) che entra da iOS riceve isSubscribed=false, ma il DB resta com\'e', async () => {
  users.push({ id: 'u9', email: 'mario@gmail.com', appleId: null, isSubscribed: true, isProfileCompleted: true });
  tokenResult = validToken({ email: 'mario@gmail.com' });
  const r = await call({ identityToken: 'x' }, { 'x-platform': 'ios' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.data.user.isSubscribed, false);
  assert.strictEqual(users[0].isSubscribed, true, 'il dato reale non va toccato');
});

test('3.1.1: lo stesso abbonato da Android continua a risultare abbonato', async () => {
  users.push({ id: 'u9', email: 'mario@gmail.com', appleId: null, isSubscribed: true, isProfileCompleted: true });
  tokenResult = validToken({ email: 'mario@gmail.com' });
  const r = await call({ identityToken: 'x' }, { 'x-platform': 'android' });
  assert.strictEqual(r.body.data.user.isSubscribed, true);
});

test('SICUREZZA: email del body (non firmata) NON collega un account esistente', async () => {
  users.push({ id: 'u9', email: 'vittima@gmail.com', appleId: null, isProfileCompleted: true });
  tokenResult = validToken({ email: undefined, email_verified: undefined }); // token senza email
  const r = await call({ identityToken: 'x', user: { email: 'vittima@gmail.com' } });
  assert.strictEqual(r.code, 409);
  assert.strictEqual(users[0].appleId, null);
});

test('SICUREZZA: email del token non verificata non collega un account esistente', async () => {
  users.push({ id: 'u9', email: 'vittima@gmail.com', appleId: null, isProfileCompleted: true });
  tokenResult = validToken({ email: 'vittima@gmail.com', email_verified: 'false' });
  const r = await call({ identityToken: 'x' });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(users[0].appleId, null);
});

test('stessa email ma account gia collegato a un altro Apple ID -> 409', async () => {
  users.push({ id: 'u9', email: 'mario@gmail.com', appleId: 'altro-sub', isProfileCompleted: true });
  tokenResult = validToken({ email: 'mario@gmail.com' });
  const r = await call({ identityToken: 'x' });
  assert.strictEqual(r.code, 409);
});

test('nessuna email ne\' nel token ne\' nel body e utente sconosciuto -> errore controllato', async () => {
  tokenResult = validToken({ email: undefined, email_verified: undefined });
  const r = await call({ identityToken: 'x' });
  assert.strictEqual(r.code, 400);
  assert.strictEqual(users.length, 0);
});

test('email solo nel body e libera: crea un account nuovo', async () => {
  tokenResult = validToken({ email: undefined, email_verified: undefined });
  const r = await call({ identityToken: 'x', user: { email: 'nuovo@esempio.it', givenName: 'Anna' } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(users[0].email, 'nuovo@esempio.it');
});

test('username univoco quando la parte prima della @ e gia presa', async () => {
  users.push({ id: 'u9', email: 'x@altro.it', username: 'x', appleId: null });
  tokenResult = validToken({ email: 'x@privaterelay.appleid.com' });
  const r = await call({ identityToken: 'x' });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(users[1].username, 'x1');
});
