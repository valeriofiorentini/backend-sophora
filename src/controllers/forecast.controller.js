/**
 * forecast.controller.js
 * Proxy tra il frontend React Native e il ML Service Python.
 * Aggiunge autenticazione JWT e fallback se ML non disponibile.
 */

const { success, error } = require('../utils/response');
const { forecastPrice, competitorAnalysis } = require('../services/ml.service');
const prisma = require('../config/database');

/**
 * GET /api/forecast/price?productKey=latte&storeChain=Lidl&daysAhead=30
 * Restituisce la previsione Prophet + next_sale_estimate.
 * Se ML Service non disponibile, restituisce il solo storico DB con trend semplice.
 */
async function getPriceForecast(req, res) {
  const { productKey, storeChain, daysAhead = 30 } = req.query;
  if (!productKey) return error(res, 'productKey obbligatorio');

  // Prova ML Service
  const mlResult = await forecastPrice(productKey, storeChain || null, parseInt(daysAhead));
  if (mlResult) return success(res, mlResult);

  // Fallback: storico grezzo da DB
  const history = await prisma.priceHistory.findMany({
    where: {
      productKey,
      ...(storeChain && { storeChain }),
    },
    orderBy: { observedAt: 'asc' },
    take: 60,
  });

  if (!history.length) return error(res, 'Nessun dato disponibile', 404);

  return success(res, {
    product_key: productKey,
    store_chain: storeChain || null,
    observations: history.length,
    forecast: [],
    next_sale_estimate: null,
    trend_summary: 'ML Service non disponibile — visualizzazione storico senza previsione',
    history: history.map(h => ({ date: h.observedAt, price: Number(h.price), isOnSale: h.isOnSale })),
  });
}

/**
 * GET /api/forecast/competitor?productKey=latte&chains=Lidl,Eurospin,Conad
 * Confronto prezzi tra catene.
 */
async function getCompetitorAnalysis(req, res) {
  const { productKey, chains } = req.query;
  if (!productKey) return error(res, 'productKey obbligatorio');

  const result = await competitorAnalysis(productKey, chains || null);
  if (result) return success(res, result);

  // Fallback: calcolo lato DB
  const rows = await prisma.priceHistory.groupBy({
    by: ['storeChain'],
    where: {
      productKey,
      observedAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    },
    _avg: { price: true },
    _min: { price: true },
  });

  if (!rows.length) return error(res, 'Nessun dato', 404);

  const pricesByChain = {};
  rows.forEach(r => { pricesByChain[r.storeChain] = Number(r._avg.price.toFixed(2)); });
  const sorted = Object.entries(pricesByChain).sort((a, b) => a[1] - b[1]);

  return success(res, {
    product_key: productKey,
    prices_by_chain: pricesByChain,
    cheapest_chain: sorted[0][0],
    most_expensive_chain: sorted[sorted.length - 1][0],
    price_spread_pct: Number((((sorted[sorted.length - 1][1] - sorted[0][1]) / sorted[0][1]) * 100).toFixed(1)),
  });
}

module.exports = { getPriceForecast, getCompetitorAnalysis };
