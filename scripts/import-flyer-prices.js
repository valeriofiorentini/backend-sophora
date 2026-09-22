/**
 * import-flyer-prices.js
 *
 * Bootstrap di PREZZI REALI dai volantini, senza scraping HTML né browser headless.
 *
 * Come funziona:
 *  1. Legge da Tiendeo (ShopFully) la lista dei volantini correnti per molte citta
 *     (capoluoghi + provincia di Roma). I dati sono nel JSON __NEXT_DATA__ della
 *     pagina → niente blocco bot.
 *  2. Filtra solo i SUPERMERCATI, raggruppa per id volantino (lo stesso volantino
 *     compare in tutte le citta' della sua zona) e prende l'immagine di copertina
 *     (CDN pubblico shopfully.cloud).
 *  3. Passa ogni immagine a GPT-4o Vision (stesso prompt del flyer.controller) che
 *     estrae prodotti + prezzi.
 *  4. Salva in Promo + PriceHistory (source 'flyer_ocr'), come fa l'app.
 *
 * Anti-doppione: salta i volantini gia' importati (stessa insegna, scadenza e
 * zona), cosi' il cron giornaliero non rispende OCR a vuoto.
 *
 * Uso manuale:   node scripts/import-flyer-prices.js
 * Uso da cron:   require('./scripts/import-flyer-prices').importFlyerPrices()
 */
require('dotenv').config();
const axios = require('axios');
const OpenAI = require('openai');
const prisma = require('../src/config/database');
const { getCityCoords, getAllCitySlugs } = require('../src/utils/comuniGeo');
const { haversineKm } = require('../src/services/geo.service');
const { canonicalizeChain } = require('../src/utils/storeChain');

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

// Tiendeo e' passato al Next.js App Router: i dati non sono piu' in
// __NEXT_DATA__ ma nei chunk `self.__next_f.push([1,"..."])` (RSC flight data).
function decodeRscFlight(html) {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let out = '', m;
  while ((m = re.exec(html))) {
    try { out += JSON.parse('"' + m[1] + '"'); } catch { /* chunk non testuale */ }
  }
  return out;
}

// Estrae l'array JSON che segue `"key":[` bilanciando le parentesi.
function extractJsonArray(text, key) {
  const i = text.indexOf(`"${key}":[`);
  if (i < 0) return null;
  const start = text.indexOf('[', i);
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < text.length; k++) {
    const c = text[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return text.slice(start, k + 1);
  }
  return null;
}

let warnedUnknownFormat = false;

async function getFlyers(city) {
  const { data: html } = await axios.get(`https://www.tiendeo.it/${city}`, { timeout: 25000, headers: { 'User-Agent': UA } });

  // 1. Formato storico (pages router)
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (m) {
    const legacy = JSON.parse(m[1])?.props?.pageProps?.apiResources?.flyersByCategory?.flyers;
    if (Array.isArray(legacy)) return legacy;
  }

  // 2. Formato attuale (app router / RSC)
  const raw = extractJsonArray(decodeRscFlight(html), 'flyers');
  if (raw) return JSON.parse(raw);

  // Senza questo avviso un cambio di formato azzera le offerte in silenzio
  // (il chiamante ingoia gli errori): e' cosi' che l'app e' rimasta senza offerte.
  if (!warnedUnknownFormat) {
    warnedUnknownFormat = true;
    console.warn(`[flyer] ATTENZIONE: nessun volantino estraibile da tiendeo.it/${city} — formato pagina cambiato?`);
  }
  return [];
}

// Un volantino Tiendeo ha un id stabile ed e' valido per una zona: lo stesso id
// compare in tutte le citta' che lo mostrano. Si legge UNA volta con l'OCR e le
// offerte si salvano su pochi "punti di ancoraggio" geografici, cosi' chi e' vicino
// a uno di essi (l'app filtra a 50 km) le vede. Prima si teneva 1 volantino per
// catena con le coordinate della prima citta' (quasi sempre Roma): fuori dal Lazio
// le offerte non comparivano.
const CLUSTER_KM = 60;
const MAX_ANCHORS = parseInt(process.env.FLYER_MAX_ANCHORS, 10) || 40;
const MAX_OCR_PER_RUN = parseInt(process.env.FLYER_MAX_OCR_PER_RUN, 10) || 400;

// Una citta' diventa un nuovo punto solo se dista >= CLUSTER_KM da quelli gia' scelti.
// Volantino presente ovunque (oltre MAX_ANCHORS punti) = nazionale: [null] salva le
// offerte senza coordinate, che il backend mostra a tutti.
function pickAnchors(points) {
  const anchors = [];
  for (const p of points) {
    if (anchors.some(a => haversineKm(a[0], a[1], p[0], p[1]) < CLUSTER_KM)) continue;
    anchors.push(p);
    if (anchors.length > MAX_ANCHORS) return [null];
  }
  return anchors.length ? anchors : [null];
}

const doneKey = (storeName, validUntil, anchor) =>
  `${String(storeName || '').toLowerCase()}|${new Date(validUntil).getTime()}|` +
  (anchor ? `${anchor[0].toFixed(4)},${anchor[1].toFixed(4)}` : 'null');

