/**
 * gamification.controller.js — V4
 * Sistema completo: punti con moltiplicatore livello, streak, voucher QR.
 *
 * Fix applicati:
 *  - awardPoints: atomica con prisma.$transaction (niente race condition)
 *  - getVouchers: bug filtro expired corretto (status 'redeemed' → scaduti)
 *  - useVoucher: atomic updateMany anti-TOCTOU (niente double-spend)
 *  - getLeaderboard: cache Redis 5 min + anonimizzazione userId
 *  - purchaseVoucher: validazione input esplicita
 *  - getVouchers: expire check separato da GET response
 */

const prisma  = require('../config/database');
const { success, error } = require('../utils/response');
const crypto  = require('crypto');
const redis   = require('../services/redis.service');
const { notifyLevelUp } = require('../services/push.service');

// ─── Costanti ─────────────────────────────────────────────────────────────────

const LEVELS = [
  { name: 'bronze',   minPoints: 0,    multiplier: 1.0, color: '#CD7F32', badge: '🥉' },
  { name: 'silver',   minPoints: 500,  multiplier: 1.2, color: '#A8A9AD', badge: '🥈' },
  { name: 'gold',     minPoints: 1500, multiplier: 1.5, color: '#FFD700', badge: '🥇' },
  { name: 'platinum', minPoints: 4000, multiplier: 2.0, color: '#E5E4E2', badge: '💎' },
];

const POINTS_MAP = {
  receipt_scan:  50,
  barcode_scan:   5,
  community_post: 20,
  streak_3days:   15,
  streak_7days:   50,
  streak_30days: 200,
  level_up:      100,
  referral:      200,
};

const VOUCHER_CATALOG = [
  { id: 'v1', type: 'percent_discount', value: 5,  pointsCost: 200,  description: '5% di sconto sul prossimo acquisto',   storeChain: null,         minLevel: null,       validDays: 30 },
  { id: 'v2', type: 'percent_discount', value: 10, pointsCost: 450,  description: '10% di sconto su Lidl',                storeChain: 'Lidl',       minLevel: 'silver',   validDays: 14 },
  { id: 'v3', type: 'fixed_discount',   value: 1,  pointsCost: 150,  description: '€1 di sconto sulla spesa',             storeChain: null,         minLevel: null,       validDays: 30 },
  { id: 'v4', type: 'fixed_discount',   value: 3,  pointsCost: 400,  description: '€3 di sconto su Esselunga',            storeChain: 'Esselunga',  minLevel: 'silver',   validDays: 21 },
  { id: 'v5', type: 'fixed_discount',   value: 5,  pointsCost: 700,  description: '€5 di sconto su acquisti >€30',        storeChain: null,         minLevel: 'gold',     validDays: 14 },
  { id: 'v6', type: 'cashback',         value: 2,  pointsCost: 300,  description: 'Cashback €2 sul prossimo scontrino',   storeChain: null,         minLevel: 'silver',   validDays: 30 },
  { id: 'v7', type: 'percent_discount', value: 20, pointsCost: 1500, description: '20% di sconto — Offerta Platinum',     storeChain: null,         minLevel: 'platinum', validDays:  7 },
];

// Codici voucher validi — whitelist per evitare IDOR su /use
const VOUCHER_CODE_REGEX = /^EM-[0-9A-F]{8}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Ritorna il livello corrispondente ai punti totali. */
function getLevelForPoints(total) {
  return [...LEVELS].reverse().find(l => total >= l.minPoints) ?? LEVELS[0];
}

/** Ritorna il livello successivo, o null se già platinum. */
function getNextLevel(currentName) {
  const idx = LEVELS.findIndex(l => l.name === currentName);
  return idx < LEVELS.length - 1 ? LEVELS[idx + 1] : null;
}

