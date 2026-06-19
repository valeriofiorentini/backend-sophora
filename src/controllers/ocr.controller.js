const { createWorker } = require('tesseract.js');
const prisma = require('../config/database');
const { success, error } = require('../utils/response');

// Patterns to extract Italian price tags from OCR text
const PRICE_RE = /€?\s*(\d+[,.]\d{1,2})/g;
const PRODUCT_LINE_RE = /^([A-Za-zÀ-ú\s\-\/]{4,60})\s+€?\s*(\d+[,.]\d{1,2})/m;
const DISCOUNT_RE = /-?\s*(\d{1,2})\s*%/;
const DATE_RE = /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/g;

function parseLines(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const products = [];

  for (const line of lines) {
    const priceMatch = line.match(/€?\s*(\d+[,.]\d{1,2})/);
    if (!priceMatch) continue;

    const price = parseFloat(priceMatch[1].replace(',', '.'));
    // Everything before the price is the product name
    const name = line.slice(0, line.indexOf(priceMatch[0])).trim();
    if (!name || name.length < 3) continue;

    const discountMatch = line.match(DISCOUNT_RE);
    const discount = discountMatch ? `${discountMatch[1]}%` : null;

    // Try to find original price (often shown as strikethrough, appears as second price)
    const allPrices = [...line.matchAll(PRICE_RE)].map(m => parseFloat(m[1].replace(',', '.')));
    const originalPrice = allPrices.length > 1 ? Math.max(...allPrices) : null;

    products.push({ name, price, originalPrice, discount });
  }

  return products;
}

function extractExpiryDate(text) {
  const matches = [...text.matchAll(DATE_RE)];
  if (!matches.length) {
    // Default: valid for 7 days
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d;
  }

  // Take the latest date found in the text (usually the "fino al" date)
  let latest = new Date();
  for (const m of matches) {
    const day = parseInt(m[1]);
    const month = parseInt(m[2]) - 1;
    const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : new Date().getFullYear();
    const d = new Date(year, month, day);
    if (d > latest) latest = d;
  }
  return latest;
}

async function processFlyer(req, res) {
  if (!req.file) return error(res, 'Immagine obbligatoria');

  const { storeName = 'Sconosciuto', storeChain, latitude, longitude } = req.body;

  let text = '';
  try {
    const worker = await createWorker('ita+eng');
    const { data } = await worker.recognize(req.file.buffer);
    text = data.text;
    await worker.terminate();
  } catch (err) {
    console.error('OCR error:', err);
    return error(res, 'Errore durante la lettura del volantino', 500);
  }

  const products = parseLines(text);
  const validUntil = extractExpiryDate(text);

  // Save all extracted promos to DB
  const saved = [];
  for (const p of products) {
    const promo = await prisma.promo.create({
      data: {
        storeName,
        storeChain: storeChain || null,
        productName: p.name,
        price: p.price,
        originalPrice: p.originalPrice,
        discount: p.discount,
        source: 'ocr',
        validUntil,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
      },
    });
    saved.push(promo);
  }

  return success(res, {
    rawText: text,
    extractedProducts: products,
    savedPromos: saved,
    validUntil,
    message: `${saved.length} prodotti estratti dal volantino`,
  }, 201);
}

module.exports = { processFlyer };
