const prisma = require('../config/database');
const { success } = require('../utils/response');

async function getNotifications(req, res) {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return success(res, { notifications });
}

async function markAsRead(req, res) {
  await prisma.notification.updateMany({
    where: { userId: req.userId, isRead: false },
    data: { isRead: true },
  });
  return success(res, { message: 'Tutte le notifiche segnate come lette' });
}

module.exports = { getNotifications, markAsRead };
