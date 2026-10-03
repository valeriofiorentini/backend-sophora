const { test } = require('node:test');
const assert = require('node:assert');
const { canonicalizeChain } = require('../src/utils/storeChain');

test('varianti Coop → Ipercoop unica (root cause bug offerte duplicate)', () => {
  assert.strictEqual(canonicalizeChain('IPER COOP'), 'Ipercoop');
  assert.strictEqual(canonicalizeChain('Ipercoop'), 'Ipercoop');
  assert.strictEqual(canonicalizeChain('EXTRACOOP'), 'Ipercoop');
  assert.strictEqual(canonicalizeChain('Extra Coop'), 'Ipercoop');
});

test('catene note normalizzate a forma canonica', () => {
  assert.strictEqual(canonicalizeChain('conad city'), 'Conad');
  assert.strictEqual(canonicalizeChain('CARREFOUR EXPRESS'), 'Carrefour');
  assert.strictEqual(canonicalizeChain('  esselunga  '), 'Esselunga');
  assert.strictEqual(canonicalizeChain('SUPERMERCATI PIM'), 'Pim');
});

test("In's Mercato non viene confuso con Mercatò", () => {
  assert.strictEqual(canonicalizeChain("In's Mercato"), "In's Mercato");
  assert.strictEqual(canonicalizeChain("IN'S MERCATO SPA"), "In's Mercato");
  assert.strictEqual(canonicalizeChain('INS MERCATO'), "In's Mercato");
  assert.strictEqual(canonicalizeChain('Mercatò'), 'Mercatò');
  assert.strictEqual(canonicalizeChain('MERCATO'), 'Mercatò');
});

test('catena non mappata: solo ripulita (trim + spazi singoli)', () => {
  assert.strictEqual(canonicalizeChain('  Bottega   Verde '), 'Bottega Verde');
});

test('null/vuoto passano invariati', () => {
  assert.strictEqual(canonicalizeChain(null), null);
  assert.strictEqual(canonicalizeChain(''), '');
});