/** Genera un codice voucher sicuro: EM-XXXXXXXX */
function generateVoucherCode() {
  return 'EM-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

/** Calcola i giorni interi tra due Date (arrotondati verso il basso). */
function daysBetween(a, b) {
  return Math.floor(Math.abs(b - a) / 86_400_000);
}

// ─── awardPoints — ATOMICA con $transaction ────────────────────────────────────
/**
 * Assegna punti a un utente in modo atomico.
 * Calcola moltiplicatore di livello, aggiorna streak, lancia bonus livello-su.
 *
 * @param {string} userId
 * @param {number} basePoints - punti base prima del moltiplicatore
 * @param {string} action     - chiave da POINTS_MAP
 * @param {string|null} referenceId - id risorsa correlata (es. receiptId)
 * @returns {{ earned, newTotal, level, didLevelUp, streak, streakBonus } | null}
 */
async function awardPoints(userId, basePoints, action, referenceId = null) {
  let txResult;
  try {
    txResult = await prisma.$transaction(async tx => {
      // 1. Carica o inizializza UserLevel
      let ul = await tx.userLevel.findUnique({ where: { userId } });
      if (!ul) {
        ul = await tx.userLevel.create({
          data: { userId, level: 'bronze', totalPoints: 0, currentStreak: 0, longestStreak: 0 },
        });
      }

      // 2. Moltiplicatore livello corrente
      const levelInfo  = getLevelForPoints(ul.totalPoints);
      const earned     = Math.round(basePoints * levelInfo.multiplier);

      // 3. Streak: +1 se ieri, reset se >1 giorno, invariata se stesso giorno
      const now = new Date();
      let newStreak  = ul.currentStreak;
      let streakBonus = 0;

      if (ul.lastActivityAt) {
        const daysSince = daysBetween(ul.lastActivityAt, now);
        if (daysSince === 1) {
          newStreak += 1;
          if (newStreak === 3)  streakBonus = POINTS_MAP.streak_3days;
          if (newStreak === 7)  streakBonus = POINTS_MAP.streak_7days;
          if (newStreak === 30) streakBonus = POINTS_MAP.streak_30days;
        } else if (daysSince > 1) {
          newStreak = 1; // streak interrotta
        }
        // stesso giorno (daysSince === 0): newStreak invariata
      } else {
        newStreak = 1; // prima attività in assoluto
      }

      const totalEarned  = earned + streakBonus;
      const newTotal     = ul.totalPoints + totalEarned;
      const oldLevel     = ul.level;
      const newLevelInfo = getLevelForPoints(newTotal);
      const didLevelUp   = newLevelInfo.name !== oldLevel;

      // 4. Aggiorna UserLevel
      await tx.userLevel.update({
        where: { userId },
        data: {
          totalPoints:   newTotal,
          level:         newLevelInfo.name,
          currentStreak: newStreak,
          longestStreak: Math.max(newStreak, ul.longestStreak),
          lastActivityAt: now,
        },
      });

      // 5. Registra transazione punti principale
      await tx.pointsTransaction.create({
        data: { userId, delta: totalEarned, action, referenceId, balance: newTotal },
      });

      // 6. Bonus livello-su (dentro la stessa transaction)
      let finalTotal = newTotal;
      if (didLevelUp) {
        const bonus = POINTS_MAP.level_up;
        finalTotal  = newTotal + bonus;
        await tx.userLevel.update({
          where: { userId },
          data: { totalPoints: finalTotal },
        });
        await tx.pointsTransaction.create({
          data: { userId, delta: bonus, action: 'level_up', balance: finalTotal },
        });
      }

      // 7. Invalida cache leaderboard
      await redis.del('leaderboard:top20').catch(() => {});

      return {
        earned: totalEarned,
        newTotal: finalTotal,
        level: newLevelInfo.name,
        levelBadge: newLevelInfo.badge,
        didLevelUp,
        streak: newStreak,
        streakBonus,
      };
    }, { timeout: 10_000 }); // timeout 10s per la transaction
  } catch (err) {
    console.error('[gamification] awardPoints transaction error:', err.message);
    return null;
  }

  // Side-effects FUORI dalla transaction (non bloccano il commit)
  if (txResult?.didLevelUp) {
    const lvl = getLevelForPoints(txResult.newTotal);
    notifyLevelUp(userId, lvl.name, lvl.badge).catch(() => {});
  }

  // Legacy retrocompatibilità — errori non critici
  prisma.gamificationPoints.create({
    data: {
      userId,
      points: txResult?.earned ?? 0,
      action,
      referenceId,
    },
  }).catch(() => {});

  return txResult;
}

// ─── GET /api/gamification/profile ───────────────────────────────────────────
async function getProfile(req, res) {
  let ul = await prisma.userLevel.findUnique({ where: { userId: req.userId } });
  if (!ul) {
    ul = await prisma.userLevel.create({
      data: { userId: req.userId, level: 'bronze', totalPoints: 0, currentStreak: 0, longestStreak: 0 },
    });
  }

  const levelInfo  = getLevelForPoints(ul.totalPoints);
  const nextLevel  = getNextLevel(levelInfo.name);
  const pointsToNext = nextLevel ? nextLevel.minPoints - ul.totalPoints : 0;
  const progressPct  = nextLevel
    ? Math.min(100, Math.round(
        ((ul.totalPoints - levelInfo.minPoints) / (nextLevel.minPoints - levelInfo.minPoints)) * 100,
      ))
    : 100;

  const history = await prisma.pointsTransaction.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });

  // userIdHash: permette al client di identificarsi nella leaderboard
  // senza esporre l'UUID completo
  const userIdHash = crypto.createHash('sha256').update(req.userId).digest('hex').slice(0, 8);

  return success(res, {
    totalPoints:   ul.totalPoints,
    level:         levelInfo.name,
    levelBadge:    levelInfo.badge,
    levelColor:    levelInfo.color,
    multiplier:    levelInfo.multiplier,
    nextLevel:     nextLevel
      ? { name: nextLevel.name, badge: nextLevel.badge, minPoints: nextLevel.minPoints }
      : null,
    pointsToNext,
    progressPct,
    currentStreak: ul.currentStreak,
    longestStreak: ul.longestStreak,
    userIdHash,
    history,
  });
}

