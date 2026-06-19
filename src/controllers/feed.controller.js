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

  return success(res, { feeds });
}

async function createFeed(req, res) {
  const { type, description, storeName, storeLocation, rating } = req.body;
  if (!type) return error(res, 'type obbligatorio (discount | review)');

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
      rating: rating ? parseFloat(rating) : null,
      image,
    },
    include: { user: { select: { id: true, name: true, avatar: true } } },
  });

  return success(res, { feed }, 201);
}

async function deleteFeed(req, res) {
  const feed = await prisma.feed.findUnique({ where: { id: req.params.id } });
  if (!feed || feed.userId !== req.userId) return error(res, 'Non trovato o non autorizzato', 404);

  await prisma.feed.delete({ where: { id: req.params.id } });
  return success(res, { message: 'Post eliminato' });
}

module.exports = { getFeeds, createFeed, deleteFeed };
