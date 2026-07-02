/**
 * communityPromo.service — pipeline "sconto segnalato dalla community".
 *
 * Quando un utente posta uno sconto con foto:
 *   1. risolve le coordinate (negozio selezionato o posizione del poster)
 *   2. estrae negozio/prodotto/scadenza dalla foto con GPT-4o Vision
 *   3. crea una Promo (→ appare in "Offerte vicino a te"), collegata al feed
 *   4. notifica via push gli utenti entro RADIUS_KM
 *
 * Va chiamato fire-and-forget (setImmediate) DOPO aver risposto al client:
 * l'AI impiega secondi e l'utente non deve aspettare.
 */

const prisma = require('../config/database');
const { sendMulticast } = require('./push.service');
const { haversineKm, bboxWhere } = require('./geo.service');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});
const MODEL = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o' : 'gpt-4o';

const RADIUS_KM = 15;             // raggio notifica utenti vicini
const DEFAULT_VALIDITY_DAYS = 7;  // validità promo se l'AI non estrae la scadenza

/**
 * Retry con backoff esponenziale (2s → 4s → 8s).
 * Copre i fallimenti transitori tipici del fire-and-forget: timeout AI,
 * blip di rete verso Firebase, deadlock DB momentanei.
 */
async function withRetry(fn, label, attempts = 3, baseDelayMs = 2000) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        const delay = baseDelayMs * 2 ** (i - 1);
        console.warn(`[communityPromo] ${label}: tentativo ${i}/${attempts} fallito (${e.message}) — retry tra ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Estrazione metadati dalla foto ───────────────────────────────────────────
async function extractDiscountMeta(imageUrl) {
  try {
    return await withRetry(async () => {
      const resp = await openai.chat.completions.create({
        model: MODEL,
        max_tokens: 300,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Guarda questa foto di uno sconto/offerta. Rispondi SOLO con JSON: {"storeName": "nome negozio o null", "offerExpiresAt": "YYYY-MM-DD o null", "productName": "prodotto principale o null"}' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
      });
      return JSON.parse(resp.choices[0]?.message?.content || '{}');
    }, 'AI extraction');
  } catch (e) {
    // Best-effort: dopo 3 tentativi si prosegue coi dati del post
    console.warn('[communityPromo] AI extraction fallita definitivamente:', e.message);
    return {};
  }
}

// ─── Push agli utenti vicini ──────────────────────────────────────────────────
async function notifyNearbyUsers(posterId, lat, lon, storeName, productName, expiresAt, feedId) {
  const users = await prisma.user.findMany({
    where: {
      id:       { not: posterId },
      fcmToken: { not: null },
      ...bboxWhere(lat, lon, RADIUS_KM),
    },
    select: { fcmToken: true, latitude: true, longitude: true },
  });

  const tokens = users
    .filter(u => haversineKm(lat, lon, u.latitude, u.longitude) <= RADIUS_KM)
    .map(u => u.fcmToken)
    .filter(Boolean);

  if (!tokens.length) return 0;

  const store   = storeName   || 'un negozio vicino a te';
  const product = productName || 'un nuovo sconto';
  const until   = expiresAt   ? ` · Valido fino al ${new Date(expiresAt).toLocaleDateString('it-IT')}` : '';

  await sendMulticast(
    tokens,
    `🏷️ Sconto segnalato vicino a te — ${store}`,
    `${product}${until}`,
    { type: 'community_discount', feedId: String(feedId) },
  );
  return tokens.length;
}

// ─── Risoluzione coordinate del post ──────────────────────────────────────────
async function resolveCoordinates(storeLocation, userId) {
  let lat = null, lon = null;
  if (storeLocation) {
    try {
      const loc = typeof storeLocation === 'string' ? JSON.parse(storeLocation) : storeLocation;
      lat = loc?.coordinates?.[1] ?? loc?.latitude ?? null;
      lon = loc?.coordinates?.[0] ?? loc?.longitude ?? null;
    } catch {}
  }
  if (!lat || !lon) {
    const poster = await prisma.user.findUnique({
      where: { id: userId },
      select: { latitude: true, longitude: true },
    });
    lat = poster?.latitude;
    lon = poster?.longitude;
  }
  return { lat, lon };
}

// ─── Pipeline completa ────────────────────────────────────────────────────────
async function processDiscountPost({ feedId, userId, storeName, description, storeLocation, image }) {
  const { lat, lon } = await resolveCoordinates(storeLocation, userId);
  if (!lat || !lon) {
    console.log('[communityPromo] nessuna coordinata disponibile, skip');
    return;
  }

  let firstImage = image;
  try { const arr = JSON.parse(image); if (Array.isArray(arr)) firstImage = arr[0]; } catch {}

  const meta = await extractDiscountMeta(firstImage);
  const resolvedStore   = meta.storeName   || storeName   || 'Negozio sconosciuto';
  const resolvedProduct = meta.productName || description || 'Sconto segnalato dalla community';
  const resolvedExpiry  = meta.offerExpiresAt;

  const validUntil = resolvedExpiry
    ? new Date(resolvedExpiry)
    : new Date(Date.now() + DEFAULT_VALIDITY_DAYS * 86_400_000);

  // 1. Promo → "Offerte vicino a te" — parte critica: retry, l'evento non va perso
  let promoOk = false;
  try {
    await withRetry(() => prisma.promo.create({
      data: {
        storeName:   resolvedStore,
        storeChain:  meta.storeName || storeName || null,
        productName: resolvedProduct,
        imageUrl:    firstImage || null,
        source:      'community',
        feedId,
        validFrom:   new Date(),
        validUntil,
        latitude:    lat,
        longitude:   lon,
      },
    }), 'promo create');
    promoOk = true;
  } catch (e) {
    console.error(`[communityPromo] PROMO PERSA per feed ${feedId} dopo tutti i retry:`, e.message);
  }

  // 2. Push utenti vicini — anch'essa con retry (blip di rete verso Firebase)
  let sent = 0;
  try {
    sent = await withRetry(
      () => notifyNearbyUsers(userId, lat, lon, resolvedStore, resolvedProduct, resolvedExpiry, feedId),
      'push nearby',
    );
  } catch (e) {
    console.error(`[communityPromo] push non inviate per feed ${feedId}:`, e.message);
  }

  console.log(`[communityPromo] feed ${feedId}: promo ${promoOk ? 'creata' : 'FALLITA'}, ${sent} push inviate`);
}

module.exports = { processDiscountPost, extractDiscountMeta, notifyNearbyUsers };
