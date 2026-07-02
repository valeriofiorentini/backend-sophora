const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { haversineKm: haversine } = require('../services/geo.service');

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
  let store = await prisma.store.findUnique({
    where: { id: req.params.storeId },
    include: { products: { take: 20 } },
  });
  if (!store) return error(res, 'Negozio non trovato', 404);

  if (store.chain) {
    const virtualProducts = await getChainProductsFromHistory(store.chain);
    const flyerPromos = await getChainPromos(store.chain);

    // Merge virtual products and flyer promos
    const mergedProductsMap = new Map();

    // 1. Put flyer promos first (high priority)
    for (const p of flyerPromos) {
      const key = p.name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
      mergedProductsMap.set(key, p);
    }

    // 2. Put receipt prices if not already present
    for (const p of virtualProducts) {
      const key = p.name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
      if (!mergedProductsMap.has(key)) {
        mergedProductsMap.set(key, p);
      }
    }

    // Merge with any existing products from the store (Product table)
    for (const p of store.products) {
      const key = p.name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
      mergedProductsMap.set(key, p);
    }

    const mergedList = [...mergedProductsMap.values()];

    store = {
      ...store,
      products: mergedList.slice(0, 50)
    };
  }

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

async function getChainProductsFromHistory(chainName) {
  if (!chainName) return [];

  // Fetch unique product keys and their latest prices from PriceHistory for this chain
  const history = await prisma.priceHistory.findMany({
    where: {
      storeChain: { equals: chainName, mode: 'insensitive' }
    },
    orderBy: { observedAt: 'desc' }
  });

  // Unique by productKey (since they are ordered desc by observedAt, the first one seen is the latest)
  const latestPrices = new Map();
  for (const h of history) {
    if (!latestPrices.has(h.productKey)) {
      latestPrices.set(h.productKey, h);
    }
  }

  if (latestPrices.size === 0) return [];

  // Fetch receipt items for this chain to map productKey to a nice display name and category
  const receiptItems = await prisma.receiptItem.findMany({
    where: {
      receipt: {
        storeChain: { equals: chainName, mode: 'insensitive' }
      }
    },
    select: {
      name: true,
      category: true,
      barcode: true
    }
  });

  // Map normalized name (productKey) to the display details (keep first seen name/details)
  const keyToDetails = new Map();
  for (const item of receiptItems) {
    const key = item.name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
    if (!keyToDetails.has(key)) {
      keyToDetails.set(key, {
        name: item.name,
        category: item.category,
        barcode: item.barcode
      });
    }
  }

  // Build virtual products
  const virtualProducts = [];
  for (const [productKey, h] of latestPrices.entries()) {
    const details = keyToDetails.get(productKey) || {
      name: productKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      category: null,
      barcode: null
    };

    virtualProducts.push({
      id: h.id, // use price history ID as product ID
      name: details.name,
      barcode: details.barcode,
      description: `Prezzo da scontrino (${h.source === 'receipt_ocr' ? 'rilevato' : 'volantino'})`,
      price: Number(h.price),
      originalPrice: null,
      isOnSale: h.isOnSale,
      category: details.category,
      createdAt: h.observedAt,
      updatedAt: h.observedAt,
      source: h.source
    });
  }

  return virtualProducts;
}

async function getChainPromos(chainName) {
  if (!chainName) return [];
  const promos = await prisma.promo.findMany({
    where: {
      storeChain: { equals: chainName, mode: 'insensitive' },
      validUntil: { gt: new Date() }
    },
    orderBy: { createdAt: 'desc' }
  });

  return promos.map(p => ({
    id: p.id,
    name: p.productName,
    barcode: null,
    description: `Offerta volantino (valida fino al ${p.validUntil.toLocaleDateString('it-IT')})`,
    price: p.price,
    originalPrice: p.originalPrice,
    isOnSale: true,
    category: null,
    image: p.imageUrl,
    createdAt: p.createdAt,
    updatedAt: p.createdAt,
    source: 'flyer_promo'
  }));
}

module.exports = {
  getStoresByLocation,
  getStoreById,
  getNearbyStoresForProduct,
  getChainProductsFromHistory,
  getChainPromos
};
