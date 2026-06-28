/**
 * Importa i supermercati REALI da OpenStreetMap (Overpass API) nel DB.
 *
 * - Nessun prezzo inventato: crea solo i negozi (nome, catena, indirizzo, coordinate reali).
 * - I prezzi reali arrivano da scontrini (PriceHistory source=receipt_ocr) e scraper volantini.
 * - Idempotente: id stabile `osm-<type>-<id>`, ripulisce i seed precedenti prima di reimportare.
 *
 * Uso (sul server, dentro la cartella backend):
 *   node scripts/import-osm-stores.js
 */
const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const prisma = new PrismaClient();

// Più mirror Overpass: se uno è sotto rate-limit (429), proviamo il successivo.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
const UA = 'ShoporaSeed/1.0 (valeriofiorentini2002@gmail.com)';

const PAUSE_BETWEEN_BANDS_MS = 20000; // 20s tra una fascia e l'altra (gentile con Overpass)
const MAX_RETRIES_PER_BAND   = 4;     // tentativi per fascia prima di arrendersi

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 4 fasce orizzontali che coprono tutta Italia (isole incluse) [S, W, N, E]
const BANDS = [
  [36.5, 6.5, 40.0, 18.6], // Sud + Sicilia
  [40.0, 6.5, 43.0, 18.6], // Centro-Sud + Sardegna
  [43.0, 6.5, 45.0, 18.6], // Centro-Nord
  [45.0, 6.5, 47.2, 18.6], // Nord
];

// Catene note: se manca il tag brand, prova a dedurla dal nome
const KNOWN_CHAINS = [
  'Conad', 'Coop', 'Esselunga', 'Carrefour', 'Lidl', 'Eurospin', 'Pam', 'Panorama',
  'Todis', 'MD', 'Despar', 'Eurospar', 'Interspar', 'Sigma', 'Crai', 'Penny',
  'Tigre', 'Tigros', 'Elite', 'Famila', 'Simply', 'Deco', 'Decò', 'In\'s', 'Aldi',
  'Bennet', 'Iper', 'Pellicano', 'Emme Più', 'A&O', 'Dok', 'Sidis', 'Conad City',
  'Pewex', 'Gros', 'Iperal', 'Unes', 'U2', 'Ekom', 'Prix', 'Naturasi', 'NaturaSi',
  // Regionali / insegne aggiuntive
  'Ipertriscount', 'Iper Triscount', 'Triscount', 'Sole 365', 'Sole365', 'Dpiù', 'Dpiu',
  'Famila Superstore', 'Conad Superstore', 'Conad City', 'Spazio Conad', 'Margherita',
  'Tuodì', 'Tuodi', 'Risparmio Casa', 'Acqua & Sapone', 'Galassia', 'Maxisidis',
  'Carrefour Express', 'Carrefour Market', 'Lidl Italia', 'Eurospin Italia', 'Penny Market',
  'Gigante', 'Il Gigante', 'Basko', 'Doro', 'Coop Alleanza', 'Ipercoop', 'Auchan',
  'Bennet', 'Famila Market', 'Crai Express', 'Sebon', 'Migross', 'Cadoro', 'Alì', 'Ali',
];

// Normalizza per il confronto: minuscolo, niente accenti/punteggiatura, spazi singoli
function normChain(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function inferChain(tags) {
  const brand = tags.brand || tags.operator;
  if (brand) return brand.trim().slice(0, 60);
  const name = normChain(tags.name);
  if (!name) return null;
  // Ordina per lunghezza decrescente: "Conad Superstore" prima di "Conad"
  const sorted = [...KNOWN_CHAINS].sort((a, b) => b.length - a.length);
  for (const c of sorted) {
    if (name.includes(normChain(c))) return c;
  }
  return null;
}

function pickName(tags) {
  return (tags.name || tags.brand || tags.operator || 'Supermercato').trim().slice(0, 120);
}

function pickAddress(tags) {
  const parts = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']].filter(Boolean);
  const a = parts.join(' ').trim();
  return a ? a.slice(0, 200) : (tags['addr:city'] || null);
}

async function fetchBandOnce([s, w, n, e], endpoint) {
  const query = `[out:json][timeout:180];
(
  node["shop"="supermarket"](${s},${w},${n},${e});
  way["shop"="supermarket"](${s},${w},${n},${e});
);
out center tags;`;
  const { data } = await axios.post(endpoint, 'data=' + encodeURIComponent(query), {
    timeout: 200000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
  });
  return data.elements || [];
}

// Scarica una fascia con retry + rotazione dei mirror. 429 (rate-limit) e 504
// (gateway timeout) sono transitori: aspettiamo e riproviamo, cambiando mirror.
async function fetchBand(band) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES_PER_BAND; attempt++) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      return await fetchBandOnce(band, endpoint);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // backoff crescente: 30s, 60s, 90s…
      const waitMs = 30000 * (attempt + 1);
      const host = endpoint.replace('https://', '').split('/')[0];
      process.stdout.write(`[${host} ${status || err.code || 'err'}, ritento tra ${waitMs/1000}s] `);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

async function main() {
  // 1. Scarica da Overpass, fascia per fascia, deduplicando per id OSM
  const byId = new Map();
  for (let i = 0; i < BANDS.length; i++) {
    process.stdout.write(`Scarico fascia ${i + 1}/${BANDS.length} da OpenStreetMap... `);
    try {
      const els = await fetchBand(BANDS[i]);
      for (const el of els) byId.set(`${el.type}/${el.id}`, el);
      console.log(`${els.length} elementi (totale unici: ${byId.size})`);
    } catch (err) {
      console.log(`ERRORE dopo ${MAX_RETRIES_PER_BAND} tentativi: ${err.message}`);
    }
    // Pausa tra una fascia e l'altra per non innescare il rate-limit Overpass
    if (i < BANDS.length - 1) {
      process.stdout.write(`(pausa ${PAUSE_BETWEEN_BANDS_MS / 1000}s)\n`);
      await sleep(PAUSE_BETWEEN_BANDS_MS);
    }
  }

  // 2. Costruisce le righe negozio
  const rows = [];
  for (const el of byId.values()) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    rows.push({
      id: `osm-${el.type}-${el.id}`,
      name: pickName(el.tags || {}),
      address: pickAddress(el.tags || {}),
      latitude: lat,
      longitude: lon,
      chain: inferChain(el.tags || {}),
      rating: 0,
    });
  }
  console.log(`Negozi validi da inserire: ${rows.length}`);

  // Sicurezza: se il download è fallito del tutto (0 negozi, es. tutte le fasce in
  // errore), NON cancellare i negozi esistenti — meglio tenere i vecchi che svuotare.
  if (rows.length === 0) {
    console.log('Nessun negozio scaricato: lascio invariato il DB. Riprova più tardi.');
    await prisma.$disconnect();
    return;
  }

  // 3. Pulisce i negozi di esempio precedenti (prodotti eliminati in cascata)
  const del = await prisma.store.deleteMany({
    where: { OR: [{ id: { startsWith: 'seed-' } }, { id: { startsWith: 'osm-' } }] },
  });
  console.log(`Rimossi ${del.count} negozi precedenti (seed/osm)`);

  // 4. Inserisce in batch
  const BATCH = 1000;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await prisma.store.createMany({ data: chunk, skipDuplicates: true });
    inserted += res.count;
    process.stdout.write(`\rInseriti ${inserted}/${rows.length}`);
  }
  console.log(`\nFatto. Negozi totali nel DB: ${await prisma.store.count()}`);
}

main()
  .catch((e) => { console.error('Errore import:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