// flyers: Map<id, {name, img, endDate, points}>; done: Set di doneKey gia' importati.
// I piu' diffusi per primi, cosi' l'eventuale limite per notte taglia i piu' locali.
function planTargets(flyers, done) {
  const targets = [];
  for (const f of flyers.values()) {
    const anchors = pickAnchors(f.points);
    if (done.has(doneKey(f.name, f.endDate, anchors[0]))) continue;
    targets.push({ ...f, anchors });
  }
  return targets.sort((a, b) => b.points.length - a.points.length);
}

async function ocrFlyer(imageUrl, retailer, endDate, anchors) {
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
  // Tiendeo/GPT restituiscono l'insegna del singolo volantino ("Conad City",
  // "Spazio Conad", "Margherita Conad"...): senza normalizzare, ogni variante
  // finisce come catena distinta nell'app invece che tutte sotto "Conad".
  const storeChain = canonicalizeChain(parsed.storeChain || retailer);
  const items = Array.isArray(parsed.items) ? parsed.items.filter(i => i.name && i.price) : [];
  const validUntil = new Date(endDate);
  let saved = 0;
  for (const it of items) {
    const price = parseFloat(it.price);
    if (!(price > 0)) continue;
    const isOnSale = !!(it.discountPercent || (it.originalPrice && parseFloat(it.originalPrice) > price));
    const promo = { storeName: retailer, storeChain, productName: it.name, price, originalPrice: it.originalPrice ? parseFloat(it.originalPrice) : null, discount: it.discountPercent ? `${it.discountPercent}%` : null, source: 'flyer_ocr_batch', validUntil };
    // Un'offerta per ogni punto di ancoraggio (il primo per primo: e' la chiave anti-doppione)
    for (const a of anchors) {
      await prisma.promo.create({ data: { ...promo, latitude: a?.[0] ?? null, longitude: a?.[1] ?? null } }).catch(() => {});
    }
    // Lo storico prezzi invece una volta sola, non per zona
    await prisma.priceHistory.create({ data: { productKey: normKey(it.name), storeChain, price, isOnSale, salePercent: it.discountPercent ? parseFloat(it.discountPercent) : null, source: 'flyer_ocr' } }).catch(() => {});
    saved++;
  }
  return saved;
}

async function importFlyerPrices() {
  // Volantini gia' importati (ancora validi): insegna + scadenza + punto di ancoraggio
  const existing = await prisma.promo.findMany({
    where: { source: 'flyer_ocr_batch', validUntil: { gt: new Date() } },
    select: { storeName: true, validUntil: true, latitude: true, longitude: true },
    distinct: ['storeName', 'validUntil', 'latitude', 'longitude'],
  });
  const done = new Set(existing.map(e =>
    doneKey(e.storeName, e.validUntil, e.latitude != null && e.longitude != null ? [e.latitude, e.longitude] : null)));

  // 1. Raccoglie i volantini supermercato di tutte le citta', uno per id
  // (senza end_date la validita' e' ignota e non si puo' evitare il doppione: scartato)
  const flyers = new Map();
  for (const city of getTodaysCityBatch()) {
    try {
      const coords = getCityCoords(city);
      for (const f of await getFlyers(city)) {
        const name = (f.retailerName || '').trim();
        if (f.id == null || !f.end_date || !f.imageAssets?.big || !isSupermarketFlyer(name)) continue;
        let entry = flyers.get(f.id);
        if (!entry) flyers.set(f.id, entry = { id: f.id, name, img: f.imageAssets.big, endDate: f.end_date, points: [] });
        if (coords) entry.points.push(coords);
      }
    } catch (_) { /* slug citta inesistente o rete: si prosegue */ }
    await sleep(SLEEP_MS);
  }

  let targets = planTargets(flyers, done);
  const postponed = Math.max(0, targets.length - MAX_OCR_PER_RUN);
  targets = targets.slice(0, MAX_OCR_PER_RUN);
  console.log(`[flyer] volantini distinti: ${flyers.size} | nuovi da leggere: ${targets.length}` +
    (postponed ? ` | rimandati a domani: ${postponed} (limite FLYER_MAX_OCR_PER_RUN=${MAX_OCR_PER_RUN})` : '') +
    (targets.length ? ' → ' + targets.map(t => `${t.name}#${t.id}`).join(', ') : ' (tutti gia aggiornati)'));

  // 2. OCR di ciascuno
  let total = 0;
  for (const t of targets) {
    const zone = t.anchors[0] ? `${t.anchors.length} zone` : 'tutta Italia';
    try {
      const n = await ocrFlyer(t.img, t.name, t.endDate, t.anchors);
      console.log(`[flyer] ${t.name}#${t.id}: ${n} prezzi (${zone})`);
      total += n;
    } catch (e) {
      console.log(`[flyer] ${t.name}#${t.id}: errore ${e.message}`);
    }
  }
  console.log(`[flyer] Fatto. Prezzi reali inseriti: ${total} | Totale PriceHistory: ${await prisma.priceHistory.count()}`);
  return total;
}

module.exports = { importFlyerPrices, isSupermarketFlyer, pickAnchors, planTargets, doneKey };

// Esecuzione diretta da CLI
if (require.main === module) {
  importFlyerPrices()
    .catch(e => { console.error('Errore:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
