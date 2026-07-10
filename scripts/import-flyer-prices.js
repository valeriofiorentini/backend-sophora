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

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});
const MODEL_VISION = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o' : 'gpt-4o';

// Citta da cui raccogliere i volantini: capoluoghi di tutte le regioni +
// comuni della provincia di Roma. Piu citta = piu catene (anche regionali).
const CITIES = [
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

// Coordinate approssimate dei capoluoghi in CITIES — usate per geolocalizzare
// le Promo (il volantino non ha un indirizzo negozio, solo la città in cui
// l'abbiamo trovato su Tiendeo). Necessario per "offerte vicino a te"
// (promoNotify.service filtra Promo con latitude/longitude non nulle: senza
// questa mappa nessuna Promo aveva mai coordinate e le notifiche non partivano mai).
const CITY_COORDS = {
  roma: [41.9028, 12.4964], tivoli: [41.9633, 12.7986], 'guidonia-montecelio': [42.0000, 12.7333],
  pomezia: [41.6702, 12.5013], fiumicino: [41.7714, 12.2350], velletri: [41.6858, 12.7772],
  civitavecchia: [42.0930, 11.7960], latina: [41.4677, 12.9037], frosinone: [41.6401, 13.3492],
  rieti: [42.4008, 12.8617], viterbo: [42.4174, 12.1050],
  milano: [45.4642, 9.1900], monza: [45.5845, 9.2744], bergamo: [45.6983, 9.6773],
  brescia: [45.5416, 10.2118], como: [45.8081, 9.0852], varese: [45.8206, 8.8250],
  torino: [45.0703, 7.6869], cuneo: [44.3841, 7.5426], novara: [45.4469, 8.6220],
  aosta: [45.7372, 7.3149], genova: [44.4056, 8.9463], 'la-spezia': [44.1024, 9.8241],
  bologna: [44.4949, 11.3426], modena: [44.6471, 10.9252], parma: [44.8015, 10.3279],
  'reggio-emilia': [44.6989, 10.6297], ferrara: [44.8381, 11.6198], ravenna: [44.4184, 12.2035],
  rimini: [44.0678, 12.5695], piacenza: [45.0526, 9.6930],
  venezia: [45.4408, 12.3155], verona: [45.4384, 10.9916], padova: [45.4064, 11.8768],
  vicenza: [45.5455, 11.5354], treviso: [45.6669, 12.2431], udine: [46.0711, 13.2346],
  trieste: [45.6495, 13.7768],
  firenze: [43.7696, 11.2558], prato: [43.8777, 11.1023], pisa: [43.7228, 10.4017],
  livorno: [43.5485, 10.3106], lucca: [43.8429, 10.5027], arezzo: [43.4633, 11.8796],
  siena: [43.3188, 11.3308], perugia: [43.1122, 12.3888], terni: [42.5636, 12.6427],
  ancona: [43.6158, 13.5189], pesaro: [43.9101, 12.9133], pescara: [42.4643, 14.2142],
  chieti: [42.3512, 14.1678], 'l-aquila': [42.3498, 13.3995],
  napoli: [40.8518, 14.2681], salerno: [40.6824, 14.7681], caserta: [41.0722, 14.3311],
  benevento: [41.1298, 14.7826], avellino: [40.9147, 14.7936],
  bari: [41.1171, 16.8719], lecce: [40.3519, 18.1720], taranto: [40.4644, 17.2470],
  brindisi: [40.6327, 17.9418], foggia: [41.4621, 15.5444], barletta: [41.3197, 16.2803],
  'reggio-calabria': [38.1113, 15.6619], cosenza: [39.2967, 16.2541], catanzaro: [38.9098, 16.5877],
  potenza: [40.6420, 15.8069], matera: [40.6664, 16.6043],
  palermo: [38.1157, 13.3615], catania: [37.5079, 15.0830], messina: [38.1938, 15.5540],
  siracusa: [37.0755, 15.2866], ragusa: [36.9257, 14.7269], trapani: [38.0176, 12.5365],
  agrigento: [37.3111, 13.5765],
  cagliari: [39.2238, 9.1217], sassari: [40.7259, 8.5590], olbia: [40.9236, 9.4977],
};

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
  for (const city of CITIES) {
    try {
      const flyers = await getFlyers(city);
      for (const f of flyers) {
        const name = (f.retailerName || '').trim();
        const key = name.toLowerCase();
        if (isSupermarketFlyer(name) && f.imageAssets?.big && !byChain.has(key) && !alreadyDone.has(key)) {
          byChain.set(key, { name, img: f.imageAssets.big, endDate: f.end_date, coords: CITY_COORDS[city] || null });
        }
      }
    } catch (_) { /* slug citta inesistente o rete: si prosegue */ }
    await sleep(250); // gentile con Tiendeo
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
