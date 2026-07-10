/**
 * import-flyer-prices.js
 *
 * Bootstrap di PREZZI REALI dai volantini, senza scraping HTML né browser headless.
 *
 * Come funziona:
 *  1. Legge da Tiendeo (ShopFully) la lista dei volantini correnti per molte citta
 *     (capoluoghi + provincia di Roma). I dati sono nel JSON __NEXT_DATA__ della
 *     pagina → niente blocco bot.
 *  2. Filtra solo i SUPERMERCATI, 1 volantino per catena, e prende l'immagine di
 *     copertina (CDN pubblico shopfully.cloud).
 *  3. Passa ogni immagine a GPT-4o Vision (stesso prompt del flyer.controller) che
 *     estrae prodotti + prezzi.
 *  4. Salva in Promo + PriceHistory (source 'flyer_ocr'), come fa l'app.
 *
 * Anti-doppione: salta le catene il cui volantino di questa settimana e' gia' stato
 * importato (cosi' il cron giornaliero non rispende OCR a vuoto).
 *
 * Uso manuale:   node scripts/import-flyer-prices.js
 * Uso da cron:   require('./scripts/import-flyer-prices').importFlyerPrices()
 */
require('dotenv').config();
const axios = require('axios');
const OpenAI = require('openai');
const prisma = require('../src/config/database');
const { getCityCoords, getAllCitySlugs } = require('../src/utils/comuniGeo');

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});
const MODEL_VISION = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o' : 'gpt-4o';

// Città sempre scansionate ogni giorno: capoluoghi di regione/provincia
// principali + provincia di Roma — coprono la stragrande maggioranza delle
// catene nazionali e regionali, quindi vale la pena rileggerle ogni volta.
const PRIORITY_CITIES = [
  // Lazio + provincia di Roma
  'roma', 'tivoli', 'guidonia-montecelio', 'pomezia', 'fiumicino', 'velletri',
  'civitavecchia', 'latina', 'frosinone', 'rieti', 'viterbo',
  // Nord
  'milano', 'monza', 'bergamo', 'brescia', 'como', 'varese',
  'torino', 'cuneo', 'novara', 'aosta', 'genova', 'la-spezia',
  'bologna', 'modena', 'parma', 'reggio-emilia', 'ferrara', 'ravenna', 'rimini', 'piacenza',
  'venezia', 'verona', 'padova', 'vicenza', 'treviso', 'udine', 'trieste',
  // Centro
  'firenze', 'prato', 'pisa', 'livorno', 'lucca', 'arezzo', 'siena',
  'perugia', 'terni', 'ancona', 'pesaro', 'pescara', 'chieti', 'l-aquila',
  // Sud + isole
  'napoli', 'salerno', 'caserta', 'benevento', 'avellino',
  'bari', 'lecce', 'taranto', 'brindisi', 'foggia', 'barletta',
  'reggio-calabria', 'cosenza', 'catanzaro', 'potenza', 'matera',
  'palermo', 'catania', 'messina', 'siracusa', 'ragusa', 'trapani', 'agrigento',
  'cagliari', 'sassari', 'olbia',
];

// Tutti gli altri ~7900 comuni italiani (dataset ISTAT) vengono scansionati
// TUTTI ogni notte (BATCH_DAYS=1), nella finestra 23:00-06:00 (7h, vedi
// scraper.service.js). Con la pausa di SLEEP_MS tra una richiesta e l'altra
// (piu' gentile di prima proprio perche' ora scansioniamo tutto in un colpo)
// il giro sta comodamente nella finestra: 8000 città * 2s ≈ 4.4h.
// Se FLYER_CITY_BATCH_DAYS > 1 si torna alla rotazione su piu' notti.
const BATCH_DAYS = parseInt(process.env.FLYER_CITY_BATCH_DAYS, 10) || 1;

function getTodaysCityBatch() {
  const priority = new Set(PRIORITY_CITIES);
  const rest = getAllCitySlugs().filter(s => !priority.has(s));
  const batchSize = Math.ceil(rest.length / BATCH_DAYS);
  // Giorni trascorsi dall'epoch, ciclico su BATCH_DAYS: ogni notte una fetta
  // diversa e prevedibile, senza dover salvare uno stato su disco/DB.
  const dayIndex = Math.floor(Date.now() / 86_400_000) % BATCH_DAYS;
  const start = dayIndex * batchSize;
  const batch = rest.slice(start, start + batchSize);
  console.log(`[flyer] batch giorno ${dayIndex + 1}/${BATCH_DAYS}: ${batch.length} comuni (+ ${PRIORITY_CITIES.length} prioritari)`);
  return [...PRIORITY_CITIES, ...batch];
}

