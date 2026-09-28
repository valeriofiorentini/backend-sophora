'use strict';

/**
 * Controllo di sola lettura: per un elenco di città, conta quante offerte
 * attive vedrebbe davvero un utente aprendo "Offerte vicino a te" da lì
 * (stessa logica/raggio di promo.controller.getPromos).
 *
 * Uso: node scripts/check-promo-coverage.js
 */
const prisma = require('../src/config/database');
const { haversineKm } = require('../src/services/geo.service');

const RADIUS_KM = 50;

const CITIES = [
  { name: 'Roma',     lat: 41.9028, lon: 12.4964 },
  { name: 'Milano',   lat: 45.4642, lon: 9.1900 },
  { name: 'Napoli',   lat: 40.8518, lon: 14.2681 },
  { name: 'Torino',   lat: 45.0703, lon: 7.6869 },
  { name: 'Palermo',  lat: 38.1157, lon: 13.3615 },
  { name: 'Bari',     lat: 41.1171, lon: 16.8719 },
  { name: 'Bologna',  lat: 44.4949, lon: 11.3426 },
  { name: 'Firenze',  lat: 43.7696, lon: 11.2558 },
  { name: 'Catania',  lat: 37.5079, lon: 15.0830 },
  { name: 'Venezia',  lat: 45.4408, lon: 12.3155 },
];

async function main() {
  const now = new Date();
  const promos = await prisma.promo.findMany({
    where: { validUntil: { gte: now } },
    select: { latitude: true, longitude: true },
  });

  console.log(`Offerte attive totali nel DB: ${promos.length}\n`);
  console.log('Città'.padEnd(10), 'Offerte entro 50km');
  console.log('-'.repeat(32));

  for (const city of CITIES) {
    const count = promos.filter(p => {
      if (p.latitude == null || p.longitude == null) return false;
      return haversineKm(city.lat, city.lon, p.latitude, p.longitude) <= RADIUS_KM;
    }).length;
    console.log(city.name.padEnd(10), count);
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
