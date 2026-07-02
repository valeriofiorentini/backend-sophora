const prisma = require('../config/database');
const { success, error } = require('../utils/response');

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// "Conad Superstore" / "CONAD CITY" → "conad" (parola chiave catena per il match con Store)
function chainKey(name) {
  if (!name) return '';
  const s = String(name).toLowerCase();
  // catene note: prendi il marchio principale
  const known = ['conad', 'coop', 'esselunga', 'carrefour', 'lidl', 'eurospin', 'pam',
    'panorama', 'todis', 'despar', 'spar', 'sigma', 'crai', 'penny', 'famila', 'tigre',
    'tigros', 'iper', 'bennet', 'unes', 'simply', 'deco', 'auchan', 'md', 'in\'s', 'ins'];
  for (const k of known) if (s.includes(k)) return k;
  return s.split(/\s+/)[0] || s;
}

/**
 * Aggancia ad ogni promo (che è a livello catena) il negozio REALE più vicino
 * della stessa catena, così l'utente vede l'indirizzo del punto vendita.
 * Se non trova un negozio della catena, lascia la promo invariata.
 */
async function enrichWithNearestStore(promos, lat, lon) {
  if (!lat || !lon || promos.length === 0) return promos;

  // Carica i negozi una volta sola, raggruppati per chiave catena
  const stores = await prisma.store.findMany({
    select: { name: true, address: true, latitude: true, longitude: true, chain: true },
    take: 5000,
  });
  if (stores.length === 0) return promos;

  const byChain = new Map();
  for (const st of stores) {
    if (st.latitude == null || st.longitude == null) continue;
    const k = chainKey(st.chain || st.name);
    if (!byChain.has(k)) byChain.set(k, []);
    byChain.get(k).push(st);
  }

  return promos.map(p => {
    const k = chainKey(p.storeChain || p.storeName);
    const candidates = byChain.get(k);
    if (!candidates || !candidates.length) return p;

    let best = null, bestDist = Infinity;
    for (const st of candidates) {
      const d = distanceKm(lat, lon, st.latitude, st.longitude);
      if (d < bestDist) { bestDist = d; best = st; }
    }
    if (!best) return p;

    return {
      ...p,
      storeName:    best.name || p.storeName,
      storeAddress: best.address || null,
      distanceKm:   Math.round(bestDist * 10) / 10,
    };
  });
}

async function getPromos(req, res) {
  const { latitude, longitude, chain, radius = 50, page = 1, limit = 10 } = req.query;
  const now = new Date();
  const pageNum  = Math.max(1, parseInt(page));
  const pageSize = Math.min(50, Math.max(1, parseInt(limit)));

  const promos = await prisma.promo.findMany({
    where: {
      validUntil: { gt: now },
      ...(chain && { storeChain: { contains: chain, mode: 'insensitive' } }),
    },
    orderBy: { createdAt: 'desc' },
    take: 500, // fetch abbastanza per filtrare per distanza, poi paginiamo in-memory
  });

  // Filter by distance if coordinates provided
  let result = promos;
  if (latitude && longitude) {
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const r = parseFloat(radius);

    result = promos.filter(p => {
      if (!p.latitude || !p.longitude) return true;
      return distanceKm(lat, lon, p.latitude, p.longitude) <= r;
    });

    result = await enrichWithNearestStore(result, lat, lon);
    result.sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
  }

  const total = result.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const safePage = Math.min(pageNum, totalPages);
  const paginated = result.slice((safePage - 1) * pageSize, safePage * pageSize);

  return success(res, {
    promos: paginated,
    total,
    page: safePage,
    totalPages,
    pageSize,
  });
}

async function getTodayPromos(req, res) {
  const now = new Date();
  const promos = await prisma.promo.findMany({
    where: { validUntil: { gt: now } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  return success(res, { promos });
}

async function deletePromo(req, res) {
  await prisma.promo.deleteMany({
    where: { validUntil: { lt: new Date() } },
  });
  return success(res, { message: 'Promo scadute eliminate' });
}

module.exports = { getPromos, getTodayPromos, deletePromo };
