'use strict';

/**
 * Diagnostica di sola lettura: guarda la risposta grezza HTTP di Tiendeo
 * per due città diverse, per capire se il server riceve davvero pagine
 * diverse o sempre la stessa (cache/fallback per IP data center).
 *
 * Uso: node scripts/check-tiendeo-raw.js
 */
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function check(city) {
  const res = await axios.get(`https://www.tiendeo.it/${city}`, {
    timeout: 25000,
    headers: { 'User-Agent': UA },
    validateStatus: () => true,
  });
  const html = res.data;
  console.log(`\n=== ${city} ===`);
  console.log('status:', res.status);
  console.log('content-length:', html.length);
  console.log('cache headers:', JSON.stringify({
    'cache-control': res.headers['cache-control'],
    'cf-cache-status': res.headers['cf-cache-status'],
    'x-cache': res.headers['x-cache'],
    'age': res.headers['age'],
  }));
  const titleMatch = html.match(/<title>(.*?)<\/title>/);
  console.log('title:', titleMatch ? titleMatch[1] : 'NON TROVATO');
}

async function main() {
  await check('torino');
  await check('napoli');
  await check('roma');
}

main().catch(e => console.error(e));
