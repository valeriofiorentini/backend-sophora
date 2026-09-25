// App Store 3.1.1: su iOS (header X-Platform: ios) nessuno e' Premium finche'
// non c'e' l'IAP, anche se ha un abbonamento Stripe comprato su Android/web.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { getPlatform, isIosRequest } = require('../src/utils/platform');

function stub(rel, exports) {
  const file = require.resolve(path.join('..', 'src', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

let dbUser;
let receiptsUsed;
let chatUsed;
stub('config/database', {
  user:        { findUnique: async () => dbUser },
  receipt:     { count: async () => receiptsUsed },
  chatMessage: { count: async () => chatUsed },
});
const { isPremium, checkReceiptLimit, checkChatLimit } = require('../src/utils/planLimits');

beforeEach(() => {
  dbUser = { isSubscribed: true };
  receiptsUsed = 10; // al limite Free (10/mese)
  chatUsed = 15;     // al limite Free (15/giorno)
});

test('getPlatform: legge X-Platform in minuscolo, null se assente', () => {
  assert.strictEqual(getPlatform({ headers: { 'x-platform': 'IOS' } }), 'ios');
  assert.strictEqual(getPlatform({ headers: { 'x-platform': ' android ' } }), 'android');
  assert.strictEqual(getPlatform({ headers: {} }), null);
  assert.strictEqual(getPlatform({}), null);
  assert.strictEqual(getPlatform(undefined), null);
});

test('isIosRequest', () => {
  assert.strictEqual(isIosRequest({ headers: { 'x-platform': 'ios' } }), true);
  assert.strictEqual(isIosRequest({ headers: { 'x-platform': 'android' } }), false);
  assert.strictEqual(isIosRequest({ headers: {} }), false);
});

test('isPremium: abbonato su Android/web/nessun header e Premium, su iOS no', async () => {
  assert.strictEqual(await isPremium('u1', 'android'), true);
  assert.strictEqual(await isPremium('u1', 'web'), true);
  assert.strictEqual(await isPremium('u1'), true);
  assert.strictEqual(await isPremium('u1', 'ios'), false);
});

test('isPremium: non abbonato resta Free ovunque', async () => {
  dbUser = { isSubscribed: false };
  assert.strictEqual(await isPremium('u1', 'android'), false);
  assert.strictEqual(await isPremium('u1', 'ios'), false);
});

test('limite scontrini: abbonato illimitato su Android, limitato (Free) su iOS', async () => {
  assert.deepStrictEqual(await checkReceiptLimit('u1', 'android'), { allowed: true, used: null, limit: null });
  const ios = await checkReceiptLimit('u1', 'ios');
  assert.strictEqual(ios.allowed, false);
  assert.strictEqual(ios.limit, 10);
});

test('limite chat AI: abbonato illimitato su Android, limitato (Free) su iOS', async () => {
  assert.deepStrictEqual(await checkChatLimit('u1', 'android'), { allowed: true, used: null, limit: null });
  const ios = await checkChatLimit('u1', 'ios');
  assert.strictEqual(ios.allowed, false);
  assert.strictEqual(ios.limit, 15);
});

test('su iOS un utente sotto il limite Free puo comunque usare l\'app', async () => {
  receiptsUsed = 3;
  const r = await checkReceiptLimit('u1', 'ios');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.used, 3);
});
