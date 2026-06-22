/**
 * import-flyer-prices.js
 *
 * Bootstrap di PREZZI REALI dai volantini, senza scraping HTML né browser headless.
 *
 * Come funziona:
 *  1. Legge da Tiendeo (ShopFully) la lista dei volantini correnti per alcune citta.
 *     I dati sono nel JSON __NEXT_DATA__ della pagina → niente blocco bot.
 *  2. Filtra solo i SUPERMERCATI e prende l'immagine di copertina del volantino
 *     (CDN pubblico shopfully.cloud).
 *  3. Passa ogni immagine a GPT-4o Vision (stesso prompt del flyer.controller)
 *     che estrae prodotti + prezzi.
 *  4. Salva in Promo + PriceHistory (source 'flyer_ocr'), come fa l'app.
 *
 * Uso (sul server, dentro la cartella backend):
 *   node scripts/import-flyer-prices.js
 *
 * NB: usa OPENROUTER_API_KEY/OPENAI_API_KEY dal .env. Ogni immagine costa
 *     pochi centesimi di GPT-4o Vision.
 */
require('dotenv').config();
const axios = require('axios');
const OpenAI = require('openai');
const prisma = require('../src/config/database');

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});
const MODEL_VISION = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o' : 'gpt-4o';

// Citta da cui raccogliere i volantini (piu citta = piu catene diverse)
const CITIES = ['roma', 'milano', 'napoli', 'torino', 'bologna', 'firenze'];

// Catene supermercato da tenere (esclude elettronica, fai-da-te, brand)
const SUPERMARKETS = [
  'conad', 'conad superstore', 'conad city', 'coop', 'esselunga', 'carrefour',
  'carrefour market', 'carrefour express', 'lidl', 'eurospin', 'pam', 'panorama',
  'todis', 'md', 'despar', 'eurospar', 'interspar', 'sigma', 'crai', 'penny',
  'famila', 'tigre', 'tigros', 'iper', 'bennet', 'unes', 'simply', 'deco',
  'pewex', 'dok', 'sidis', 'aldi', 'naturasi', 'iperal', 'ekom', 'prix', 'in\'s',
];

const FLYER_PROMPT = `Analizza questo volantino promozionale italiano. Restituisci SOLO un JSON valido:
{
  "storeChain": "catena del supermercato (es: Lidl, Esselunga, Conad)",
  "items": [
    { "name": "nome prodotto normalizzato in italiano", "category": "categoria", "price": 0.00, "originalPrice": 0.00, "discountPercent": null, "brand": "marca o null" }
  ]
}
Estrai TUTTI i prodotti visibili con i loro prezzi. Se non riesci a leggere un prezzo usa null. Non inventare dati.`;

function normalizeProductKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getFlyersForCity(city) {
  const { data: html } = await axios.get(`https://www.tiendeo.it/${city}`, {
    timeout: 25000, headers: { 'User-Agent': UA },
  });
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return [];
  const json = JSON.parse(m[1]);
  const flyers = json?.props?.pageProps?.apiResources?.flyersByCategory?.flyers || [];
  return flyers;
}

async function ocrFlyer(imageUrl, retailerName, endDate) {
  const response = await openai.chat.completions.create({
    model: MODEL_VISION,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: FLYER_PROMPT },
        { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
      ],
    }],
    response_format: { type: 'json_object' },
    max_tokens: 3000,
  });
  const parsed = JSON.parse(response.choices[0].message.content);
  const storeChain = parsed.storeChain || retailerName;
  const items = Array.isArray(parsed.items) ? parsed.items.filter(i => i.name && i.price) : [];
  const validUntil = endDate ? new Date(endDate) : new Date(Date.now() + 7 * 864e5);

  let saved = 0;
  for (const item of items) {
    const price = parseFloat(item.price);
    if (!(price > 0)) continue;
    const isOnSale = !!(item.discountPercent || (item.originalPrice && parseFloat(item.originalPrice) > price));
    await prisma.promo.create({
      data: {
        storeName: retailerName, storeChain,
        productName: item.name, price,
        originalPrice: item.originalPrice ? parseFloat(item.originalPrice) : null,
        discount: item.discountPercent ? `${item.discountPercent}%` : null,
        source: 'flyer_ocr_batch', validUntil,
      },
    }).catch(() => {});
    await prisma.priceHistory.create({
      data: {
        productKey: normalizeProductKey(item.name), storeChain, price, isOnSale,
        salePercent: item.discountPercent ? parseFloat(item.discountPercent) : null,
        source: 'flyer_ocr',
      },
    }).catch(() => {});
    saved++;
  }
  return saved;
}

async function main() {
  // 1. Raccoglie volantini supermercato da piu citta, 1 per catena
  const byChain = new Map();
  for (const city of CITIES) {
    try {
      const flyers = await getFlyersForCity(city);
      for (const f of flyers) {
        const name = (f.retailerName || '').trim();
        const isSuper = SUPERMARKETS.includes(name.toLowerCase());
        const img = f.imageAssets?.big;
        if (isSuper && img && !byChain.has(name.toLowerCase())) {
          byChain.set(name.toLowerCase(), { name, img, endDate: f.end_date, id: f.id });
        }
      }
      console.log(`${city}: ${flyers.length} volantini`);
    } catch (e) {
      console.log(`${city}: errore ${e.message}`);
    }
  }

  const targets = [...byChain.values()];
  console.log(`\nSupermercati trovati: ${targets.length} → ${targets.map(t => t.name).join(', ')}\n`);

  // 2. OCR di ciascuno
  let totalPrices = 0;
  for (const t of targets) {
    process.stdout.write(`OCR ${t.name}... `);
    try {
      const n = await ocrFlyer(t.img, t.name, t.endDate);
      console.log(`${n} prezzi`);
      totalPrices += n;
    } catch (e) {
      console.log(`errore: ${e.message}`);
    }
  }

  console.log(`\nFatto. Prezzi reali inseriti in PriceHistory: ${totalPrices}`);
  console.log(`Osservazioni totali nel DB: ${await prisma.priceHistory.count()}`);
}

main().catch(e => { console.error('Errore:', e); process.exit(1); }).finally(() => prisma.$disconnect());
