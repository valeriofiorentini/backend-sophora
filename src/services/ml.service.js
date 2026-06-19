/**
 * ml.service.js
 * Client HTTP per il ML Service (FastAPI + Prophet).
 * Se ML_SERVICE_URL non è impostata, tutte le chiamate restituiscono null silenziosamente.
 */

const axios = require('axios');

const ML_BASE = process.env.ML_SERVICE_URL || 'http://localhost:8000';

async function callML(method, path, data) {
  try {
    const res = await axios({ method, url: `${ML_BASE}${path}`, data, timeout: 15000 });
    return res.data;
  } catch (err) {
    const msg = err?.response?.data?.detail || err.message;
    console.warn(`[ML] ${method.toUpperCase()} ${path} → ${msg}`);
    return null;
  }
}

/**
 * Previsione prezzi Prophet per un prodotto.
 * @returns {Promise<{forecast: Array, next_sale_estimate: object|null, trend_summary: string}|null>}
 */
async function forecastPrice(productKey, storeChain = null, daysAhead = 30) {
  return callML('post', '/forecast/price', {
    product_key: productKey,
    store_chain: storeChain,
    days_ahead: daysAhead,
  });
}

/**
 * Route optimizer multi-stop.
 * @param {number} userLat
 * @param {number} userLon
 * @param {Array<{store_id,store_name,store_chain,lat,lon,items_to_buy,estimated_saving}>} stores
 * @param {boolean} returnHome
 * @returns {Promise<{total_km, total_saving, steps, efficiency_score}|null>}
 */
async function optimizeRoute(userLat, userLon, stores, returnHome = true) {
  return callML('post', '/routing/optimize', {
    user_lat: userLat,
    user_lon: userLon,
    stores,
    return_home: returnHome,
  });
}

/**
 * Report B2B per una catena.
 */
async function getStoreReport(storeChain, days = 30) {
  return callML('get', `/b2b/store-report/${encodeURIComponent(storeChain)}?days=${days}`);
}

/**
 * Competitor analysis: confronto prezzi tra catene.
 */
async function competitorAnalysis(productKey, chains = null) {
  const q = chains ? `&chains=${encodeURIComponent(chains)}` : '';
  return callML('get', `/b2b/competitor-analysis?product_key=${encodeURIComponent(productKey)}${q}`);
}

/**
 * Trigger batch forecast (chiamato dal cron notturno).
 */
async function triggerBatchForecast() {
  return callML('post', '/forecast/batch', {});
}

module.exports = { forecastPrice, optimizeRoute, getStoreReport, competitorAnalysis, triggerBatchForecast };
