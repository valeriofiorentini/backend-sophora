const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const prisma = require('../config/database');

// ─── Lidl Italy ──────────────────────────────────────────────────────────────
// Lidl exposes a JSON feed for their current offers
async function scrapeLidl() {
  try {
    const { data } = await axios.get(
      'https://www.lidl.it/api/deals/v1/deals?limit=50&offset=0',
      { timeout: 10000, headers: { 'Accept': 'application/json' } },
    );

    const items = data?.data?.items || data?.items || [];
    const results = [];

    for (const item of items) {
      const name = item.name || item.title || item.productName;
      const price = parseFloat(item.price?.value || item.price || 0);
      const originalPrice = parseFloat(item.originalPrice?.value || item.originalPrice || 0);
      const discount = item.discount || (originalPrice > price ? `${Math.round((1 - price / originalPrice) * 100)}%` : null);
      const imageUrl = item.image?.url || item.imageUrl || null;
      const validUntil = item.validUntil ? new Date(item.validUntil) : endOfWeek();

      if (!name || price <= 0) continue;

      results.push({ name, price, originalPrice: originalPrice || null, discount, imageUrl, validUntil });
    }

    return results;
  } catch (err) {
    // Lidl API might change — fall back to HTML scraping
    return scrapeLidlHTML();
  }
}

async function scrapeLidlHTML() {
  try {
    const { data } = await axios.get('https://www.lidl.it/it-it/offerte', { timeout: 10000 });
    const $ = cheerio.load(data);
    const results = [];

    $('.offer-item, .product-grid-box, [data-testid="offerTile"]').each((_, el) => {
      const name = $(el).find('.offer-title, .product-name, h2, h3').first().text().trim();
      const priceText = $(el).find('.price, .offer-price, [class*="price"]').first().text().trim();
      const price = parseFloat(priceText.replace(/[^0-9,\.]/g, '').replace(',', '.'));
      const imageUrl = $(el).find('img').first().attr('src') || null;

      if (name && !isNaN(price) && price > 0) {
        results.push({ name, price, originalPrice: null, discount: null, imageUrl, validUntil: endOfWeek() });
      }
    });

    return results;
  } catch {
    return [];
  }
}

// ─── Eurospin Italy ──────────────────────────────────────────────────────────
async function scrapeEurospin() {
  try {
    const { data } = await axios.get('https://www.eurospin.it/offerte/', { timeout: 10000 });
    const $ = cheerio.load(data);
    const results = [];

    $('.product, .product-item, article[class*="product"]').each((_, el) => {
      const name = $(el).find('h2, h3, .product-name, .name').first().text().trim();
      const priceText = $(el).find('.price, [class*="price"]').first().text().trim();
      const price = parseFloat(priceText.replace(/[^0-9,\.]/g, '').replace(',', '.'));
      const imageUrl = $(el).find('img').first().attr('src') || null;

      if (name && !isNaN(price) && price > 0) {
        results.push({ name, price, originalPrice: null, discount: null, imageUrl, validUntil: endOfWeek() });
      }
    });

    return results;
  } catch {
    return [];
  }
}

// ─── Conad Italy ─────────────────────────────────────────────────────────────
async function scrapeConad() {
  try {
    const { data } = await axios.get('https://www.conad.it/offerte-volantino.html', { timeout: 10000 });
    const $ = cheerio.load(data);
    const results = [];

    $('.product-tile, .offer-card, [class*="product"]').each((_, el) => {
      const name = $(el).find('h3, h2, .product-name, .title').first().text().trim();
      const priceText = $(el).find('.price, [class*="price"]').first().text().trim();
      const price = parseFloat(priceText.replace(/[^0-9,\.]/g, '').replace(',', '.'));
      const discountText = $(el).find('[class*="discount"], [class*="promo"]').first().text().trim();
      const imageUrl = $(el).find('img').first().attr('src') || null;

      if (name && !isNaN(price) && price > 0) {
        results.push({
          name,
          price,
          originalPrice: null,
          discount: discountText || null,
          imageUrl,
          validUntil: endOfWeek(),
        });
      }
    });

    return results;
  } catch {
    return [];
  }
}

