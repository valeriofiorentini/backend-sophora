'use strict';

/**
 * iap.controller.js
 *
 * Gestisce gli acquisti Apple In-App Purchase (StoreKit) per iOS.
 * Flusso:
 *  1. App completa l'acquisto nativo con react-native-iap
 *  2. App chiama POST /api/iap/verify-receipt con la ricevuta
 *  3. Backend verifica la ricevuta con i server Apple (production, poi
 *     sandbox se serve — vedi APPLE_STATUS_SANDBOX_RECEIPT) e attiva
 *     isSubscribed
 *  4. Apple chiama POST /api/iap/apple-notifications sui rinnovi/cancellazioni
 *     (App Store Server Notifications V2) per tenere lo stato aggiornato
 *     nel tempo, dato che i rinnovi avvengono silenziosamente lato Apple
 */

const prisma = require('../config/database');
const { success, error } = require('../utils/response');

const APPLE_PROD_URL    = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
const APPLE_STATUS_SANDBOX_RECEIPT = 21007; // "questa è una ricevuta sandbox usata in produzione"

async function callAppleVerify(url, receiptData) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'receipt-data': receiptData,
      password: process.env.APPLE_SHARED_SECRET, // "Shared Secret" da App Store Connect > Info app > Informazioni sull'app > Segreto condiviso app
      'exclude-old-transactions': true,
    }),
  });
  return res.json();
}

// ─── POST /api/iap/verify-receipt ────────────────────────────────────────────
async function verifyReceipt(req, res) {
  const { receiptData, productId } = req.body;
  if (!receiptData) return error(res, 'receiptData mancante', 400);

  if (!process.env.APPLE_SHARED_SECRET) {
    return error(res, 'Apple IAP non configurato sul server', 503);
  }

  try {
    let result = await callAppleVerify(APPLE_PROD_URL, receiptData);

    // Se la ricevuta è di sandbox ma l'abbiamo mandata a produzione, riprova su sandbox
    if (result.status === APPLE_STATUS_SANDBOX_RECEIPT) {
      result = await callAppleVerify(APPLE_SANDBOX_URL, receiptData);
    }

    if (result.status !== 0) {
      console.warn('[iap] verifica ricevuta fallita, status Apple:', result.status);
      return error(res, 'Ricevuta non valida', 400);
    }

    // Ultima transazione valida per questo prodotto (gestisce anche i rinnovi
    // già avvenuti prima che l'app richiamasse questo endpoint)
    const latestReceiptInfo = result.latest_receipt_info || result.receipt?.in_app || [];
    const relevant = latestReceiptInfo
      .filter(t => !productId || t.product_id === productId)
      .sort((a, b) => Number(b.expires_date_ms || 0) - Number(a.expires_date_ms || 0))[0];

    if (!relevant) return error(res, 'Nessuna transazione trovata nella ricevuta', 400);

    const expiresAt = relevant.expires_date_ms ? new Date(Number(relevant.expires_date_ms)) : null;
    const isActive  = expiresAt ? expiresAt.getTime() > Date.now() : true;

    await prisma.$transaction([
      prisma.user.update({
        where: { id: req.userId },
        data:  { isSubscribed: isActive },
      }),
      prisma.subscription.upsert({
        where:  { userId: req.userId },
        update: {
          provider: 'apple',
          appleOriginalTransactionId: relevant.original_transaction_id,
          appleProductId: relevant.product_id,
          status: isActive ? 'active' : 'expired',
          currentPeriodEnd: expiresAt,
        },
        create: {
          userId: req.userId,
          provider: 'apple',
          appleOriginalTransactionId: relevant.original_transaction_id,
          appleProductId: relevant.product_id,
          status: isActive ? 'active' : 'expired',
          currentPeriodEnd: expiresAt,
        },
      }),
    ]);

    return success(res, { isSubscribed: isActive, expiresAt });
  } catch (err) {
    console.error('[iap] verifyReceipt error:', err.message);
    return error(res, 'Errore durante la verifica della ricevuta', 500);
  }
}

// ─── POST /api/iap/apple-notifications ───────────────────────────────────────
// Apple Server Notifications V2 — nessuna autenticazione utente (chiamata da Apple),
// il payload è un JWS firmato da Apple; qui ci limitiamo a decodificarlo senza
// verificarne la firma crittografica completa (TODO: verificare con le chiavi
// pubbliche Apple prima di andare in produzione con volumi reali).
async function handleAppleNotification(req, res) {
  try {
    const signedPayload = req.body.signedPayload;
    if (!signedPayload) return res.status(400).send('missing signedPayload');

    const payloadBase64 = signedPayload.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));

    const dataBase64 = payload.data?.signedTransactionInfo?.split('.')[1];
    if (!dataBase64) return res.status(200).send('ok'); // notifica senza dati transazione, ignora

    const tx = JSON.parse(Buffer.from(dataBase64, 'base64').toString('utf8'));
    const originalTransactionId = tx.originalTransactionId;
    const expiresAt = tx.expiresDate ? new Date(Number(tx.expiresDate)) : null;
    const isActive  = expiresAt ? expiresAt.getTime() > Date.now() : false;

    const sub = await prisma.subscription.findUnique({
      where: { appleOriginalTransactionId: originalTransactionId },
    });

    if (sub) {
      await prisma.$transaction([
        prisma.subscription.update({
          where: { id: sub.id },
          data:  { status: isActive ? 'active' : 'expired', currentPeriodEnd: expiresAt },
        }),
        prisma.user.update({
          where: { id: sub.userId },
          data:  { isSubscribed: isActive },
        }),
      ]);
    }

    return res.status(200).send('ok');
  } catch (err) {
    console.error('[iap] handleAppleNotification error:', err.message);
    return res.status(200).send('ok'); // rispondere sempre 200 ad Apple per evitare retry infiniti
  }
}

module.exports = { verifyReceipt, handleAppleNotification };
