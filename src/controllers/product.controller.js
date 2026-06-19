const prisma = require('../config/database');
const axios = require('axios');
const { success, error } = require('../utils/response');

async function getProductsByStore(req, res) {
  const { storeId } = req.params;
  const { search, category, onSale } = req.query;

  const products = await prisma.product.findMany({
    where: {
      storeId,
      ...(search && { name: { contains: search, mode: 'insensitive' } }),
      ...(category && { category }),
      ...(onSale === 'true' && { isOnSale: true }),
    },
    orderBy: { name: 'asc' },
  });

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
