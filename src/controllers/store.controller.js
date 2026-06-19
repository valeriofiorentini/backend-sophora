const prisma = require('../config/database');
const { success, error } = require('../utils/response');

// Haversine formula — distance in km between two coordinates
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getStoresByLocation(req, res) {
  const { a, latitude, longitude, radius = 10, filter } = req.query;

  let lat, lon;
  if (a) {
    // Frontend passes location as JSON: { type: 'Point', coordinates: [lon, lat], address }
    try {
      const loc = JSON.parse(decodeURIComponent(a));
      [lon, lat] = loc.coordinates;
    } catch {
      return error(res, 'Formato posizione non valido');
    }
  } else if (latitude && longitude) {
    lat = parseFloat(latitude);
    lon = parseFloat(longitude);
  } else {
    return error(res, 'Posizione obbligatoria');
  }
  const r = parseFloat(radius);

  // Rough bounding box to limit DB query before haversine
  const latDelta = r / 111;
  const lonDelta = r / (111 * Math.cos((lat * Math.PI) / 180));

  let stores = await prisma.store.findMany({
    where: {
      latitude: { gte: lat - latDelta, lte: lat + latDelta },
      longitude: { gte: lon - lonDelta, lte: lon + lonDelta },
    },
    include: { _count: { select: { products: true } } },
  });

  stores = stores
    .map(s => ({ ...s, distance: haversine(lat, lon, s.latitude, s.longitude) }))
    .filter(s => s.distance <= r)
    .sort((a, b) => {
      if (filter === 'price') return (a.rating ?? 0) - (b.rating ?? 0);
      if (filter === 'promotions') return (b._count.products ?? 0) - (a._count.products ?? 0);
      return a.distance - b.distance; // default: closest first
    });

  return success(res, { stores });
}

async function getStoreById(req, res) {
  const store = await prisma.store.findUnique({
    where: { id: req.params.storeId },
    include: { products: { take: 20 } },
  });
  if (!store) return error(res, 'Negozio non trovato', 404);
  return success(res, { store });
}

async function getNearbyStoresForProduct(req, res) {
  const { productId } = req.params;
  // Frontend sends ?long=X&lat=Y
  const { long, lat: latQ, latitude, longitude } = req.query;
  const latitude_ = latQ || latitude;
  const longitude_ = long || longitude;

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { barcode: true, name: true },
  });
  if (!product) return error(res, 'Prodotto non trovato', 404);

  // Find same product (by barcode or name) in other stores
  const sameProducts = await prisma.product.findMany({
    where: product.barcode
      ? { barcode: product.barcode, id: { not: productId } }
      : { name: { contains: product.name, mode: 'insensitive' }, id: { not: productId } },
    include: { store: true },
    take: 10,
  });

  let results = sameProducts.map(p => ({
    product: p,
    store: p.store,
    distance: latitude_ && longitude_
      ? haversine(parseFloat(latitude_), parseFloat(longitude_), p.store.latitude, p.store.longitude)
      : null,
  }));

  if (latitude_ && longitude_) results.sort((a, b) => a.distance - b.distance);

  return success(res, { nearbyStores: results });
}

module.exports = { getStoresByLocation, getStoreById, getNearbyStoresForProduct };
