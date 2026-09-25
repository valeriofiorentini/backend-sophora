const { test } = require('node:test');
const assert = require('node:assert');
const { extractShoppingList } = require('../src/utils/shoppingList');

const item = (n, p) => `{"name":"${n}","quantity":1,"estimatedPrice":${p},"unit":"pz","category":"Test"}`;

test('blocco completo: ritorna il JSON intero com\'e', () => {
  const t = `Ecco:\n<shopping_list>{"items":[${item('Pasta', 0.9)},${item('Riso', 1.4)}],"estimatedTotal":2.3,"recommendedStore":"Lidl"}</shopping_list>`;
  const m = extractShoppingList(t);
  assert.strictEqual(m.items.length, 2);
  assert.strictEqual(m.estimatedTotal, 2.3);
  assert.strictEqual(m.recommendedStore, 'Lidl');
  assert.strictEqual(m.truncated, undefined);
});

test('nessun blocco: null', () => {
  assert.strictEqual(extractShoppingList('Solo testo, nessuna lista.'), null);
  assert.strictEqual(extractShoppingList(''), null);
  assert.strictEqual(extractShoppingList(undefined), null);
});

test('risposta TRONCATA a meta\' di un prodotto: recupera quelli completi', () => {
  const t = `Lista ricca:\n<shopping_list>{"items":[${item('Pasta', 0.9)},${item('Riso', 1.4)},{"name":"Uova bio","quantity":12,"estimatedPri`;
  const m = extractShoppingList(t);
  assert.strictEqual(m.items.length, 2);
  assert.deepStrictEqual(m.items.map(i => i.name), ['Pasta', 'Riso']);
  assert.strictEqual(m.estimatedTotal, 2.3);
  assert.strictEqual(m.truncated, true);
});

test('troncata subito dopo un prodotto completo: lo tiene', () => {
  const t = `<shopping_list>{"items":[${item('Pane', 1.5)},`;
  const m = extractShoppingList(t);
  assert.strictEqual(m.items.length, 1);
});

test('graffe e virgolette dentro le stringhe non confondono il recupero', () => {
  const t = `<shopping_list>{"items":[{"name":"Sugo \\"al basilico\\" {bio}","quantity":1,"estimatedPrice":1.2,"unit":"pz","category":"Salse"},{"name":"Olio`;
  const m = extractShoppingList(t);
  assert.strictEqual(m.items.length, 1);
  assert.strictEqual(m.items[0].name, 'Sugo "al basilico" {bio}');
});

test('troncata prima del primo prodotto completo: null (niente lista a meta\')', () => {
  assert.strictEqual(extractShoppingList('<shopping_list>{"items":[{"name":"Pas'), null);
  assert.strictEqual(extractShoppingList('<shopping_list>{"ite'), null);
});

test('JSON non valido ma chiuso e senza items recuperabili: null', () => {
  assert.strictEqual(extractShoppingList('<shopping_list>non json</shopping_list>'), null);
});
