/**
 * flyer.controller.js
 * Replaces the Tesseract-based OCR with GPT-4o Vision for better accuracy.
 * Extracted promo items are embedded and stored in Qdrant for semantic search.
 */

const OpenAI = require('openai');
const prisma = require('../config/database');
const { uploadToS3 } = require('../config/s3');
const { embed, embedBatch, productEmbedInput } = require('../services/embedding.service');
const qdrant = require('../services/qdrant.service');
const { success, error } = require('../utils/response');
const { v4: uuidv4 } = require('uuid');

// OpenRouter (stessa chiave dell'OCR scontrini) con fallback su OpenAI diretta
const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});
const MODEL_VISION = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o' : 'gpt-4o';

const FLYER_PROMPT = `Analizza questo volantino promozionale italiano. Restituisci SOLO un JSON valido:
{
  "storeChain": "catena del supermercato (es: Lidl, Esselunga, Conad)",
  "storeName": "nome specifico o null",
  "validFrom": "YYYY-MM-DD o null",
  "validUntil": "YYYY-MM-DD (data fine offerta, obbligatorio)",
  "items": [
    {
      "name": "nome prodotto normalizzato in italiano",
      "category": "categoria (es: Latticini, Carne, Pasta, Frutta, Bevande, Pulizia)",
      "price": 0.00,
      "originalPrice": 0.00,
      "discountPercent": null,
      "unit": "kg/l/pz/conf",
      "brand": "marca o null"
    }
  ]
}
Estrai TUTTI i prodotti visibili con i loro prezzi. Se non riesci a leggere un prezzo usa null. Non inventare dati.`;

// ── Scan flyer with GPT-4o Vision ──────────────────────────────────────────

async function processFlyerAI(req, res) {
  if (!req.file) return error(res, 'Immagine obbligatoria');

  const { latitude, longitude } = req.body;

  // Upload to S3 (opzionale — se le credenziali AWS mancano si usa null)
  let imageUrl = null;
  try {
    imageUrl = await uploadToS3(req.file, 'flyers');
  } catch (uploadErr) {
    console.warn('[Flyer] S3 upload fallito, continuo senza immagine:', uploadErr.message);
  }

  // GPT-4o ha bisogno dell'URL o del base64 — se S3 non disponibile usiamo base64
  if (!imageUrl) {
    const b64 = req.file.buffer.toString('base64');
    imageUrl = `data:${req.file.mimetype};base64,${b64}`;
  }

  let parsed;
  try {
    const response = await openai.chat.completions.create({
      model: MODEL_VISION,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: FLYER_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
        ],
      }],
      response_format: { type: 'json_object' },
      max_tokens: 3000,
    });
    parsed = JSON.parse(response.choices[0].message.content);
  } catch (err) {
    console.error('GPT-4o flyer error:', err);
    return error(res, 'Errore lettura volantino', 500);
  }

  const items = Array.isArray(parsed.items) ? parsed.items.filter(i => i.name && i.price) : [];
  const validUntil = parsed.validUntil ? new Date(parsed.validUntil) : getDefaultExpiry();

  // Save to Promo table (existing)
  const saved = [];
  for (const item of items) {
    const promo = await prisma.promo.create({
      data: {
        storeName: parsed.storeName || parsed.storeChain || 'Sconosciuto',
        storeChain: parsed.storeChain || null,
        productName: item.name,
        price: item.price ? parseFloat(item.price) : null,
        originalPrice: item.originalPrice ? parseFloat(item.originalPrice) : null,
        discount: item.discountPercent ? `${item.discountPercent}%` : null,
        source: 'ocr_gpt4o',
        validUntil,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
      },
    });
    saved.push({ ...promo, category: item.category, brand: item.brand, unit: item.unit });

    // Alimenta PriceHistory: così i prezzi dei volantini guidano l'advisor
    // "dove conviene" e il forecasting fin dal primo giorno (bootstrap dati).
    if (item.price) {
      const isOnSale = !!(item.discountPercent || (item.originalPrice && parseFloat(item.originalPrice) > parseFloat(item.price)));
      await prisma.priceHistory.create({
        data: {
          productKey: normalizeProductKey(item.name),
          storeChain: parsed.storeChain || 'Sconosciuto',
          price:      parseFloat(item.price),
          isOnSale,
          salePercent: item.discountPercent ? parseFloat(item.discountPercent) : null,
          source:     'flyer_ocr',
        },
      }).catch(() => {}); // ignora duplicati
    }
  }

  // Index in Qdrant asynchronously (don't block response)
  indexFlyerItemsInBackground(saved, parsed.storeChain, validUntil);

  return success(res, {
    storeChain: parsed.storeChain,
    validUntil,
    extractedProducts: saved,
    savedPromos: saved,
    itemCount: saved.length,
    message: `${saved.length} prodotti estratti dal volantino con AI`,
  }, 201);
}

async function indexFlyerItemsInBackground(items, storeChain, validUntil) {
  if (!items.length) return;
  const validUntilTs = Math.floor(validUntil.getTime() / 1000);

  try {
    const texts = items.map(item =>
      productEmbedInput({ name: item.productName, category: item.category, brand: item.brand })
    );
    const vectors = await embedBatch(texts);

    const points = items.map((item, i) => ({
      id: uuidv4(),
      vector: vectors[i],
      payload: {
        promo_id: item.id,
        name: item.productName,
        category: item.category || null,
        brand: item.brand || null,
        price: item.price,
        original_price: item.originalPrice || null,
        store_chain: storeChain || null,
        valid_until_ts: validUntilTs,
      },
    }));

    await qdrant.upsertBatch('flyer_items', points);
  } catch (err) {
    console.error('Qdrant flyer indexing error (non-blocking):', err.message);
  }
}