// ─── GET /api/gamification/points (legacy) ────────────────────────────────────
async function getPoints(req, res) {
  const ul = await prisma.userLevel.findUnique({ where: { userId: req.userId } });
  return success(res, { points: ul?.totalPoints ?? 0, level: ul?.level ?? 'bronze' });
}

// ─── GET /api/gamification/leaderboard ───────────────────────────────────────
async function getLeaderboard(req, res) {
  // Cache Redis 5 minuti — evita full-scan ad ogni richiesta
  const CACHE_KEY = 'leaderboard:top20';
  const cached = await redis.get(CACHE_KEY);
  if (cached) {
    return success(res, JSON.parse(cached));
  }

  const top = await prisma.userLevel.findMany({
    orderBy: { totalPoints: 'desc' },
    take: 20,
    include: { user: { select: { id: true, name: true } } },
  });

  const leaderboard = top.map((ul, i) => {
    const lvl = getLevelForPoints(ul.totalPoints);
    return {
      rank:        i + 1,
      // Espone solo le prime 2 lettere del nome + ID troncato per privacy
      name:        ul.user?.name ? ul.user.name.slice(0, 2) + '***' : 'Utente',
      totalPoints: ul.totalPoints,
      level:       ul.level,
      badge:       lvl.badge,
      streak:      ul.currentStreak,
      // userId anonimizzato: serve solo all'app per evidenziare "l'utente corrente"
      userIdHash:  crypto.createHash('sha256').update(ul.userId).digest('hex').slice(0, 8),
    };
  });

  const payload = { leaderboard };
  await redis.set(CACHE_KEY, JSON.stringify(payload), 300); // 5 min

  return success(res, payload);
}

// ─── GET /api/gamification/vouchers ──────────────────────────────────────────
async function getVouchers(req, res) {
  const now = new Date();

  // FIX: aggiorna scaduti con updateMany PRIMA della lettura
  // (i voucher "redeemed" scaduti vengono marcati expired in batch)
  await prisma.voucher.updateMany({
    where: {
      userId: req.userId,
      status: 'redeemed',       // FIX: era 'available' — bug che non marcava mai scaduti
      expiresAt: { lt: now },
    },
    data: { status: 'expired' },
  });

  const vouchers = await prisma.voucher.findMany({
    where: { userId: req.userId },
    orderBy: { redeemedAt: 'desc' },
  });

  return success(res, {
    available: vouchers.filter(v => v.status === 'redeemed' && v.expiresAt >= now),
    used:      vouchers.filter(v => v.status === 'used' || v.status === 'expired'),
  });
}

// ─── GET /api/gamification/vouchers/catalog ───────────────────────────────────
async function getVoucherCatalog(req, res) {
  const ul     = await prisma.userLevel.findUnique({ where: { userId: req.userId } });
  const points = ul?.totalPoints ?? 0;
  const level  = ul?.level ?? 'bronze';
  const userLvlIdx = LEVELS.findIndex(l => l.name === level);

  const catalog = VOUCHER_CATALOG.map(v => {
    const reqIdx = v.minLevel ? LEVELS.findIndex(l => l.name === v.minLevel) : 0;
    return {
      ...v,
      canAfford: points >= v.pointsCost,
      levelOk:   userLvlIdx >= reqIdx,
    };
  });

  return success(res, { catalog, userPoints: points, userLevel: level });
}

