/**
 * comuniGeo.js — coordinate di TUTTI i comuni italiani (~7980), da dataset
 * ISTAT pubblico (MatteoHenryChinaski/Comuni-Italiani-2018-Sql-Json-excel).
 *
 * Sostituisce la vecchia mappa hardcoded di ~70 capoluoghi in
 * import-flyer-prices.js: quella copriva solo le città già in CITIES,
 * scritte a mano (rischio di coordinate imprecise/dimenticate). Qui invece
 * il dato è verificabile e copre qualunque comune, anche se CITIES si espande.
 *
 * Uso: getCityCoords('guidonia-montecelio') → [lat, lon] | null
 * Lo slug è quello usato da Tiendeo negli URL (minuscolo, spazi/apostrofi → "-").
 */

const raw = require('../data/comuni-geo.json');

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // rimuove accenti (es. e accentata -> e)
    .toLowerCase()
    .replace(/'/g, '-') // L'Aquila -> l-aquila (come nello slug Tiendeo)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Alcuni nomi ISTAT hanno connettori ("di", "nel", "sul"...) che gli slug
// delle fonti esterne (Tiendeo) spesso omettono: "Reggio di Calabria" → ISTAT,
// ma lo slug è "reggio-calabria". Indicizziamo entrambe le forme.
const CONNECTORS = /-(di|del|della|dei|nel|nell|nella|sul|sulla|sull|in)-/g;

const byExactSlug = new Map();
const byStrippedSlug = new Map();

for (const row of raw) {
  const lat = parseFloat(row.lat);
  const lon = parseFloat(row.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  const slug = slugify(row.comune);
  if (!byExactSlug.has(slug)) byExactSlug.set(slug, [lat, lon]);
  const stripped = slug.replace(CONNECTORS, '-');
  if (!byStrippedSlug.has(stripped)) byStrippedSlug.set(stripped, [lat, lon]);
}

/**
 * @param {string} citySlug slug tipo "roma", "guidonia-montecelio", "l-aquila"
 * @returns {[number, number] | null} [lat, lon] oppure null se non trovato
 */
function getCityCoords(citySlug) {
  const slug = slugify(citySlug);
  return byExactSlug.get(slug) || byStrippedSlug.get(slug) || null;
}

module.exports = { getCityCoords };
