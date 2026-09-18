const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { uploadToS3 } = require('../config/s3');
const { processDiscountPost } = require('../services/communityPromo.service');
const { checkImageSafety } = require('../services/imageModeration.service');

async function getFeeds(req, res) {
  const { type, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  // type è un enum nel DB: valori sconosciuti vengono ignorati (niente 500)
  const validType = ['review', 'discount'].includes(type) ? type : undefined;

  // Non mostrare i post di utenti che l'utente corrente ha bloccato
  // (guideline 1.2 Apple/Google: block va sempre applicato insieme al report)
  const blocked = await prisma.blockedUser.findMany({
    where: { blockerId: req.userId },
    select: { blockedId: true },
  });
  const blockedIds = blocked.map(b => b.blockedId);

  const feeds = await prisma.feed.findMany({
    where: {
      isApproved: true,
      ...(validType && { type: validType }),
      ...(blockedIds.length > 0 && { userId: { notIn: blockedIds } }),
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
  // "location" arriva dal picker Google Places come GeoJSON Point
  // {type,coordinates:[lng,lat]} (stringificato nel multipart) — prima veniva
  // solo rimesso stringificato dentro storeLocation (mai leggibile), ora le
  // coordinate si estraggono davvero per il filtro "vicino a me/città".
  let   latitude = null;
  let   longitude = null;
  if (b.location) {
    try {
      const loc = typeof b.location === 'string' ? JSON.parse(b.location) : b.location;
      const [lng, lat] = loc?.coordinates || [];
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        latitude = lat;
        longitude = lng;
      }
      if (!storeLocation && loc?.address) storeLocation = loc.address;
    } catch {}
  }

  let image = null;
  const files = req.files || (req.file ? [req.file] : []);
  if (files.length > 0) {
    const urls = await Promise.all(files.map(f => uploadToS3(f, 'feeds')));
    const valid = urls.filter(Boolean);

    // Controllo automatico di sicurezza PRIMA di pubblicare: il post diventa
    // visibile pubblicamente ad altri utenti, va filtrato per nudità/violenza/
    // contenuti illegali richiesto dalle policy Google Play e App Store per
    // le app con contenuti generati dagli utenti.
    for (const url of valid) {
      const { safe, reason } = await checkImageSafety(url);
      if (!safe) {
        return error(res, `Immagine non pubblicabile: ${reason}`, 422);
      }
    }

    image = valid.length === 1 ? valid[0] : valid.length > 1 ? JSON.stringify(valid) : null;
  }

  const feed = await prisma.feed.create({
    data: {
      userId: req.userId,
      type,
      description,
      storeName,
      storeLocation,
      latitude,
      longitude,
      rating,
      image,
      isApproved: true,
    },
    include: { user: { select: { id: true, name: true, avatar: true } } },
  });

  // Pipeline sconto community (AI + promo + push) — fire-and-forget nel service
  if (type === 'discount' && image) {
    setImmediate(() => {
      processDiscountPost({
        feedId: feed.id,
        userId: req.userId,
        storeName,
        description,
        storeLocation,
        image,
      }).catch(e => console.warn('[feed] processDiscountPost error:', e.message));
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

  // Elimina anche la Promo generata dal post (niente offerte orfane)
  await prisma.$transaction([
    prisma.promo.deleteMany({ where: { feedId: feed.id } }),
    prisma.feed.delete({ where: { id: feed.id } }),
  ]);
  return success(res, { message: 'Post eliminato' });
}

// ─── POST /api/feeds/:id/report ──────────────────────────────────────────────
// Nasconde subito il post (isApproved=false) in attesa di revisione admin:
// meglio nascondere un post legittimo per errore che lasciare online per ore
// un contenuto segnalato come inappropriato.
async function reportFeed(req, res) {
  const feed = await prisma.feed.findUnique({ where: { id: req.params.id } });
  if (!feed) return error(res, 'Post non trovato', 404);

  await prisma.$transaction([
    prisma.feedReport.create({
      data: {
        feedId: req.params.id,
        reporterId: req.userId,
        reason: req.body?.reason || null,
      },
    }),
    prisma.feed.update({
      where: { id: req.params.id },
      data: { isApproved: false },
    }),
  ]);

  return success(res, { message: 'Segnalazione ricevuta, il post è stato nascosto in attesa di revisione' });
}

// ─── GET /api/feeds/admin/reported ────────────────────────────────────────────
async function getReportedFeeds(req, res) {
  const reports = await prisma.feedReport.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });

  const feedIds = [...new Set(reports.map(r => r.feedId))];
  const feeds = await prisma.feed.findMany({
    where: { id: { in: feedIds } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const feedById = Object.fromEntries(feeds.map(f => [f.id, f]));

  return success(res, {
    reports: reports.map(r => ({ ...r, feed: feedById[r.feedId] || null })),
  });
}

// ─── POST /api/feeds/admin/:reportId/resolve ─────────────────────────────────
// body: { action: 'approve' | 'reject' }
//  approve → il post era legittimo, si riattiva (isApproved=true)
//  reject  → il post viene eliminato definitivamente
async function resolveReport(req, res) {
  const { action } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return error(res, "action deve essere 'approve' o 'reject'", 400);
  }

  const report = await prisma.feedReport.findUnique({ where: { id: req.params.reportId } });
  if (!report) return error(res, 'Segnalazione non trovata', 404);

  if (action === 'approve') {
    await prisma.$transaction([
      prisma.feedReport.update({ where: { id: report.id }, data: { status: 'approved' } }),
      prisma.feed.update({ where: { id: report.feedId }, data: { isApproved: true } }),
    ]);
  } else {
    await prisma.$transaction([
      prisma.feedReport.update({ where: { id: report.id }, data: { status: 'rejected' } }),
      prisma.promo.deleteMany({ where: { feedId: report.feedId } }),
      prisma.feed.delete({ where: { id: report.feedId } }).catch(() => {}), // già eliminato da un'altra risoluzione
    ]);
  }

  return success(res, { message: 'Segnalazione risolta' });
}

module.exports = {
  getFeeds,
  createFeed,
  updateFeed,
  deleteFeed,
  reportFeed,
  getReportedFeeds,
  resolveReport,
};
