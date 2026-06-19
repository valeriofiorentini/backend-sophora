/**
 * push.service.js
 * Invio notifiche push tramite Firebase FCM.
 * Richiede FIREBASE_PROJECT_ID, FIREBASE_PRIVATE_KEY, FIREBASE_CLIENT_EMAIL in .env
 *
 * Graceful: se Firebase non è configurato, le funzioni sono no-op (log only).
 */

let admin = null;

function initFirebase() {
  if (admin) return admin;
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY) {
    console.warn('[Push] Firebase non configurato — notifiche push disabilitate');
    return null;
  }
  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });
    }
    console.log('[Push] Firebase inizializzato');
    return admin;
  } catch (err) {
    console.warn('[Push] Errore init Firebase:', err.message);
    return null;
  }
}

/**
 * Invia una notifica push a un singolo device token.
 */
async function sendPush(fcmToken, title, body, data = {}) {
  const fb = initFirebase();
  if (!fb || !fcmToken) return null;
  try {
    const result = await fb.messaging().send({
      token: fcmToken,
      notification: {title, body},
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      apns: {payload: {aps: {sound: 'default', badge: 1}}},
      android: {priority: 'high', notification: {sound: 'default'}},
    });
    return result;
  } catch (err) {
    console.warn('[Push] sendPush error:', err.message);
    return null;
  }
}

/**
 * Invia a più token in batch (max 500 per volta).
 */
async function sendMulticast(fcmTokens, title, body, data = {}) {
  const fb = initFirebase();
  if (!fb || !fcmTokens?.length) return null;
  try {
    const chunks = [];
    for (let i = 0; i < fcmTokens.length; i += 500) chunks.push(fcmTokens.slice(i, i + 500));
    for (const chunk of chunks) {
      await fb.messaging().sendEachForMulticast({
        tokens: chunk,
        notification: {title, body},
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
        apns: {payload: {aps: {sound: 'default'}}},
        android: {priority: 'high'},
      });
    }
    return true;
  } catch (err) {
    console.warn('[Push] sendMulticast error:', err.message);
    return null;
  }
}

/**
 * Notifica offerta vicina (geofencing).
 */
async function notifyNearbyOffer(userId, storeName, productName, price) {
  const prisma = require('../config/database');
  const user = await prisma.user.findUnique({
    where: {id: userId},
    select: {fcmToken: true, name: true},
  }).catch(() => null);

  if (!user?.fcmToken) return;

  return sendPush(
    user.fcmToken,
    `🏷️ Offerta vicino a te — ${storeName}`,
    `${productName} a €${price} · Sei vicino al negozio!`,
    {type: 'nearby_offer', storeName, productName, price: String(price)},
  );
}

/**
 * Notifica livello raggiunto.
 */
async function notifyLevelUp(userId, newLevel, badge) {
  const prisma = require('../config/database');
  const user = await prisma.user.findUnique({
    where: {id: userId},
    select: {fcmToken: true},
  }).catch(() => null);

  if (!user?.fcmToken) return;

  return sendPush(
    user.fcmToken,
    `${badge} Nuovo livello: ${newLevel.toUpperCase()}!`,
    'Hai sbloccato nuovi voucher e un moltiplicatore punti più alto 🎉',
    {type: 'level_up', level: newLevel},
  );
}

module.exports = {sendPush, sendMulticast, notifyNearbyOffer, notifyLevelUp};
