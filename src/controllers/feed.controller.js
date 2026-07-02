const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { uploadToS3 } = require('../config/s3');
const { sendMulticast } = require('../services/push.service');
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});
const MODEL = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o' : 'gpt-4o';

// Distanza in km tra due coordinate (formula Haversine)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Estrae storeName e offerExpiresAt dalla foto del post (fire-and-forget)
async function extractDiscountMeta(imageUrl) {
  try {
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
    const raw = resp.choices[0]?.message?.content || '{}';
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Notifica utenti entro radiusKm dal punto della segnalazione
async function notifyNearbyUsers(posterId, lat, lon, storeName, productName, expiresAt, feedId, radiusKm = 15) {
  const users = await prisma.user.findMany({
    where: {
      id:       { not: posterId },
      fcmToken: { not: null },
      latitude:  { not: null },
      longitude: { not: null },
    },
    select: { id: true, fcmToken: true, latitude: true, longitude: true },
  });

  const tokens = users
    .filter(u => haversineKm(lat, lon, u.latitude, u.longitude) <= radiusKm)
    .map(u => u.fcmToken)
    .filter(Boolean);

  if (!tokens.length) return;

  const store   = storeName   || 'un negozio vicino a te';
  const product = productName || 'un nuovo sconto';
  const until   = expiresAt   ? ` · Valido fino al ${new Date(expiresAt).toLocaleDateString('it-IT')}` : '';

  await sendMulticast(
    tokens,
    `🏷️ Sconto segnalato vicino a te — ${store}`,
    `${product}${until}`,
    { type: 'community_discount', feedId: String(feedId) },
  );
}

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

  let image = null;
  const files = req.files || (req.file ? [req.file] : []);
  if (files.length > 0) {
    const urls = await Promise.all(files.map(f => uploadToS3(f, 'feeds')));
    const valid = urls.filter(Boolean);
    image = valid.length === 1 ? valid[0] : valid.length > 1 ? JSON.stringify(valid) : null;
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

  // Notifica utenti di zona solo per sconti con foto
  if (type === 'discount' && image) {
    setImmediate(async () => {
      try {
        // Coordinate del post (se l'utente ha selezionato il negozio)
        let lat = null, lon = null;
        if (storeLocation) {
          try {
            const loc = typeof storeLocation === 'string' ? JSON.parse(storeLocation) : storeLocation;
            lat = loc?.coordinates?.[1] ?? loc?.latitude ?? null;
            lon = loc?.coordinates?.[0] ?? loc?.longitude ?? null;
          } catch {}
        }
        // Fallback: posizione attuale dell'utente
        if (!lat || !lon) {
          const poster = await prisma.user.findUnique({ where: { id: req.userId }, select: { latitude: true, longitude: true } });
          lat = poster?.latitude;
          lon = poster?.longitude;
        }
        if (!lat || !lon) return;

        // Estrai info dallo sconto tramite AI (immagine)
        const firstImage = Array.isArray(JSON.parse(image || '[]')) ? JSON.parse(image)[0] : image;
        const meta = await extractDiscountMeta(firstImage);

        await notifyNearbyUsers(
          req.userId,
          lat, lon,
          meta.storeName || storeName,
          meta.productName || description,
          meta.offerExpiresAt,
          feed.id,
        );
      } catch (e) {
        console.warn('[feed] notifyNearby error:', e.message);
      }
    });
  }

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