// ─── POST /api/gamification/vouchers/purchase ─────────────────────────────────
async function purchaseVoucher(req, res) {
  const { catalogId } = req.body;

  // Validazione input
  if (!catalogId || typeof catalogId !== 'string') {
    return error(res, 'catalogId obbligatorio');
  }

  const template = VOUCHER_CATALOG.find(v => v.id === catalogId);
  if (!template) return error(res, 'Voucher non trovato nel catalogo', 404);

  const ul = await prisma.userLevel.findUnique({ where: { userId: req.userId } });
  if (!ul) return error(res, 'Profilo utente non trovato', 404);

  if (ul.totalPoints < template.pointsCost) {
    return error(
      res,
      `Punti insufficienti. Necessari: ${template.pointsCost}, disponibili: ${ul.totalPoints}`,
      400,
    );
  }

  if (template.minLevel) {
    const userIdx = LEVELS.findIndex(l => l.name === ul.level);
    const reqIdx  = LEVELS.findIndex(l => l.name === template.minLevel);
    if (userIdx < reqIdx) {
      return error(res, `Richiede livello ${template.minLevel}`, 403);
    }
  }

  const newBalance = ul.totalPoints - template.pointsCost;
  const code       = generateVoucherCode();
  const expiresAt  = new Date(Date.now() + template.validDays * 86_400_000);

  // Transazione atomica: scala punti + crea voucher in un'unica operazione
  const [,, voucher] = await prisma.$transaction([
    prisma.userLevel.update({
      where: { userId: req.userId },
      data:  { totalPoints: newBalance },
    }),
    prisma.pointsTransaction.create({
      data: {
        userId:  req.userId,
        delta:   -template.pointsCost,
        action:  'voucher_redeem',
        balance: newBalance,
      },
    }),
    prisma.voucher.create({
      data: {
        userId:      req.userId,
        code,
        type:        template.type,
        value:       template.value,
        description: template.description,
        storeChain:  template.storeChain ?? null,
        pointsCost:  template.pointsCost,
        expiresAt,
        status:      'redeemed',
        redeemedAt:  new Date(),
      },
    }),
  ]);

  // Invalida cache leaderboard (punti cambiati)
  await redis.del('leaderboard:top20').catch(() => {});

  return success(res, { voucher, remainingPoints: newBalance }, 201);
}

// ─── POST /api/gamification/vouchers/use ──────────────────────────────────────
async function useVoucher(req, res) {
  const { code } = req.body;

  // Validazione input
  if (!code || typeof code !== 'string') {
    return error(res, 'Codice voucher obbligatorio');
  }
  if (!VOUCHER_CODE_REGEX.test(code.trim())) {
    return error(res, 'Formato codice non valido (atteso: EM-XXXXXXXX)');
  }

  // Prima verifica che esista ed appartenga all'utente
  const voucher = await prisma.voucher.findUnique({ where: { code: code.trim() } });
  if (!voucher)                         return error(res, 'Codice non valido', 404);
  if (voucher.userId !== req.userId)    return error(res, 'Non autorizzato', 403);
  if (voucher.expiresAt < new Date())   return error(res, 'Voucher scaduto', 400);
  if (voucher.status === 'used')        return error(res, 'Voucher già utilizzato', 409);
  if (voucher.status === 'expired')     return error(res, 'Voucher scaduto', 400);
  if (voucher.status !== 'redeemed')    return error(res, `Stato voucher non valido: ${voucher.status}`, 400);

  // FIX TOCTOU: updateMany con condizione status='redeemed' — atomico.
  // Se un altro processo ha già usato il voucher tra il findUnique e questo update,
  // count sarà 0 e restituiamo 409 invece di procedere.
  const updated = await prisma.voucher.updateMany({
    where: {
      id:       voucher.id,
      status:   'redeemed',        // condizione di guardia atomica
      expiresAt: { gt: new Date() },
    },
    data: { status: 'used', usedAt: new Date() },
  });

  if (updated.count === 0) {
    return error(res, 'Voucher non più disponibile', 409);
  }

  const label = voucher.type === 'percent_discount'
    ? `${voucher.value}% di sconto`
    : `€${voucher.value} di sconto`;

  return success(res, {
    voucher: { ...voucher, status: 'used' },
    message: `${label} applicato! ✅`,
  });
}

module.exports = {
  awardPoints,
  getPoints,
  getLeaderboard,
  getProfile,
  getVouchers,
  getVoucherCatalog,
  purchaseVoucher,
  useVoucher,
  POINTS_MAP,
};
