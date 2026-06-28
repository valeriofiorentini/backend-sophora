/**
 * routing.controller.js
 * Multi-stop route optimizer.
 * Recupera i negozi dal DB e chiama il ML Service per l'ottimizzazione.
 */

const { success, error } = require('../utils/response');
const { optimizeRoute } = require('../services/ml.service');
const prisma = require('../config/database');
const { isPremium } = require('../utils/planLimits');

/**
 * POST /api/routing/optimize
 * Body: {
 *   userLat, userLon,
 *   storeIds: ['id1', 'id2', ...],   // negozi selezionati dall'utente
 *   cartItems: [{productName, preferredChain}],  // articoli del carrello
 *   returnHome: true
 * }
 *
 * Per ogni negozio, calcola il risparmio stimato rispetto al prezzo medio
 * dei prodotti che l'utente deve comprare lì.
 */
async function optimizeShoppingRoute(req, res) {
  const { userLat, userLon, storeIds, cartItems = [], returnHome = true } = req.body;

  if (!await isPremium(req.userId)) {
    return error(res, 'Il percorso ottimizzato è una funzione Premium. Abbonati a Shopora Premium.', 403);
  }

  if (!userLat || !userLon) return error(res, 'userLat e userLon obbligatori');
  if (!storeIds?.length) return error(res, 'Seleziona almeno un negozio');

  // Carica negozi dal DB
  const stores = await prisma.store.findMany({
    where: { id: { in: storeIds } },
    select: { id: true, name: true, storeChain: true, latitude: true, longitude: true },
  });

  if (!stores.length) return error(res, 'Negozi non trovati', 404);

  // Per ogni negozio calcola risparmio stimato (confronto prezzi dal DB)
  const storePayloads = await Promise.all(
    stores.map(async store => {
      let estimatedSaving = 0;
      const itemsForStore = [];

      for (const item of cartItems) {
        const productKey = item.productName
          ?.toLowerCase()
          .replace(/\s+/g, '_')
          .replace(/[^a-z0-9_]/g, '')
          .slice(0, 80);
        if (!productKey) continue;

        // Prezzo medio su questo negozio vs media globale
        const [storeAvg, globalAvg] = await Promise.all([
          prisma.priceHistory.aggregate({
            where: { productKey, storeChain: store.storeChain },
            _avg: { price: true },
          }),
          prisma.priceHistory.aggregate({
            where: { productKey },
            _avg: { price: true },
          }),
        ]);

        const sp = storeAvg._avg.price ? Number(storeAvg._avg.price) : null;
        const gp = globalAvg._avg.price ? Number(globalAvg._avg.price) : null;

        if (sp && gp && sp < gp) {
          estimatedSaving += gp - sp;
          itemsForStore.push(item.productName);
        } else if (sp) {
          itemsForStore.push(item.productName);
        }
      }

      return {
        store_id: store.id,
        store_name: store.name,
        store_chain: store.storeChain || 'Unknown',
        lat: store.latitude || 0,
        lon: store.longitude || 0,
        items_to_buy: itemsForStore,
        estimated_saving: Math.round(estimatedSaving * 100) / 100,
      };
    })
  );

  // Filtra negozi senza coordinate
  const validStores = storePayloads.filter(s => s.lat !== 0 && s.lon !== 0);
  if (!validStores.length) return error(res, 'I negozi selezionati non hanno coordinate GPS', 422);

  // Chiama ML Service
  const result = await optimizeRoute(userLat, userLon, validStores, returnHome);

  if (result) return success(res, result);

  // Fallback: ordine per distanza semplice (senza 2-opt)
  const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  let curLat = userLat, curLon = userLon;
  const remaining = [...validStores];
  const steps = [];
  let cumulative = 0;

  while (remaining.length) {
    const nearest = remaining.reduce((best, s) => {
      const d = haversine(curLat, curLon, s.lat, s.lon);
      return !best || d < best.dist ? { s, dist: d } : best;
    }, null);
    const dist = nearest.dist;
    cumulative += dist;
    steps.push({
      order: steps.length + 1,
      ...nearest.s,
      distance_from_prev_km: Math.round(dist * 100) / 100,
      cumulative_km: Math.round(cumulative * 100) / 100,
    });
    curLat = nearest.s.lat;
    curLon = nearest.s.lon;
    remaining.splice(remaining.indexOf(nearest.s), 1);
  }

  const totalSaving = steps.reduce((s, x) => s + x.estimated_saving, 0);

  return success(res, {
    total_km: Math.round(cumulative * 100) / 100,
    total_saving: Math.round(totalSaving * 100) / 100,
    steps,
    efficiency_score: Math.round((totalSaving / Math.max(cumulative, 0.1)) * 100) / 100,
    note: 'Ottimizzazione fallback (ML Service non disponibile)',
  });
}

module.exports = { optimizeShoppingRoute };
