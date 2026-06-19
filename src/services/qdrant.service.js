/**
 * Qdrant HTTP client wrapper.
 * Docs: https://qdrant.github.io/qdrant/redoc/index.html
 *
 * Collections:
 *   - "products"     : product embeddings from barcode scans + Open Food Facts seed
 *   - "flyer_items"  : flyer product embeddings with storeChain + validUntil metadata
 */

const axios = require('axios');

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const VECTOR_SIZE = 1536; // text-embedding-3-small

const qdrant = axios.create({ baseURL: QDRANT_URL, timeout: 10000 });

// ── Collection management ──────────────────────────────────────────────────

async function ensureCollection(name) {
  try {
    await qdrant.get(`/collections/${name}`);
  } catch {
    await qdrant.put(`/collections/${name}`, {
      vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      optimizers_config: { default_segment_number: 2 },
    });
  }
}

async function ensureCollections() {
  await Promise.all([
    ensureCollection('products'),
    ensureCollection('flyer_items'),
  ]);
}

// ── Upsert ─────────────────────────────────────────────────────────────────

async function upsertProduct({ id, vector, payload }) {
  await qdrant.put('/collections/products/points', {
    points: [{ id, vector, payload }],
  });
}

async function upsertFlyerItem({ id, vector, payload }) {
  await qdrant.put('/collections/flyer_items/points', {
    points: [{ id, vector, payload }],
  });
}

async function upsertBatch(collection, points) {
  await qdrant.put(`/collections/${collection}/points`, { points });
}

// ── Search ─────────────────────────────────────────────────────────────────

async function searchProducts({ vector, limit = 10, scoreThreshold = 0.75 }) {
  const res = await qdrant.post('/collections/products/points/search', {
    vector,
    limit,
    score_threshold: scoreThreshold,
    with_payload: true,
  });
  return res.data.result || [];
}

async function searchFlyerItems({ vector, limit = 20, scoreThreshold = 0.60, filters = {} }) {
  const must = [];

  // Only return items still valid
  must.push({
    key: 'valid_until_ts',
    range: { gte: Math.floor(Date.now() / 1000) },
  });

  if (filters.storeChain) {
    must.push({ key: 'store_chain', match: { value: filters.storeChain } });
  }

  const res = await qdrant.post('/collections/flyer_items/points/search', {
    vector,
    limit,
    score_threshold: scoreThreshold,
    with_payload: true,
    filter: must.length > 0 ? { must } : undefined,
  });
  return res.data.result || [];
}

// ── Delete ─────────────────────────────────────────────────────────────────

async function deleteExpiredFlyerItems() {
  const now = Math.floor(Date.now() / 1000);
  await qdrant.post('/collections/flyer_items/points/delete', {
    filter: { must: [{ key: 'valid_until_ts', range: { lt: now } }] },
  });
}

module.exports = {
  ensureCollections,
  ensureCollection,
  upsertProduct,
  upsertFlyerItem,
  upsertBatch,
  searchProducts,
  searchFlyerItems,
  deleteExpiredFlyerItems,
};
