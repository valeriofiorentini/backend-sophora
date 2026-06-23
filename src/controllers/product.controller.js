const prisma = require('../config/database');
const axios = require('axios');
const { success, error } = require('../utils/response');

async function getProductsByStore(req, res) {
  const { storeId } = req.params;
  const { search, category, onSale } = req.query;

  const { getChainProductsFromHistory, getChainPromos } = require('./store.controller');

  const store = await prisma.store.findUnique({
    where: { id: storeId }
  });
  if (!store) return error(res, 'Negozio non trovato', 404);

  let products = await prisma.product.findMany({
    where: {
      storeId,
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
      ...(category && { category }),
      ...(onSale === 'true' && { isOnSale: true }),
    },
    orderBy: { name: 'asc' },
  });

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
    for (const p of products) {
      const key = p.name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
      mergedProductsMap.set(key, p);
    }

    let mergedList = [...mergedProductsMap.values()];

    // Apply search/category/onSale filters on the merged list
    if (search) {
      const searchLower = search.toLowerCase();
      mergedList = mergedList.filter(p => p.name.toLowerCase().includes(searchLower));
    }
    if (category) {
      mergedList = mergedList.filter(p => p.category === category);
    }
    if (onSale === 'true') {
      mergedList = mergedList.filter(p => p.isOnSale);
    }

    products = mergedList;
  }

  return success(res, { products });
}

async function getProductById(req, res) {
  const product = await prisma.product.findUnique({
    where: { id: req.params.productId },
    include: { store: true },
  });
  if (!product) return error(res, 'Prodotto non trovato', 404);
  return success(res, { product });
}

async function getProductByBarcode(req, res) {
  const { barcode } = req.params;

  // Check local DB first
  const localProducts = await prisma.product.findMany({
    where: { barcode },
    include: { store: true },
  });

  if (localProducts.length > 0) {
    return success(res, { products: localProducts, source: 'local' });
  }

  // Fallback: Open Food Facts (free, no key required)
  try {
    const { data } = await axios.get(`https://world.openfoodfacts.org/api/v0/product/${barcode}.json`, { timeout: 5000 });

    if (data.status === 1) {
      const p = data.product;
      return success(res, {
        products: [],
        openFoodFacts: {
          name: p.product_name || p.product_name_it || 'Prodotto sconosciuto',
          brand: p.brands,
          category: p.categories,
          image: p.image_url,
          barcode,
        },
        source: 'open_food_facts',
      });
    }
  } catch {
    // Silently fall through if external API fails
  }

  return success(res, { products: [], source: 'not_found' });
}

module.exports = { getProductsByStore, getProductById, getProductByBarcode };
