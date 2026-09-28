const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { haversineKm: distanceKm, bboxWhere } = require('../services/geo.service');
const redis = require('../services/redis.service');

// TTL cache promos: 2 minuti — le promo cambiano poche volte al giorno
// (scraper notturno + post community), la lettura è la query più calda dell'app.
const PROMOS_CACHE_TTL = 120;

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

  // Solo i negozi entro 100 km dall'utente: il bounding box usa gli indici
  // e evita di caricare l'intera tabella a ogni richiesta
  const stores = await prisma.store.findMany({
    where: bboxWhere(lat, lon, 100),
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
  const { latitude, longitude, chain, radius = 30, page = 1, limit = 10 } = req.query;
  const now = new Date();
  const pageNum  = Math.max(1, parseInt(page));
  const pageSize = Math.min(50, Math.max(1, parseInt(limit)));

  const lat = parseFloat(latitude);
  const lon = parseFloat(longitude);
  const r   = Math.min(parseFloat(radius) || 30, 500);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

  // Cache per zona: coordinate arrotondate a ~1km (2 decimali) così utenti
  // vicini condividono la stessa entry invece di generarne una a testa.
  const cacheKey = `promos:${hasCoords ? `${lat.toFixed(2)}:${lon.toFixed(2)}` : 'global'}:${r}:${chain || ''}:${pageNum}:${pageSize}`;
  // NB: redis.service salva valori raw → serializziamo noi (su Redis vero un
  // oggetto diventerebbe "[object Object]"; il fallback in-memory lo maschererebbe)
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try { return success(res, JSON.parse(cached)); } catch { /* cache corrotta: rigenera */ }
  }

  const promos = await prisma.promo.findMany({
    where: {
      validUntil: { gt: now },
      ...(chain && { storeChain: { contains: chain, mode: 'insensitive' } }),
      // Bounding box direttamente nel WHERE: le promo lontane non vengono
      // proprio caricate. Quelle senza coordinate (nazionali) passano sempre.
      ...(hasCoords && {
        OR: [
          { latitude: null },
          { longitude: null },
          { AND: [bboxWhere(lat, lon, r)] },
        ],
      }),
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // Filtro circolare preciso + arricchimento indirizzo
  let result = promos;
  if (hasCoords) {
    result = promos.filter(p => {
      if (!p.latitude || !p.longitude) return true;
      return distanceKm(lat, lon, p.latitude, p.longitude) <= r;
    });

    result = await enrichWithNearestStore(result, lat, lon);
    result.sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
  }

  // L'import salva lo stesso volantino su piu' zone vicine: chi sta a meta' strada
  // le vedrebbe due volte. Si tiene una sola copia (la prima, cioe' la piu' vicina).
  const seenOffers = new Set();
  result = result.filter(p => {
    const k = `${p.storeChain}|${p.productName}|${p.price}|${new Date(p.validUntil).getTime()}`;
    if (seenOffers.has(k)) return false;
    seenOffers.add(k);
    return true;
  });

  const total = result.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const safePage = Math.min(pageNum, totalPages);
  const paginated = result.slice((safePage - 1) * pageSize, safePage * pageSize);

  const payload = {
    promos: paginated,
    total,
    page: safePage,
    totalPages,
    pageSize,
  };
  redis.set(cacheKey, JSON.stringify(payload), PROMOS_CACHE_TTL).catch(() => {});
  return success(res, payload);
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