// ─── Save to DB + PriceHistory ───────────────────────────────────────────────
async function savePromos(items, storeChain, storeName) {
  let count = 0;
  for (const item of items) {
    try {
      await prisma.promo.create({
        data: {
          storeName,
          storeChain,
          productName: item.name,
          price: item.price,
          originalPrice: item.originalPrice,
          discount: item.discount,
          imageUrl: item.imageUrl,
          source: 'scraper',
          validUntil: item.validUntil,
        },
      });

      // Feed PriceHistory for forecasting
      if (item.price > 0) {
        const isOnSale = !!(item.discount || (item.originalPrice && item.originalPrice > item.price));
        const salePercent = item.originalPrice && item.originalPrice > item.price
          ? Math.round((1 - item.price / item.originalPrice) * 100)
          : null;
        await prisma.priceHistory.create({
          data: {
            productKey: normalizeProductKey(item.name),
            storeChain,
            price: item.price,
            isOnSale,
            salePercent: salePercent ? parseFloat(salePercent) : null,
            source: 'scraper',
          },
        }).catch(() => {}); // ignore duplicates
      }

      count++;
    } catch {
      // Skip duplicates or malformed entries
    }
  }
  return count;
}

function normalizeProductKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
}

// ─── Index scraped promos into Qdrant ─────────────────────────────────────────
async function indexPromosInQdrant(items, storeChain, validUntil) {
  if (!items.length) return;
  try {
    const { embedBatch, productEmbedInput } = require('./embedding.service');
    const qdrant = require('./qdrant.service');
    const { v4: uuidv4 } = require('uuid');

    const validUntilTs = Math.floor(validUntil.getTime() / 1000);
    const texts = items.map(item => productEmbedInput({ name: item.name }));

    // Embed in batches of 50 to avoid token limits
    const BATCH = 50;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batchTexts = texts.slice(i, i + BATCH);
      const batchItems = items.slice(i, i + BATCH);
      const vectors = await embedBatch(batchTexts);
      const points = batchItems.map((item, j) => ({
        id: uuidv4(),
        vector: vectors[j],
        payload: {
          name: item.name,
          price: item.price,
          original_price: item.originalPrice || null,
          store_chain: storeChain,
          valid_until_ts: validUntilTs,
        },
      }));
      await qdrant.upsertBatch('flyer_items', points);
    }
  } catch (err) {
    console.warn('Qdrant indexing skipped (not available):', err.message);
  }
}

async function cleanExpiredPromos() {
  const result = await prisma.promo.deleteMany({
    where: { validUntil: { lt: new Date() } },
  });
  if (result.count > 0) {
    console.log(`🧹 Deleted ${result.count} expired promos`);
  }
}

function endOfWeek() {
  const d = new Date();
  d.setDate(d.getDate() + (7 - d.getDay()));
  d.setHours(23, 59, 59);
  return d;
}

// ─── Run all scrapers ─────────────────────────────────────────────────────────
async function runAllScrapers() {
  console.log('🔍 Starting promo scraper...');

  const [lidlItems, eurospinItems, conadItems] = await Promise.allSettled([
    scrapeLidl(),
    scrapeEurospin(),
    scrapeConad(),
  ]).then(r => r.map(x => (x.status === 'fulfilled' ? x.value : [])));

  const lidlCount = await savePromos(lidlItems, 'Lidl', 'Lidl');
  const eurospinCount = await savePromos(eurospinItems, 'Eurospin', 'Eurospin');
  const conadCount = await savePromos(conadItems, 'Conad', 'Conad');

  console.log(`✅ Scraper done: Lidl=${lidlCount}, Eurospin=${eurospinCount}, Conad=${conadCount}`);

  // Index into Qdrant for semantic search (non-blocking)
  const expiry = endOfWeek();
  Promise.allSettled([
    indexPromosInQdrant(lidlItems, 'Lidl', expiry),
    indexPromosInQdrant(eurospinItems, 'Eurospin', expiry),
    indexPromosInQdrant(conadItems, 'Conad', expiry),
  ]).then(() => console.log('✅ Qdrant indexing done'))
    .catch(err => console.warn('Qdrant indexing error:', err.message));
}

// ─── Cron schedule ────────────────────────────────────────────────────────────
function startScheduler() {
  // Ogni giorno alle 06:00
  cron.schedule('0 6 * * *', async () => {
    await cleanExpiredPromos();
    // Scraper HTML legacy (Lidl/Eurospin/Conad): per lo piu' a vuoto perche' i
    // siti bloccano i bot, ma non fa danni — lo teniamo come fallback.
    await runAllScrapers();
    // Fonte prezzi reale: OCR dei volantini correnti (Tiendeo/ShopFully → GPT-4o).
    // Anti-doppione integrato: salta i volantini gia' letti questa settimana.
    try {
      const { importFlyerPrices } = require('../../scripts/import-flyer-prices');
      await importFlyerPrices();
    } catch (err) {
      console.warn('Flyer OCR import error:', err.message);
    }
  });

  console.log('📅 Scheduler attivo: scraper + OCR volantini, ogni giorno alle 06:00');
}

module.exports = { startScheduler, runAllScrapers };