// Le coordinate delle città in CITIES vengono da comuniGeo.js (dataset ISTAT
// reale, ~7980 comuni) invece di una mappa scritta a mano — servono per
// geolocalizzare le Promo (il volantino non ha un indirizzo negozio, solo la
// città in cui l'abbiamo trovato su Tiendeo). Necessario per "offerte vicino
// a te" (promoNotify.service filtra Promo con latitude/longitude non nulle:
// senza coordinate nessuna Promo le aveva mai e le notifiche non partivano mai).

// Catene supermercato da tenere (esclude elettronica, fai-da-te, brand)
const SUPERMARKETS = [
  'conad', 'conad superstore', 'conad city', 'coop', 'esselunga', 'carrefour',
  'carrefour market', 'carrefour express', 'lidl', 'eurospin', 'pam', 'panorama',
  'todis', 'md', 'despar', 'eurospar', 'interspar', 'sigma', 'crai', 'penny',
  'famila', 'tigre', 'tigros', 'iper', 'bennet', 'unes', 'simply', 'deco', 'decò',
  'pewex', 'dok', 'sidis', 'aldi', 'naturasi', 'iperal', 'ekom', 'prix', 'in\'s',
  'a&o', 'tuodi', 'tuodì', 'il gigante', 'pim', 'sole 365', 'dpiu', 'dpiù',
  'elite', 'gros', 'u2', 'pellicano', 'emme piu', 'emme più', 'dem', 'iper dem',
  'doc', 'cts', 'castoro',
  // Varianti composte reali viste su Tiendeo (Coop si presenta quasi sempre
  // così, mai come "coop" da solo — il match esatto le perdeva tutte)
  'ipercoop', 'extracoop', 'superstore coop', 'coop centro italia', 'iper coop',
  'nova coop', 'coop alleanza', 'unicoop', 'coop lombardia', 'coop liguria',
  // Insegne regionali/di consorzio (Selex, VéGé, Megamark, Multicedi, Agorà,
  // Gruppo Gros, Aspiag/Despar, Dimar...) — nomi con cui compaiono davvero
  // sui volantini, non le holding invisibili al consumatore.
  'alì', 'ali super', 'alìper', 'aliper', 'iperfamila', 'iper famila',
  'emisfero', 'oasi', 'tigre', 'superconti', 'rossetto', 'tosano',
  'mercatò', 'cadoro', 'italmark', 'dodecà', 'sebòn', 'rossotono',
  'ipertriscount', 'iper triscount', 'sole365', 'sole 365', 'megamark',
  'gigante verde', 'multicash', 'crai extra', 'crai store',
];

// Insegne che contengono il nome di una catena come sotto-brand ma NON sono
// supermercati (farmacia, petshop, elettronica...) — vanno escluse anche se
// il nome contiene una parola della whitelist sopra (es. "Parafarmacia Conad").
const NON_SUPERMARKET_KEYWORDS = [
  'parafarmacia', 'farmacia', 'pet store', 'petstore', 'giardinaggio',
  'elettronica', 'bricolage', 'brico', 'expert', 'euronics', 'mediaworld',
  'cartoleria', 'ottica', 'profumeria',
];

const FLYER_PROMPT = `Analizza questo volantino promozionale italiano. Restituisci SOLO un JSON valido:
{"storeChain":"catena (es: Lidl, Conad)","items":[{"name":"nome prodotto in italiano","category":"categoria","price":0.00,"originalPrice":0.00,"discountPercent":null,"brand":"marca o null"}]}
Estrai TUTTI i prodotti visibili con i loro prezzi. Se non leggi un prezzo usa null. Non inventare dati.`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Pausa tra una richiesta città e l'altra a Tiendeo. Con BATCH_DAYS=1 (tutti
// gli 8000 comuni ogni notte) 2s è un buon compromesso: ~4.4h di scansione,
// dentro la finestra 23:00-06:00, restando comunque "gentili" col sito.
const SLEEP_MS = parseInt(process.env.FLYER_SLEEP_MS, 10) || 2000;
const normKey = (n) => String(n).toLowerCase().replace(/[^a-z0-9àèéìòù\s]/g, '').replace(/\s+/g, '_').slice(0, 80);

