const { test } = require('node:test');
const assert = require('node:assert');
const { parseOcrJson, mergeOverlap } = require('../src/services/receiptOcr.service');

const item = (name, price) => ({ name, totalPrice: price });

test('risposta AI tagliata a metà: recupera i prodotti completi e i totali', () => {
  const full = JSON.stringify({
    storeName: 'Pim', totalAmount: 114.67, totalDiscount: 1.2,
    items: [item('Latte', 1.15), item('Pane', 1.49), item('Uova', 2.99)],
  });
  const cut = full.slice(0, full.indexOf('Uova') + 6); // troncata dentro l'ultimo prodotto
  const parsed = parseOcrJson(cut);
  assert.strictEqual(parsed.totalAmount, 114.67);
  assert.deepStrictEqual(parsed.items.map(i => i.name), ['Latte', 'Pane']);
});

test('risposta valida resta invariata', () => {
  const parsed = parseOcrJson('```json\n{"totalAmount":5,"items":[{"name":"A","totalPrice":5}]}\n```');
  assert.strictEqual(parsed.items.length, 1);
});

test('foto sovrapposte: le righe in comune vengono contate una volta', () => {
  const foto1 = [item('Pane', 1.49), item('Yogurt B.0,1% 500g', 0.99), item('Banane', 1.97)];
  const foto2 = [item('Yogurt B 0.1% 500G', 0.99), item('Banane', 1.97), item('Fichi', 1.96)];
  assert.deepStrictEqual(mergeOverlap(foto1, foto2).map(i => i.name), ['Fichi']);
});

test('foto quasi uguali (sovrapposizione di 45 righe): niente prodotti raddoppiati', () => {
  const all = Array.from({length: 60}, (_, i) => item(`Prodotto ${i}`, 1 + i / 100));
  const foto2 = all.slice(0, 50);   // righe 0-49
  const foto3 = all.slice(5, 60);   // righe 5-59: 45 in comune con foto2
  const merged = [...foto2, ...mergeOverlap(foto2, foto3)];
  assert.deepStrictEqual(merged.map(i => i.name), all.map(i => i.name));
});

test('una riga letta diversamente a fine foto: aggancio comunque trovato', () => {
  const foto1 = [item('A', 1), item('B', 2), item('C', 3), item('D', 4), item('Dx letto male', 5)];
  const foto2 = [item('B', 2), item('C', 3), item('D', 4), item('E', 5), item('F', 6), item('G', 7)];
  assert.deepStrictEqual(mergeOverlap(foto1, foto2).map(i => i.name), ['F', 'G']);
});

test('stessa zona fotografata due volte: nessuna riga aggiunta', () => {
  const foto1 = Array.from({length: 20}, (_, i) => item(`P${i}`, i + 1));
  const foto2 = foto1.slice(8, 16);
  assert.deepStrictEqual(mergeOverlap(foto1, foto2), []);
});

test('doppioni veri lontani dalla giunzione restano', () => {
  const foto1 = [item('Yogurt', 0.99), item('Yogurt', 0.99), item('Pane', 1.49)];
  const foto2 = [item('Latte', 1.15), item('Yogurt', 0.99)];
  assert.deepStrictEqual(mergeOverlap(foto1, foto2).map(i => i.name), ['Latte', 'Yogurt']);
});
