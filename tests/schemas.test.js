const { test } = require('node:test');
const assert = require('node:assert');
const s = require('../src/validation/schemas');

// ─── Auth ─────────────────────────────────────────────────────────────────────
test('signup: senza password → rifiutato', () => {
  assert.strictEqual(s.signupSchema.safeParse({ email: 'a@b.it' }).success, false);
});

test('login: email+password → ok', () => {
  assert.strictEqual(s.loginSchema.safeParse({ email: 'a@b.it', password: 'x' }).success, true);
});

// ─── Multipart: stringhe vuote e coercizione ──────────────────────────────────
test('feed multipart: rating "" → undefined (non 0)', () => {
  const r = s.feedCreateSchema.safeParse({ name: 'Conad', rating: '' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.rating, undefined);
});

test('feed: rating "4.5" (stringa) → 4.5 (numero)', () => {
  const r = s.feedCreateSchema.safeParse({ rating: '4.5' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.rating, 4.5);
});

test('feed: rating 7 fuori scala → rifiutato', () => {
  assert.strictEqual(s.feedCreateSchema.safeParse({ rating: 7 }).success, false);
});

test('feed: type non enum → rifiutato', () => {
  assert.strictEqual(s.feedCreateSchema.safeParse({ type: 'bogus' }).success, false);
});

// ─── Dispensa ─────────────────────────────────────────────────────────────────
test('pantry: senza name → rifiutato', () => {
  assert.strictEqual(s.pantryItemSchema.safeParse({ quantity: 2 }).success, false);
});

test('pantry: quantity 0 → rifiutato', () => {
  assert.strictEqual(s.pantryItemSchema.safeParse({ name: 'Latte', quantity: 0 }).success, false);
});

// ─── Posizione ────────────────────────────────────────────────────────────────
test('location: latitudine 91 → rifiutata', () => {
  assert.strictEqual(s.locationSchema.safeParse({ latitude: 91, longitude: 12 }).success, false);
});

// ─── Route optimizer ──────────────────────────────────────────────────────────
test('routeOptimize: senza storeIds → rifiutato', () => {
  assert.strictEqual(s.routeOptimizeSchema.safeParse({ userLat: 41.9, userLon: 12.5 }).success, false);
});

test('routeOptimize: 21 negozi → rifiutato (max 20)', () => {
  const r = s.routeOptimizeSchema.safeParse({
    userLat: 41.9, userLon: 12.5, storeIds: Array(21).fill('id'),
  });
  assert.strictEqual(r.success, false);
});

// ─── Lista spesa smart ────────────────────────────────────────────────────────
test('estimateList: items vuoto → rifiutato', () => {
  assert.strictEqual(s.estimateListSchema.safeParse({ items: [] }).success, false);
});

test('estimateList: item con nome → ok, budget stringa coercito', () => {
  const r = s.estimateListSchema.safeParse({ items: [{ name: 'Pasta' }], budget: '60' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.budget, 60);
});

// ─── Correzione scontrino ─────────────────────────────────────────────────────
test('correction: senza consent esplicito → rifiutato', () => {
  assert.strictEqual(s.receiptCorrectionSchema.safeParse({ receiptId: 'x', consent: false }).success, false);
  assert.strictEqual(s.receiptCorrectionSchema.safeParse({ receiptId: 'x' }).success, false);
});

test('correction: consent true → ok', () => {
  assert.strictEqual(s.receiptCorrectionSchema.safeParse({ receiptId: 'x', consent: true }).success, true);
});

// ─── Voucher ──────────────────────────────────────────────────────────────────
test('voucher purchase: catalogId obbligatorio', () => {
  assert.strictEqual(s.voucherPurchaseSchema.safeParse({}).success, false);
  assert.strictEqual(s.voucherPurchaseSchema.safeParse({ catalogId: 'abc' }).success, true);
});

// ─── Similarity ───────────────────────────────────────────────────────────────
test('similarity find: senza barcode né name → rifiutato', () => {
  assert.strictEqual(s.similarityFindSchema.safeParse({ category: 'x' }).success, false);
  assert.strictEqual(s.similarityFindSchema.safeParse({ name: 'Latte' }).success, true);
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
test('chat: message vuoto/mancante → rifiutato', () => {
  assert.strictEqual(s.chatMessageSchema.safeParse({}).success, false);
  assert.strictEqual(s.chatMessageSchema.safeParse({ message: '' }).success, false);
});

test('chat: message valido → ok, sessionId opzionale', () => {
  assert.strictEqual(s.chatMessageSchema.safeParse({ message: 'Ciao' }).success, true);
  assert.strictEqual(s.chatMessageSchema.safeParse({ message: 'Ciao', sessionId: 'abc' }).success, true);
});

test('chat: message oltre 2000 char → rifiutato', () => {
  assert.strictEqual(s.chatMessageSchema.safeParse({ message: 'x'.repeat(2001) }).success, false);
});

// ─── Carrello ─────────────────────────────────────────────────────────────────
test('cart add: senza productId → rifiutato', () => {
  assert.strictEqual(s.cartAddSchema.safeParse({ quantity: 2 }).success, false);
});

test('cart add: productId ok, quantity coercita da stringa', () => {
  const r = s.cartAddSchema.safeParse({ productId: 'p1', quantity: '3' });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data.quantity, 3);
});

test('cart update: quantity 0 ammessa (= rimuovi)', () => {
  assert.strictEqual(s.cartUpdateSchema.safeParse({ productId: 'p1', quantity: 0 }).success, true);
});

test('cart update: quantity decimale → rifiutata (solo interi)', () => {
  assert.strictEqual(s.cartUpdateSchema.safeParse({ productId: 'p1', quantity: 2.5 }).success, false);
});