// ── Semantic search ────────────────────────────────────────────────────────

async function semanticSearch(req, res) {
  const { q, storeChain, lat, lon } = req.query;
  if (!q?.trim()) return error(res, 'q (query) obbligatorio');

  let vector;
  try {
    vector = await embed(q.toLowerCase());
  } catch {
    return error(res, 'Embedding non disponibile', 503);
  }

  let results = [];
  try {
    results = await qdrant.searchFlyerItems({
      vector,
      limit: 20,
      scoreThreshold: 0.58,
      filters: storeChain ? { storeChain } : {},
    });
  } catch {
    // Fallback: keyword search on Promo table if Qdrant unavailable
    return keywordFallback(req, res, q, storeChain);
  }

  if (results.length === 0) {
    return keywordFallback(req, res, q, storeChain);
  }

  const items = results.map(r => ({
    score: parseFloat(r.score.toFixed(3)),
    name: r.payload.name,
    category: r.payload.category,
    brand: r.payload.brand,
    price: r.payload.price,
    originalPrice: r.payload.original_price,
    storeChain: r.payload.store_chain,
    promoId: r.payload.promo_id,
  }));

  return success(res, { items, query: q, source: 'semantic', total: items.length });
}

async function keywordFallback(req, res, q, storeChain) {
  const promos = await prisma.promo.findMany({
    where: {
      validUntil: { gt: new Date() },
      productName: { contains: q, mode: 'insensitive' },
      ...(storeChain && { storeChain: { contains: storeChain, mode: 'insensitive' } }),
    },
    take: 20,
    orderBy: { createdAt: 'desc' },
  });
  return success(res, {
    items: promos.map(p => ({
      name: p.productName, price: p.price, originalPrice: p.originalPrice,
      storeChain: p.storeChain, promoId: p.id, score: null,
    })),
    query: q, source: 'keyword', total: promos.length,
  });
}

// ── Price forecasting data ─────────────────────────────────────────────────

async function getPriceHistory(req, res) {
  const { productKey, storeChain } = req.query;
  if (!productKey) return error(res, 'productKey obbligatorio');

  const history = await prisma.priceHistory.findMany({
    where: {
      productKey,
      ...(storeChain && { storeChain }),
    },
    orderBy: { observedAt: 'asc' },
    take: 100,
  });

  if (history.length === 0) {
    return success(res, { history: [], trend: null, message: 'Dati insufficienti' });
  }

  // Simple trend: compare last 2 months vs previous 2 months
  const now = new Date();
  const twoMonthsAgo = new Date(now); twoMonthsAgo.setMonth(now.getMonth() - 2);
  const fourMonthsAgo = new Date(now); fourMonthsAgo.setMonth(now.getMonth() - 4);

  const recent = history.filter(h => h.observedAt >= twoMonthsAgo);
  const older = history.filter(h => h.observedAt >= fourMonthsAgo && h.observedAt < twoMonthsAgo);

  const avgRecent = recent.length ? recent.reduce((s, h) => s + h.price, 0) / recent.length : null;
  const avgOlder = older.length ? older.reduce((s, h) => s + h.price, 0) / older.length : null;

  let trend = null;
  if (avgRecent && avgOlder) {
    const delta = ((avgRecent - avgOlder) / avgOlder) * 100;
    trend = {
      direction: delta > 2 ? 'up' : delta < -2 ? 'down' : 'stable',
      percentChange: parseFloat(delta.toFixed(1)),
      message: delta > 2
        ? `📈 Prezzo salito del ${Math.abs(delta.toFixed(1))}% negli ultimi 2 mesi`
        : delta < -2
        ? `📉 Prezzo sceso del ${Math.abs(delta.toFixed(1))}% negli ultimi 2 mesi`
        : '➡️ Prezzo stabile',
    };
  }

  // Detect sale cycle
  const saleDates = history.filter(h => h.isOnSale).map(h => h.observedAt);
  let cycleInfo = null;
  if (saleDates.length >= 2) {
    const gaps = [];
    for (let i = 1; i < saleDates.length; i++) {
      gaps.push((saleDates[i] - saleDates[i - 1]) / (1000 * 60 * 60 * 24));
    }
    const avgGap = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    const lastSale = saleDates[saleDates.length - 1];
    const nextSaleEst = new Date(lastSale);
    nextSaleEst.setDate(nextSaleEst.getDate() + avgGap);
    const daysUntilSale = Math.round((nextSaleEst - now) / (1000 * 60 * 60 * 24));
    cycleInfo = {
      avgCycleDays: avgGap,
      lastSaleDate: lastSale,
      nextSaleEstimate: nextSaleEst,
      daysUntilNextSale: daysUntilSale,
      message: daysUntilSale > 0
        ? `🏷️ Prossimo sconto stimato tra ${daysUntilSale} giorni`
        : `🏷️ Sconto atteso ora o molto presto`,
    };
  }

  return success(res, {
    history: history.map(h => ({ date: h.observedAt, price: h.price, isOnSale: h.isOnSale, storeChain: h.storeChain })),
    trend,
    cycleInfo,
    totalObservations: history.length,
  });
}

function getDefaultExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return d;
}

// Stessa normalizzazione usata da receipt/scraper per coerenza delle chiavi prezzo
function normalizeProductKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
}

module.exports = { processFlyerAI, semanticSearch, getPriceHistory };