// Un'insegna di Tiendeo è un supermercato se il nome CONTIENE una parola della
// whitelist (non uguaglianza esatta: "ipercoop" non è mai === "coop"), a meno
// che non sia un sotto-brand non alimentare (farmacia, petshop...).
function isSupermarketFlyer(retailerName) {
  const key = String(retailerName || '').trim().toLowerCase();
  if (!key) return false;
  const isSupermarket = SUPERMARKETS.some(s => key.includes(s));
  const isExcluded = NON_SUPERMARKET_KEYWORDS.some(k => key.includes(k));
  return isSupermarket && !isExcluded;
}

async function getFlyers(city) {
  const { data: html } = await axios.get(`https://www.tiendeo.it/${city}`, { timeout: 25000, headers: { 'User-Agent': UA } });
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) return [];
  return JSON.parse(m[1])?.props?.pageProps?.apiResources?.flyersByCategory?.flyers || [];
}

async function ocrFlyer(imageUrl, retailer, endDate, coords) {
  const r = await openai.chat.completions.create({
    model: MODEL_VISION,
    messages: [{ role: 'user', content: [{ type: 'text', text: FLYER_PROMPT }, { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }] }],
    response_format: { type: 'json_object' }, max_tokens: 3000,
  });
  let parsed;
  try {
    parsed = JSON.parse(r.choices[0].message.content);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return 0; // il modello non ha estratto dati utili dal volantino (es. "null", JSON troncato)
  const storeChain = parsed.storeChain || retailer;
  const items = Array.isArray(parsed.items) ? parsed.items.filter(i => i.name && i.price) : [];
  const validUntil = endDate ? new Date(endDate) : new Date(Date.now() + 7 * 864e5);
  let saved = 0;
  for (const it of items) {
    const price = parseFloat(it.price);
    if (!(price > 0)) continue;
    const isOnSale = !!(it.discountPercent || (it.originalPrice && parseFloat(it.originalPrice) > price));
    await prisma.promo.create({ data: { storeName: retailer, storeChain, productName: it.name, price, originalPrice: it.originalPrice ? parseFloat(it.originalPrice) : null, discount: it.discountPercent ? `${it.discountPercent}%` : null, source: 'flyer_ocr_batch', validUntil, latitude: coords?.[0] ?? null, longitude: coords?.[1] ?? null } }).catch(() => {});
    await prisma.priceHistory.create({ data: { productKey: normKey(it.name), storeChain, price, isOnSale, salePercent: it.discountPercent ? parseFloat(it.discountPercent) : null, source: 'flyer_ocr' } }).catch(() => {});
    saved++;
  }
  return saved;
}

async function importFlyerPrices() {
  // Catene gia' importate per la settimana corrente (volantino ancora valido)
  const existing = await prisma.promo.findMany({
    where: { source: 'flyer_ocr_batch', validUntil: { gt: new Date() } },
    select: { storeChain: true },
    distinct: ['storeChain'],
  });
  const alreadyDone = new Set(existing.map(e => (e.storeChain || '').toLowerCase()));

  // 1. Raccoglie volantini supermercato da piu citta, 1 per catena
  const byChain = new Map();
  for (const city of getTodaysCityBatch()) {
    try {
      const flyers = await getFlyers(city);
      for (const f of flyers) {
        const name = (f.retailerName || '').trim();
        const key = name.toLowerCase();
        if (isSupermarketFlyer(name) && f.imageAssets?.big && !byChain.has(key) && !alreadyDone.has(key)) {
          byChain.set(key, { name, img: f.imageAssets.big, endDate: f.end_date, coords: getCityCoords(city) });
        }
      }
    } catch (_) { /* slug citta inesistente o rete: si prosegue */ }
    await sleep(SLEEP_MS);
  }

  const targets = [...byChain.values()];
  console.log(`[flyer] catene nuove da leggere: ${targets.length}` + (targets.length ? ' → ' + targets.map(t => t.name).join(', ') : ' (tutte gia aggiornate)'));

  // 2. OCR di ciascuna
  let total = 0;
  for (const t of targets) {
    try {
      const n = await ocrFlyer(t.img, t.name, t.endDate, t.coords);
      console.log(`[flyer] ${t.name}: ${n} prezzi`);
      total += n;
    } catch (e) {
      console.log(`[flyer] ${t.name}: errore ${e.message}`);
    }
  }
  console.log(`[flyer] Fatto. Prezzi reali inseriti: ${total} | Totale PriceHistory: ${await prisma.priceHistory.count()}`);
  return total;
}

module.exports = { importFlyerPrices, isSupermarketFlyer };

// Esecuzione diretta da CLI
if (require.main === module) {
  importFlyerPrices()
    .catch(e => { console.error('Errore:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
