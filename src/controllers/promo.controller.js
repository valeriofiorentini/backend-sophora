const prisma = require('../config/database');
const { success, error } = require('../utils/response');

async function getPromos(req, res) {
  const { latitude, longitude, chain, radius = 50 } = req.query;
  const now = new Date();

  const promos = await prisma.promo.findMany({
    where: {
      validUntil: { gt: now },
      ...(chain && { storeChain: { contains: chain, mode: 'insensitive' } }),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  // Filter by distance if coordinates provided
  let result = promos;
  if (latitude && longitude) {
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);
    const r = parseFloat(radius);

    result = promos.filter(p => {
      if (!p.latitude || !p.longitude) return true; // no location = show anyway
      const dLat = ((p.latitude - lat) * Math.PI) / 180;
      const dLon = ((p.longitude - lon) * Math.PI) / 180;
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos((lat * Math.PI) / 180) * Math.cos((p.latitude * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
      const dist = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return dist <= r;
    });
  }

  return success(res, { promos: result, total: result.length });
}

async function getTodayPromos(req, res) {
  const now = new Date();
  const promos = await prisma.promo.findMany({
    where: { validUntil: { gt: now } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  return success(res, { promos });
}

async function deletePromo(req, res) {
  await prisma.promo.deleteMany({
    where: { validUntil: { lt: new Date() } },
  });
  return success(res, { message: 'Promo scadute eliminate' });
}

module.exports = { getPromos, getTodayPromos, deletePromo };
