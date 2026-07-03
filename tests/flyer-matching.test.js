const { test } = require('node:test');
const assert = require('node:assert');
const { isSupermarketFlyer } = require('../scripts/import-flyer-prices');

// Bug reale (lug 2026): il match era per uguaglianza esatta contro la
// whitelist, ma Coop su Tiendeo non compare mai come "coop" da sola —
// sempre come "Ipercoop"/"Extracoop"/ecc. → zero volantini Coop importati.
test('isSupermarketFlyer: varianti Coop composte riconosciute', () => {
  assert.strictEqual(isSupermarketFlyer('Ipercoop'), true);
  assert.strictEqual(isSupermarketFlyer('Extracoop'), true);
  assert.strictEqual(isSupermarketFlyer('Superstore Coop'), true);
  assert.strictEqual(isSupermarketFlyer('Nova Coop'), true);
});

test('isSupermarketFlyer: catene note riconosciute', () => {
  assert.strictEqual(isSupermarketFlyer('Conad'), true);
  assert.strictEqual(isSupermarketFlyer('Lidl'), true);
  assert.strictEqual(isSupermarketFlyer('Esselunga'), true);
});

test('isSupermarketFlyer: sotto-brand non alimentari esclusi anche se contengono una catena', () => {
  assert.strictEqual(isSupermarketFlyer('Parafarmacia Conad'), false);
  assert.strictEqual(isSupermarketFlyer('Pet Store Conad'), false);
});

test('isSupermarketFlyer: insegne non supermercato escluse', () => {
  assert.strictEqual(isSupermarketFlyer('Mobilandia'), false);
  assert.strictEqual(isSupermarketFlyer('Comet'), false);
  assert.strictEqual(isSupermarketFlyer('Expert'), false);
});

test('isSupermarketFlyer: input vuoto/mancante → false', () => {
  assert.strictEqual(isSupermarketFlyer(''), false);
  assert.strictEqual(isSupermarketFlyer(null), false);
  assert.strictEqual(isSupermarketFlyer(undefined), false);
});

test('isSupermarketFlyer: case-insensitive', () => {
  assert.strictEqual(isSupermarketFlyer('IPERCOOP'), true);
  assert.strictEqual(isSupermarketFlyer('ipercoop'), true);
});
