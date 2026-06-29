const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { uploadToS3 } = require('../config/s3');

async function getFeeds(req, res) {
  const { type, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const feeds = await prisma.feed.findMany({
    where: {
      isApproved: true,
      ...(type && { type }),
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
  if (!storeLocation && b.location) {
    try { storeLocation = typeof b.location === 'string' ? b.location : JSON.stringify(b.location); } catch {}
  }

  let image;
  if (req.file) {
    image = await uploadToS3(req.file, 'feeds');
  }

  const feed = await prisma.feed.create({
    data: {
      userId: req.userId,
      type,
      description,
      storeName,
      storeLocation,
      rating,
      image,
      isApproved: true,
    },
    include: { user: { select: { id: true, name: true, avatar: true } } },
  });

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

  await prisma.feed.delete({ where: { id: req.params.id } });
  return success(res, { message: 'Post eliminato' });
}

module.exports = { getFeeds, createFeed, updateFeed, deleteFeed };
