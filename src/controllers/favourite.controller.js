const prisma = require('../config/database');
const { success, error } = require('../utils/response');

async function getFavourites(req, res) {
  const favourites = await prisma.favourite.findMany({
    where: { userId: req.userId },
    include: { store: true },
  });
  return success(res, { favourites });
}

async function addFavourite(req, res) {
  const { storeId } = req.body;
  if (!storeId) return error(res, 'storeId obbligatorio');

  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) return error(res, 'Negozio non trovato', 404);

  const fav = await prisma.favourite.upsert({
    where: { userId_storeId: { userId: req.userId, storeId } },
    update: {},
    create: { userId: req.userId, storeId },
    include: { store: true },
  });

  return success(res, { favourite: fav }, 201);
}

async function removeFavourite(req, res) {
  await prisma.favourite.deleteMany({ where: { userId: req.userId, storeId: req.params.storeId } });
  return success(res, { message: 'Rimosso dai preferiti' });
}

module.exports = { getFavourites, addFavourite, removeFavourite };
