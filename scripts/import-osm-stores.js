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

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const UA = 'ShoporaSeed/1.0 (valeriofiorentini2002@gmail.com)';

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
];

function inferChain(tags) {
  const brand = tags.brand || tags.operator;
  if (brand) return brand.trim().slice(0, 60);
  const name = (tags.name || '').toLowerCase();
  for (const c of KNOWN_CHAINS) {
    if (name.includes(c.toLowerCase())) return c;
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

async function fetchBand([s, w, n, e]) {
  const query = `[out:json][timeout:180];
(
  node["shop"="supermarket"](${s},${w},${n},${e});
  way["shop"="supermarket"](${s},${w},${n},${e});
);
out center tags;`;
  const { data } = await axios.post(OVERPASS, 'data=' + encodeURIComponent(query), {
    timeout: 200000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
  });
  return data.elements || [];
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
      console.log(`ERRORE: ${err.message}`);
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
