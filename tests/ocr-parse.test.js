const { test } = require('node:test');
const assert = require('node:assert');
const { parseOcrJson } = require('../src/services/receiptOcr.service');

test('parseOcrJson: JSON pulito', () => {
  const r = parseOcrJson('{"totalAmount": 12.5}');
  assert.strictEqual(r.totalAmount, 12.5);
});

test('parseOcrJson: JSON in fence markdown ```json', () => {
  const r = parseOcrJson('```json\n{"storeName": "Conad"}\n```');
  assert.strictEqual(r.storeName, 'Conad');
});

test('parseOcrJson: testo prima e dopo il JSON', () => {
  const r = parseOcrJson('Ecco il risultato: {"items": []} spero vada bene');
  assert.deepStrictEqual(r.items, []);
});

test('parseOcrJson: input vuoto → null', () => {
  assert.strictEqual(parseOcrJson(''), null);
  assert.strictEqual(parseOcrJson(null), null);
});

test('parseOcrJson: JSON malformato → lancia', () => {
  assert.throws(() => parseOcrJson('{totale: non json'));
});
