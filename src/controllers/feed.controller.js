const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { uploadToS3 } = require('../config/s3');
const { processDiscountPost } = require('../services/communityPromo.service');

async function getFeeds(req, res) {
  const { type, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  // type è un enum nel DB: valori sconosciuti vengono ignorati (niente 500)
  const validType = ['review', 'discount'].includes(type) ? type : undefined;

  const feeds = await prisma.feed.findMany({
    where: {
      isApproved: true,
      ...(validType && { type: validType }),
    },
    include: { user: { select: { id: true, name: true, avatar: true } } },
    orderBy: { createdAt: 'desc' },
    skip,
    take: parseInt(limit),
  });

  return success(res, { feeds, feed: feeds });
}

async function createFeed(req, res) {
  const b = req.body;
  // Supporta sia i campi nuovi (name/isDiscount/location) che quelli legacy (type/storeName/storeLocation)
  const storeName    = b.name      || b.storeName    || null;
  const description  = b.description || null;
  const rating       = b.rating ? parseFloat(b.rating) : null;
  const type         = b.type || (b.isDiscount === 'true' || b.isDiscount === true ? 'discount' : 'review');
  let   storeLocation = b.storeLocation || null;
  // "location" arriva dal picker Google Places come GeoJSON Point
  // {type,coordinates:[lng,lat]} (stringificato nel multipart) — prima veniva
  // solo rimesso stringificato dentro storeLocation (mai leggibile), ora le
  // coordinate si estraggono davvero per il filtro "vicino a me/città".
  let   latitude = null;
  let   longitude = null;
  if (b.location) {
    try {
      const loc = typeof b.location === 'string' ? JSON.parse(b.location) : b.location;
      const [lng, lat] = loc?.coordinates || [];
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        latitude = lat;
        longitude = lng;
      }
      if (!storeLocation && loc?.address) storeLocation = loc.address;
    } catch {}
  }

  let image = null;
  const files = req.files || (req.file ? [req.file] : []);
  if (files.length > 0) {
    const urls = await Promise.all(files.map(f => uploadToS3(f, 'feeds')));
    const valid = urls.filter(Boolean);
    image = valid.length === 1 ? valid[0] : valid.length > 1 ? JSON.stringify(valid) : null;
  }

  const feed = await prisma.feed.create({
    data: {
      userId: req.userId,
      type,
      description,
      storeName,
      storeLocation,
      latitude,
      longitude,
      rating,
      image,
      isApproved: true,
    },
    include: { user: { select: { id: true, name: true, avatar: true } } },
  });

  // Pipeline sconto community (AI + promo + push) — fire-and-forget nel service
  if (type === 'discount' && image) {
    setImmediate(() => {
      processDiscountPost({
        feedId: feed.id,
        userId: req.userId,
        storeName,
        description,
        storeLocation,
        image,
      }).catch(e => console.warn('[feed] processDiscountPost error:', e.message));
    });
  }

  return success(res, { feed, success: true }, 201);
}

async function updateFeed(req, res) {
  const feed = await prisma.feed.findUnique({ where: { id: req.params.id } });
  if (!feed || feed.userId !== req.userId) return error(res, 'Non trovato o non autorizzato', 404);

  const b = req.body;
  const updated = await prisma.feed.update({
    where: { id: req.params.id },
    data: {
      description: b.description ?? feed.description,
      storeName:   b.storeName   ?? feed.storeName,
      rating:      b.rating !== undefined ? parseFloat(b.rating) : feed.rating,
    },
    include: { user: { select: { id: true, name: true, avatar: true } } },
  });
  return success(res, { feed: updated });
}

async function deleteFeed(req, res) {
  const feed = await prisma.feed.findUnique({ where: { id: req.params.id } });
  if (!feed || feed.userId !== req.userId) return error(res, 'Non trovato o non autorizzato', 404);

  // Elimina anche la Promo generata dal post (niente offerte orfane)
  await prisma.$transaction([
    prisma.promo.deleteMany({ where: { feedId: feed.id } }),
    prisma.feed.delete({ where: { id: feed.id } }),
  ]);
  return success(res, { message: 'Post eliminato' });
}

module.exports = { getFeeds, createFeed, updateFeed, deleteFeed };
