/**
 * planLimits.js — Limiti gratuiti vs premium
 *
 * Free:    10 scontrini/mese, 15 messaggi AI/giorno
 * Premium: tutto illimitato + funzioni esclusive
 */

const prisma = require('../config/database');

const FREE_RECEIPTS_PER_MONTH = 10;
const FREE_CHAT_MSGS_PER_DAY  = 15;

/**
 * Ritorna true se l'utente è premium (isSubscribed === true nel DB).
 * `platform` (X-Platform) non e' piu' usato: su iOS Premium si compra con IAP, quindi vale il DB.
 */
async function isPremium(userId, platform) {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { isSubscribed: true },
  });
  return !!user?.isSubscribed;
}

/**
 * Controlla il limite scontrini mensili per gli utenti free.
 * Ritorna { allowed: boolean, used: number, limit: number }
 */
async function checkReceiptLimit(userId, platform) {
  if (await isPremium(userId, platform)) return { allowed: true, used: null, limit: null };

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  // Receipt usa processedAt (non createdAt)
  const used = await prisma.receipt.count({
    where: { userId, processedAt: { gte: startOfMonth } },
  });

  return {
    allowed: used < FREE_RECEIPTS_PER_MONTH,
    used,
    limit: FREE_RECEIPTS_PER_MONTH,
  };
}

/**
 * Controlla il limite messaggi AI giornalieri per gli utenti free.
 * Ritorna { allowed: boolean, used: number, limit: number }
 */
async function checkChatLimit(userId, platform) {
  if (await isPremium(userId, platform)) return { allowed: true, used: null, limit: null };

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const used = await prisma.chatMessage.count({
    where: {
      role:      'user',
      createdAt: { gte: startOfDay },
      session:   { userId },
    },
  });

  return {
    allowed: used < FREE_CHAT_MSGS_PER_DAY,
    used,
    limit: FREE_CHAT_MSGS_PER_DAY,
  };
}

module.exports = { isPremium, checkReceiptLimit, checkChatLimit };
