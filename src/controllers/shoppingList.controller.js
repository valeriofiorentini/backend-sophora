/**
 * shoppingList.controller.js
 *
 * GET /api/shopping-list/smart
 *   Restituisce i prodotti ricorrenti dell'utente (da scontrini ultimi 90gg)
 *   con il prezzo stimato per catena + la catena più economica per quella lista.
 *
 * POST /api/shopping-list/estimate
 *   Body: { items: [{name, quantity}], budget?: number, userLat?, userLon? }
 *   Stima il costo di una lista personalizzata per catena e consiglia
 *   il supermercato più vicino tra quelli economici.
 */

const prisma = require('../config/database');
const { success, error } = require('../utils/response');

const WINDOW_DAYS   = 90;
const MIN_PURCHASES = 2;
const MAX_ITEMS     = 40;
const PRICES_WINDOW = 365;

function normalizeKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function round2(n) { return Math.round(n * 100) / 100; }
const { haversineKm: distanceKm } = require('../services/geo.service');

// ─── GET /api/shopping-list/smart ─────────────────────────────────────────────
async function getSmartList(req, res) {
  const userId = req.userId;
  const since  = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

  // 1. Prodotti ricorrenti dell'utente
  const items = await prisma.receiptItem.findMany({
    where: {
      receipt: { userId, status: 'processed' },
      unitPrice: { gt: 0 },
      OR: [
        { receipt: { receiptDate: { gte: since } } },
        { receipt: { receiptDate: null, processedAt: { gte: since } } },
      ],
    },
    select: { name: true, quantity: true, unitPrice: true, totalPrice: true },
  });

  const groups = new Map();
  for (const it of items) {
    const key = normalizeKey(it.name);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, name: it.name, prices: [], count: 0, totalSpent: 0 });
    const g = groups.get(key);
    g.prices.push(Number(it.unitPrice));
    g.count++;
    g.totalSpent += Number(it.totalPrice) || 0;
    if (it.name.length > g.name.length) g.name = it.name;
  }

  const recurring = [...groups.values()]
    .filter(g => g.count >= MIN_PURCHASES)
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, MAX_ITEMS)
    .map(g => ({
      productKey:  g.key,
      name:        g.name,
      avgPrice:    round2(median(g.prices)),
      purchases:   g.count,
      suggested:   true,
    }));

  if (recurring.length === 0) {
    return success(res, {
      suggestions: [],
      message: `Scansiona almeno uno scontrino — dopo ${MIN_PURCHASES} acquisti dello stesso prodotto lo suggerisco automaticamente.`,
    });
  }

  // 2. Prezzi per catena (PriceHistory)
  const priceSince = new Date(Date.now() - PRICES_WINDOW * 86_400_000);
  const history = await prisma.priceHistory.findMany({
    where: {
      productKey: { in: recurring.map(r => r.productKey) },
      observedAt: { gte: priceSince },
    },
    select: { productKey: true, storeChain: true, price: true },
  });

  // chain → productKey → [prezzi]
  const byChain = new Map();
  for (const h of history) {
    if (!byChain.has(h.storeChain)) byChain.set(h.storeChain, new Map());
    const m = byChain.get(h.storeChain);
    if (!m.has(h.productKey)) m.set(h.productKey, []);
    m.get(h.productKey).push(Number(h.price));
  }

  // 3. Stima costo lista per catena
  const chainEstimates = [];
  for (const [chain, products] of byChain.entries()) {
    let total = 0;
    let covered = 0;
    for (const r of recurring) {
      const prices = products.get(r.productKey);
      if (prices?.length) {
        total += median(prices);
        covered++;
      } else {
        total += r.avgPrice; // fallback: prezzo medio pagato dall'utente
      }
    }
    if (covered > 0) {
      chainEstimates.push({
        chain,
        estimatedTotal: round2(total),
        coverage:       Math.round((covered / recurring.length) * 100),
      });
    }
  }
  chainEstimates.sort((a, b) => a.estimatedTotal - b.estimatedTotal);

  const bestChain = chainEstimates[0] ?? null;

  return success(res, {
    suggestions:    recurring,
    chainEstimates: chainEstimates.slice(0, 5),
    bestChain,
    totalItems:     recurring.length,
  });
}

// ─── POST /api/shopping-list/estimate ─────────────────────────────────────────
async function estimateList(req, res) {
  const { items = [], budget, userLat, userLon } = req.body;

  if (!items.length) return error(res, 'Lista vuota');

  const keys = items.map(i => normalizeKey(i.name));
  const priceSince = new Date(Date.now() - PRICES_WINDOW * 86_400_000);

  const history = await prisma.priceHistory.findMany({
    where: { productKey: { in: keys }, observedAt: { gte: priceSince } },
    select: { productKey: true, storeChain: true, price: true },
  });

  const byChain = new Map();
  for (const h of history) {
    if (!byChain.has(h.storeChain)) byChain.set(h.storeChain, new Map());
    const m = byChain.get(h.storeChain);
    if (!m.has(h.productKey)) m.set(h.productKey, []);
    m.get(h.productKey).push(Number(h.price));
  }

  const chainEstimates = [];
  for (const [chain, products] of byChain.entries()) {
    let total = 0; let covered = 0;
    const itemsDetail = items.map(item => {
      const key = normalizeKey(item.name);
      const prices = products.get(key);
      const qty = item.quantity || 1;
      if (prices?.length) {
        const p = round2(median(prices) * qty);
        total += p;
        covered++;
        return { name: item.name, price: round2(median(prices)), qty, lineTotal: p, found: true };
      }
      return { name: item.name, price: null, qty, lineTotal: null, found: false };
    });
    chainEstimates.push({
      chain,
      estimatedTotal: round2(total),
      coverage:       Math.round((covered / items.length) * 100),
      items:          itemsDetail,
      affordableWith: budget ? Math.floor(budget / (total / covered || 1)) : null,
    });
  }
  chainEstimates.sort((a, b) => a.estimatedTotal - b.estimatedTotal);

  // Se ha coordinate, cerca il negozio più vicino tra i top 3 catene
  let nearestStore = null;
  if (userLat && userLon && chainEstimates.length > 0) {
    const topChains = chainEstimates.slice(0, 3).map(c => c.chain);
    // Il campo sul model Store è "chain" (non "storeChain"): usare storeChain qui
    // faceva crashare la query in 500 → "Impossibile stimare i prezzi" lato app.
    const stores = await prisma.store.findMany({
      where: { chain: { in: topChains } },
      select: { id: true, name: true, chain: true, latitude: true, longitude: true, address: true },
      take: 50,
    });
    let best = null; let bestDist = Infinity;
    for (const s of stores) {
      if (!s.latitude || !s.longitude) continue;
      const d = distanceKm(userLat, userLon, Number(s.latitude), Number(s.longitude));
      // storeChain: alias per il frontend (che legge nearestStore.storeChain)
      if (d < bestDist) { bestDist = d; best = { ...s, storeChain: s.chain, distanceKm: round2(d) }; }
    }
    nearestStore = best;
  }

  return success(res, {
    chainEstimates: chainEstimates.slice(0, 5),
    bestChain:      chainEstimates[0] ?? null,
    nearestStore,
    budget:         budget ?? null,
  });
}

module.exports = { getSmartList, estimateList };
