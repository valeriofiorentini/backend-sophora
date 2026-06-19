const prisma = require('../config/database');
const { embed, productEmbedInput } = require('../services/embedding.service');
const qdrant = require('../services/qdrant.service');
const { success, error } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');

/**
 * Find similar products in Qdrant for a given barcode / product name.
 * Called when user scans a barcode — returns cheaper alternatives of the same category.
 */
async function findSimilar(req, res) {
  const { barcode, name, category, brand } = req.body;
  if (!name && !barcode) return error(res, 'name o barcode obbligatorio');

  const inputText = productEmbedInput({ name: name || barcode, category, brand });

  let vector;
  try {
    vector = await embed(inputText);
  } catch (err) {
    console.error('Embedding error:', err.message);
    return error(res, 'Embedding non disponibile', 503);
  }

  let results = [];
  try {
    results = await qdrant.searchProducts({ vector, limit: 8, scoreThreshold: 0.72 });
  } catch {
    // Qdrant not available yet (cold start) — return empty
    return success(res, { alternatives: [], message: 'Database semantico in costruzione' });
  }

  // Exclude the same product (exact barcode match)
  const filtered = results.filter(r => !barcode || r.payload.barcode !== barcode);

  // Enrich with latest price from PriceHistory
  const productKeys = filtered.map(r => r.payload.product_key).filter(Boolean);
  const prices = productKeys.length > 0
    ? await prisma.priceHistory.findMany({
        where: { productKey: { in: productKeys } },
        orderBy: { observedAt: 'desc' },
        distinct: ['productKey', 'storeChain'],
        take: 40,
      })
    : [];

  const priceMap = {};
  for (const p of prices) {
    if (!priceMap[p.productKey]) priceMap[p.productKey] = [];
    priceMap[p.productKey].push({ storeChain: p.storeChain, price: p.price, isOnSale: p.isOnSale });
  }

  const alternatives = filtered.map(r => ({
    score: parseFloat(r.score.toFixed(3)),
    name: r.payload.name,
    brand: r.payload.brand || null,
    barcode: r.payload.barcode || null,
    category: r.payload.category || null,
    image: r.payload.image || null,
    prices: priceMap[r.payload.product_key] || [],
    bestPrice: priceMap[r.payload.product_key]?.reduce((min, p) => p.price < min ? p.price : min, Infinity) ?? null,
  }));

  // Sort by bestPrice ascending (cheapest first)
  alternatives.sort((a, b) => (a.bestPrice ?? 999) - (b.bestPrice ?? 999));

  return success(res, { alternatives, inputProduct: { name, category, brand, barcode } });
}

/**
 * Index a scanned product into Qdrant so it becomes part of the similarity database.
 * Called internally after barcode scan + Open Food Facts fetch.
 */
async function indexProduct(req, res) {
  const { name, barcode, category, brand, image } = req.body;
  if (!name) return error(res, 'name obbligatorio');

  const productKey = normalizeProductKey(name);
  const inputText = productEmbedInput({ name, category, brand });

  let vector;
  try {
    vector = await embed(inputText);
  } catch {
    return error(res, 'Embedding fallito', 503);
  }

  // Use a deterministic UUID from productKey so duplicate scans upsert instead of duplicate
  const pointId = deterministicUUID(productKey);

  try {
    await qdrant.upsertProduct({
      id: pointId,
      vector,
      payload: {
        name,
        barcode: barcode || null,
        category: category || null,
        brand: brand || null,
        image: image || null,
        product_key: productKey,
        indexed_at: Math.floor(Date.now() / 1000),
      },
    });
  } catch {
    return error(res, 'Qdrant non disponibile', 503);
  }

  return success(res, { indexed: true, productKey });
}

/**
 * Seed bulk products from Open Food Facts data (called by admin/cron).
 * Body: { products: [{name, barcode, category, brand, image}] }
 */
async function seedProducts(req, res) {
  const { products } = req.body;
  if (!Array.isArray(products) || products.length === 0) return error(res, 'products[] obbligatorio');
  if (products.length > 200) return error(res, 'Max 200 prodotti per batch');

  const texts = products.map(p => productEmbedInput({ name: p.name, category: p.category, brand: p.brand }));

  let vectors;
  try {
    const { embedBatch } = require('../services/embedding.service');
    vectors = await embedBatch(texts);
  } catch {
    return error(res, 'Embedding batch fallito', 503);
  }

  const points = products.map((p, i) => {
    const productKey = normalizeProductKey(p.name);
    return {
      id: deterministicUUID(productKey),
      vector: vectors[i],
      payload: {
        name: p.name,
        barcode: p.barcode || null,
        category: p.category || null,
        brand: p.brand || null,
        image: p.image || null,
        product_key: productKey,
        indexed_at: Math.floor(Date.now() / 1000),
      },
    };
  });

  try {
    await qdrant.upsertBatch('products', points);
  } catch {
    return error(res, 'Qdrant non disponibile', 503);
  }

  return success(res, { seeded: points.length }, 201);
}

function normalizeProductKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
}

// Deterministic UUID v5-like using simple hash (avoids uuid/v5 dependency)
function deterministicUUID(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const chr = key.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `${hex}-0000-0000-0000-000000000000`;
}

module.exports = { findSimilar, indexProduct, seedProducts };
