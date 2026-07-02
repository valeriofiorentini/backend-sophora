/**
 * geo.service — utilità geografiche condivise.
 *
 * Sostituisce le ~6 copie locali di haversine sparse nei controller.
 *
 * Pattern d'uso per le query "vicino a me":
 *   1. bbox(lat, lon, radiusKm) → riquadro per il WHERE Prisma (usa gli indici,
 *      scarta subito il 99% delle righe lontane)
 *   2. haversineKm() sulle righe rimaste per il filtro circolare preciso
 */

const EARTH_RADIUS_KM = 6371;

/** Distanza in km tra due coordinate (formula di Haversine). */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Bounding box attorno a un punto: il quadrato che contiene il cerchio
 * di raggio radiusKm. Filtro approssimato ma indicizzabile.
 */
function bbox(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32; // 1° di latitudine ≈ 111.32 km
  const cos = Math.cos((lat * Math.PI) / 180);
  // ai poli cos→0: evita divisione per zero allargando a tutto il globo
  const dLon = cos > 1e-6 ? radiusKm / (111.32 * cos) : 180;
  return {
    minLat: lat - dLat,
    maxLat: lat + dLat,
    minLon: lon - dLon,
    maxLon: lon + dLon,
  };
}

/**
 * Clausola WHERE Prisma per righe dentro il bounding box.
 * I nomi dei campi sono configurabili (default latitude/longitude).
 */
function bboxWhere(lat, lon, radiusKm, fields = {}) {
  const latField = fields.lat || 'latitude';
  const lonField = fields.lon || 'longitude';
  const b = bbox(lat, lon, radiusKm);
  return {
    [latField]: { gte: b.minLat, lte: b.maxLat },
    [lonField]: { gte: b.minLon, lte: b.maxLon },
  };
}

module.exports = { haversineKm, bbox, bboxWhere };
