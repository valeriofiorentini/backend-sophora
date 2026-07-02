/**
 * promoNotify.service.js
 * Notifica gli utenti delle offerte nuove vicino a loro.
 *
 * Flusso:
 *  - per ogni utente con fcmToken + posizione nota
 *  - trova le promo create dopo l'ultima notifica, ancora valide, entro NEAR_RADIUS_KM
 *  - invia UNA push riepilogo + crea una Notification in-app
 *  - aggiorna lastPromoNotifyAt (anti-spam: max 1 digest per esecuzione)
 *
 * Va chiamato dallo scheduler dopo lo scraper (1 volta al giorno).
 */

const prisma = require('../config/database');
const { sendPush } = require('./push.service');
const { haversineKm: distanceKm } = require('./geo.service');

const NEAR_RADIUS_KM = 30;   // raggio entro cui un'offerta è "vicina"
const MAX_PROMOS_LISTED = 3; // quante offerte citare nel testo della push

/**
 * Notifica tutti gli utenti idonei delle nuove offerte vicine.
 * @returns {{ notifiedUsers: number, pushSent: number }}
 */
async function notifyNearbyPromos() {
  const now = new Date();

  // 1. Utenti con token push e posizione nota
  const users = await prisma.user.findMany({
    where: {
      fcmToken:  { not: null },
      latitude:  { not: null },
      longitude: { not: null },
    },
    select: { id: true, fcmToken: true, latitude: true, longitude: true, lastPromoNotifyAt: true },
  });

  if (users.length === 0) {
    console.log('[promoNotify] nessun utente con token+posizione');
    return { notifiedUsers: 0, pushSent: 0 };
  }

  // 2. Promo valide con coordinate (le carichiamo una volta sola)
  const promos = await prisma.promo.findMany({
    where: {
      validUntil: { gt: now },
      latitude:   { not: null },
      longitude:  { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  if (promos.length === 0) {
    console.log('[promoNotify] nessuna promo geolocalizzata valida');
    return { notifiedUsers: 0, pushSent: 0 };
  }

  let notifiedUsers = 0;
  let pushSent = 0;

  for (const u of users) {
    // Solo le offerte create dopo l'ultima notifica dell'utente (o, se prima volta, ultime 7 gg)
    const since = u.lastPromoNotifyAt || new Date(now - 7 * 86_400_000);

    const nearby = promos.filter(p => {
      if (p.createdAt <= since) return false;
      return distanceKm(u.latitude, u.longitude, p.latitude, p.longitude) <= NEAR_RADIUS_KM;
    });

    if (nearby.length === 0) continue;

    // Testo riepilogo
    const sample = nearby.slice(0, MAX_PROMOS_LISTED)
      .map(p => `${p.productName}${p.price != null ? ` €${Number(p.price).toFixed(2)}` : ''}`)
      .join(', ');
    const title = nearby.length === 1
      ? '🏷️ Nuova offerta vicino a te'
      : `🏷️ ${nearby.length} nuove offerte vicino a te`;
    const body = nearby.length > MAX_PROMOS_LISTED
      ? `${sample} e altre ${nearby.length - MAX_PROMOS_LISTED}…`
      : sample;

    // Push + notifica in-app + aggiornamento timestamp (atomico-ish)
    const res = await sendPush(u.fcmToken, title, body, { type: 'nearby_promos', count: nearby.length });
    if (res) pushSent++;

    await prisma.notification.create({
      data: { userId: u.id, title, message: body, type: 'nearby_promos' },
    }).catch(() => {});

    await prisma.user.update({
      where: { id: u.id },
      data:  { lastPromoNotifyAt: now },
    }).catch(() => {});

    notifiedUsers++;
  }

  console.log(`[promoNotify] utenti notificati: ${notifiedUsers}, push inviate: ${pushSent}`);
  return { notifiedUsers, pushSent };
}

module.exports = { notifyNearbyPromos };
