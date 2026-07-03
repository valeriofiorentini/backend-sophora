const { test } = require('node:test');
const assert = require('node:assert');
const {
  cleanStr, cleanDate, clampQuantity, clampPrice, clampPercent, normalizeProductKey,
} = require('../src/utils/sanitize');

test('cleanStr: "null"/"N/A"/vuote → null', () => {
  assert.strictEqual(cleanStr('null'), null);
  assert.strictEqual(cleanStr('N/A'), null);
  assert.strictEqual(cleanStr('  '), null);
  assert.strictEqual(cleanStr('-'), null);
  assert.strictEqual(cleanStr(undefined), null);
});

test('cleanStr: stringhe valide passano trimmate', () => {
  assert.strictEqual(cleanStr('  Conad  '), 'Conad');
});

test('cleanDate: date invalide o assurde → null', () => {
  assert.strictEqual(cleanDate('non-una-data'), null);
  assert.strictEqual(cleanDate('1995-01-01'), null);   // prima del 2000
  assert.strictEqual(cleanDate('2093-01-01'), null);   // troppo nel futuro
  assert.strictEqual(cleanDate(null), null);
});

test('cleanDate: data valida → Date', () => {
  const d = cleanDate('2026-06-15');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.getFullYear(), 2026);
});

test('clampQuantity: valori assurdi limitati', () => {
  assert.strictEqual(clampQuantity(999999), 1000);
  assert.strictEqual(clampQuantity(-5), 1);
  assert.strictEqual(clampQuantity('abc'), 1);
  assert.strictEqual(clampQuantity(3), 3);
});

test('clampPrice: negativo → 0, enorme → cap', () => {
  assert.strictEqual(clampPrice(-2), 0);
  assert.strictEqual(clampPrice(999999999), 100000);
  assert.strictEqual(clampPrice(1.99), 1.99);
});

test('clampPercent: 0-100', () => {
  assert.strictEqual(clampPercent(150), 100);
  assert.strictEqual(clampPercent(-10), 0);
  assert.strictEqual(clampPercent(30), 30);
});

test('normalizeProductKey: chiave stabile', () => {
  assert.strictEqual(normalizeProductKey('Pasta Barilla 500g'), 'pasta_barilla_500g');
  assert.strictEqual(normalizeProductKey('Pasta   Barilla!!! 500g'), 'pasta_barilla_500g');
});
