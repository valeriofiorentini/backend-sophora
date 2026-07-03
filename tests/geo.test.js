const { test } = require('node:test');
const assert = require('node:assert');
const { haversineKm, bboxWhere } = require('../src/services/geo.service');

test('haversineKm: Roma-Milano ≈ 477 km', () => {
  const d = haversineKm(41.9028, 12.4964, 45.4642, 9.19);
  assert.ok(d > 460 && d < 500, `distanza fuori range: ${d}`);
});

test('haversineKm: stesso punto = 0', () => {
  assert.strictEqual(haversineKm(41.9, 12.5, 41.9, 12.5), 0);
});

test('haversineKm: simmetrica', () => {
  const ab = haversineKm(41.9, 12.5, 45.46, 9.19);
  const ba = haversineKm(45.46, 9.19, 41.9, 12.5);
  assert.ok(Math.abs(ab - ba) < 0.001);
});

test('bboxWhere: genera bounds che contengono il punto', () => {
  const w = bboxWhere(41.9, 12.5, 10);
  assert.ok(w.latitude.gte < 41.9 && w.latitude.lte > 41.9);
  assert.ok(w.longitude.gte < 12.5 && w.longitude.lte > 12.5);
});

test('bboxWhere: raggio più grande = box più grande', () => {
  const small = bboxWhere(41.9, 12.5, 5);
  const big   = bboxWhere(41.9, 12.5, 50);
  assert.ok(big.latitude.lte - big.latitude.gte > small.latitude.lte - small.latitude.gte);
});
