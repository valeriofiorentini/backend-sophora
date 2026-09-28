'use strict';

/**
 * Ultimo test diagnostico di sola lettura: prova se aggiungendo intestazioni
 * più simili a un browser vero (lingua, referer, accept) Tiendeo restituisce
 * dal server la lista di volantini corretta per città, invece di quella
 * generica identica per tutti (Conad/Lidl).
 *
 * Uso: node scripts/check-tiendeo-headers.js
 */
const axios = require('axios');

function decodeRscFlight(html) {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let out = '', m;
  while ((m = re.exec(html))) { try { out += JSON.parse('"' + m[1] + '"'); } catch {} }
  return out;
}
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

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://www.tiendeo.it/',
};

async function namesFor(city) {
  const { data: html } = await axios.get(`https://www.tiendeo.it/${city}`, { timeout: 25000, headers: HEADERS });
  const raw = extractJsonArray(decodeRscFlight(html), 'flyers');
  if (!raw) return 'NESSUN VOLANTINO TROVATO';
  return JSON.parse(raw).map(f => f.retailerName);
}

async function main() {
  const torino = await namesFor('torino');
  const napoli = await namesFor('napoli');
  console.log('torino:', JSON.stringify(torino));
  console.log('napoli:', JSON.stringify(napoli));
  console.log('identici:', JSON.stringify(torino) === JSON.stringify(napoli));
}

main().catch(e => console.error(e));
