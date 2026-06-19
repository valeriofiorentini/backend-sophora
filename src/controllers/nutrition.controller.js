const axios = require('axios');
const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const redis = require('../services/redis.service');

const CACHE_TTL_S = 24 * 60 * 60; // 24 hours

async function getNutritionByBarcode(req, res) {
  const { barcode } = req.params;

  // Check cache (Redis or in-memory fallback)
  const cacheKey = `nutrition:${barcode}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return success(res, { nutrition: JSON.parse(cached), source: 'cache' });
  }

  try {
    const { data } = await axios.get(
      `https://world.openfoodfacts.org/api/v2/product/${barcode}?fields=product_name,product_name_it,brands,categories_tags,nutriments,allergens_tags,labels_tags,image_url,ingredients_text`,
      { timeout: 6000 }
    );

    if (data.status !== 1 || !data.product) {
      return success(res, { nutrition: null, source: 'not_found' });
    }

    const p = data.product;
    const n = p.nutriments || {};

    const nutrition = {
      name: p.product_name_it || p.product_name || null,
      brand: p.brands || null,
      image: p.image_url || null,
      ingredients: p.ingredients_text || null,
      per100g: {
        calories: n['energy-kcal_100g'] ?? null,
        carbs: n['carbohydrates_100g'] ?? null,
        sugars: n['sugars_100g'] ?? null,
        fat: n['fat_100g'] ?? null,
        saturatedFat: n['saturated-fat_100g'] ?? null,
        protein: n['proteins_100g'] ?? null,
        fiber: n['fiber_100g'] ?? null,
        salt: n['salt_100g'] ?? null,
      },
      allergens: (p.allergens_tags || []).map(t => t.replace(/^en:/, '')),
      labels: p.labels_tags || [],
      isVegan: (p.labels_tags || []).includes('en:vegan'),
      isVegetarian: (p.labels_tags || []).includes('en:vegetarian'),
      isGlutenFree: (p.labels_tags || []).includes('en:gluten-free'),
      isLactoseFree: (p.labels_tags || []).includes('en:lactose-free'),
      novaGroup: n.nova_group ?? null,
    };

    await redis.set(cacheKey, JSON.stringify(nutrition), CACHE_TTL_S);
    return success(res, { nutrition, source: 'open_food_facts' });
  } catch (err) {
    console.error('OpenFoodFacts error:', err.message);
    return success(res, { nutrition: null, source: 'error' });
  }
}

async function getNutritionProfile(req, res) {
  const profile = await prisma.nutritionProfile.findUnique({
    where: { userId: req.userId },
  });
  return success(res, { profile: profile || null });
}

async function upsertNutritionProfile(req, res) {
  const { dietType, dailyCalories, dailyCarbs, dailyProtein, dailyFat, allergens } = req.body;

  const profile = await prisma.nutritionProfile.upsert({
    where: { userId: req.userId },
    update: {
      dietType: dietType || [],
      dailyCalories: dailyCalories ? parseInt(dailyCalories) : null,
      dailyCarbs: dailyCarbs ? parseFloat(dailyCarbs) : null,
      dailyProtein: dailyProtein ? parseFloat(dailyProtein) : null,
      dailyFat: dailyFat ? parseFloat(dailyFat) : null,
      allergens: allergens || [],
    },
    create: {
      userId: req.userId,
      dietType: dietType || [],
      dailyCalories: dailyCalories ? parseInt(dailyCalories) : null,
      dailyCarbs: dailyCarbs ? parseFloat(dailyCarbs) : null,
      dailyProtein: dailyProtein ? parseFloat(dailyProtein) : null,
      dailyFat: dailyFat ? parseFloat(dailyFat) : null,
      allergens: allergens || [],
    },
  });

  return success(res, { profile });
}

async function checkCartCompatibility(req, res) {
  const { barcodes } = req.body;
  if (!Array.isArray(barcodes) || barcodes.length === 0) return error(res, 'barcodes[] obbligatorio');

  const profile = await prisma.nutritionProfile.findUnique({ where: { userId: req.userId } });
  if (!profile) return success(res, { warnings: [], message: 'Nessun profilo nutrizionale impostato' });

  const warnings = [];

  for (const barcode of barcodes) {
    const raw = await redis.get(`nutrition:${barcode}`);
    if (!raw) continue;
    const n = JSON.parse(raw);

    // Allergen check
    for (const allergen of profile.allergens) {
      if (n.allergens.includes(allergen)) {
        warnings.push({ barcode, type: 'allergen', message: `Contiene ${allergen}` });
      }
    }

    // Diet checks
    if (profile.dietType.includes('vegan') && !n.isVegan) {
      warnings.push({ barcode, type: 'diet', message: `${n.name || barcode}: non certificato vegano` });
    }
    if (profile.dietType.includes('gluten_free') && !n.isGlutenFree) {
      if (n.allergens.some(a => a.includes('gluten') || a.includes('wheat'))) {
        warnings.push({ barcode, type: 'diet', message: `${n.name || barcode}: contiene glutine` });
      }
    }
    if (profile.dietType.includes('keto') && n.per100g.carbs !== null && n.per100g.carbs > 10) {
      warnings.push({
        barcode, type: 'macro',
        message: `${n.name || barcode}: alto contenuto di carboidrati (${n.per100g.carbs}g/100g)`,
      });
    }
  }

  return success(res, { warnings, profileDietType: profile.dietType });
}

module.exports = {
  getNutritionByBarcode,
  getNutritionProfile,
  upsertNutritionProfile,
  checkCartCompatibility,
};
