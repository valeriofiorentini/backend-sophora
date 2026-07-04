const { test } = require('node:test');
const assert = require('node:assert');
const { isNonPantryItem, inferCategory, VALID_CATEGORIES } = require('../src/services/pantrySync.service');

test('isNonPantryItem: buste e shopper esclusi dalla dispensa', () => {
  assert.strictEqual(isNonPantryItem('SHOPPER MAT-BIO'), true);
  assert.strictEqual(isNonPantryItem('Busta ecologica'), true);
  assert.strictEqual(isNonPantryItem('Sacchetto frutta'), true);
});

test('isNonPantryItem: cibo NON escluso', () => {
  assert.strictEqual(isNonPantryItem('Pasta Barilla'), false);
  assert.strictEqual(isNonPantryItem('Latte intero'), false);
});

test('inferCategory: categorie corrette per prodotti comuni', () => {
  assert.strictEqual(inferCategory('Banane bio'), 'frutta_verdura');
  assert.strictEqual(inferCategory('Latte parzialmente scremato'), 'latticini');
  assert.strictEqual(inferCategory('Prosciutto cotto'), 'carne_pesce');
  assert.strictEqual(inferCategory('Spaghetti n.5'), 'pane_pasta');
  assert.strictEqual(inferCategory('Acqua naturale 1.5L'), 'bevande');
  assert.strictEqual(inferCategory('Carta igienica 4 rotoli'), 'igiene_casa');
});

test('inferCategory: prodotto sconosciuto → altro', () => {
  assert.strictEqual(inferCategory('Xyzabc introvabile'), 'altro');
});

test('inferCategory: uova → latticini anche con nome grezzo/brand sconosciuto', () => {
  // Caso reale: l'AI aveva assegnato "altro" a questo prodotto, ma il nome
  // contiene "uova" → deve vincere latticini, non il fallback generico.
  assert.strictEqual(inferCategory('COCCODI UOVA ANTIOBI'), 'latticini');
  assert.strictEqual(inferCategory('Uova fresche 6 pz'), 'latticini');
});

test('VALID_CATEGORIES: contiene le chiavi enum del backend', () => {
  for (const cat of ['frutta_verdura', 'carne_pesce', 'pane_pasta', 'dolci_snack', 'dispensa', 'igiene_casa', 'altro']) {
    assert.ok(VALID_CATEGORIES.has(cat), `manca ${cat}`);
  }
});

test('inferCategory: output sempre in VALID_CATEGORIES', () => {
  for (const name of ['Banane', 'Latte', 'Pollo', 'Pane', 'Acqua', 'Kinder', 'Olio', 'Detersivo', 'Boh']) {
    assert.ok(VALID_CATEGORIES.has(inferCategory(name)), `categoria non valida per ${name}`);
  }
});
