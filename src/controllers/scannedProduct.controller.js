const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { awardPoints } = require('./gamification.controller');

async function create(req, res) {
  const { barcode, name, price, quantity = 1, storeId, groupId, groupMemberId } = req.body;
  if (!name || price === undefined) return error(res, 'name e price obbligatori');

  const sp = await prisma.scannedProduct.create({
    data: {
      userId: req.userId,
      barcode,
      name,
      price: parseFloat(price),
      quantity: parseInt(quantity),
      storeId,
      groupId,
      groupMemberId,
    },
  });

  // Award 5 points per barcode scan (fire and forget)
  awardPoints(req.userId, 5, 'barcode_scan', sp.id);

  return success(res, { scannedProduct: sp }, 201);
}

async function getByTimestamp(req, res) {
  const { timeStamp } = req.params;
  const { groupId } = req.query;

  // timeStamp can be "YYYY-MM" for monthly view or a full ISO date
  let startDate, endDate;
  if (/^\d{4}-\d{2}$/.test(timeStamp)) {
    const [year, month] = timeStamp.split('-').map(Number);
    startDate = new Date(year, month - 1, 1);
    endDate = new Date(year, month, 0, 23, 59, 59);
  } else {
    startDate = new Date(timeStamp);
    endDate = new Date(timeStamp);
    endDate.setHours(23, 59, 59);
  }

  const where = {
    userId: req.userId,
    timestamp: { gte: startDate, lte: endDate },
    ...(groupId && { groupId }),
  };

  const items = await prisma.scannedProduct.findMany({ where, orderBy: { timestamp: 'desc' } });
  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);

  return success(res, { items, total: parseFloat(total.toFixed(2)) });
}

async function deleteById(req, res) {
  const sp = await prisma.scannedProduct.findUnique({ where: { id: req.params.id } });
  if (!sp || sp.userId !== req.userId) return error(res, 'Non trovato o non autorizzato', 404);

  await prisma.scannedProduct.delete({ where: { id: req.params.id } });
  return success(res, { message: 'Eliminato' });
}

async function exportReport(req, res) {
  const { month, year } = req.query;
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year) || new Date().getFullYear();

  const startDate = new Date(y, m - 1, 1);
  const endDate = new Date(y, m, 0, 23, 59, 59);

  const items = await prisma.scannedProduct.findMany({
    where: { userId: req.userId, timestamp: { gte: startDate, lte: endDate } },
    orderBy: { timestamp: 'asc' },
  });

  const total = items.reduce((s, i) => s + i.price * i.quantity, 0);

  const categoryTotals = items.reduce((acc, i) => {
    const key = i.storeId || 'Altro';
    acc[key] = (acc[key] || 0) + i.price * i.quantity;
    return acc;
  }, {});

  return success(res, {
    report: {
      month: m,
      year: y,
      items,
      total: parseFloat(total.toFixed(2)),
      categoryTotals,
      itemCount: items.length,
    },
  });
}

module.exports = { create, getByTimestamp, deleteById, exportReport };
