/**
 * gamification.service.js
 *
 * Estratto da gamification.controller.js: prima la logica di dominio (calcolo
 * livelli, assegnazione punti, acquisto/uso voucher) viveva nel controller e
 * veniva importata direttamente da altri controller (scannedProduct, receipt)
 * con `require('./gamification.controller')` — un controller che importa da
 * un altro controller invece che da un service è il sintomo di un service
 * layer assente. Ora la logica sta qui; i controller restano un layer sottile
 * che parsa la request e traduce il risultato in risposta HTTP.
 *
 * Le funzioni che possono fallire per un motivo "atteso" (voucher non
 * trovato, punti insufficienti, race condition sul saldo, ecc.) lanciano un
 * Error con `.statusCode` — l'errorHandler centralizzato lo traduce già
 * correttamente in risposta JSON, quindi i controller non devono duplicare
 * quella logica.
 */

const prisma  = require('../config/database');
const crypto  = require('crypto');
const redis   = require('./redis.service');
const { notifyLevelUp } = require('./push.service');

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

// Premi realmente erogabili dall'owner (nessuna partnership negozi richiesta).
// Alla riscossione l'utente riceve il premio via email entro 8 ore.
const VOUCHER_CATALOG = [
  { id: 'p1', type: 'premium_days',   value: 30,  pointsCost: 800,  description: '1 mese di Shopora Premium gratis',  storeChain: null, minLevel: null,     validDays: 60 },
  { id: 'a1', type: 'amazon_voucher', value: 5,   pointsCost: 1500, description: 'Buono Amazon da €5',                 storeChain: null, minLevel: null,     validDays: 90 },
  { id: 'a2', type: 'amazon_voucher', value: 10,  pointsCost: 3000, description: 'Buono Amazon da €10',                storeChain: null, minLevel: 'silver', validDays: 90 },
  { id: 'p2', type: 'premium_days',   value: 365, pointsCost: 5000, description: '1 anno di Shopora Premium gratis',  storeChain: null, minLevel: 'gold',   validDays: 90 },
  { id: 'a3', type: 'amazon_voucher', value: 25,  pointsCost: 7000, description: 'Buono Amazon da €25',                storeChain: null, minLevel: 'gold',   validDays: 90 },
];

// Codici voucher validi — whitelist per evitare IDOR su /use
const VOUCHER_CODE_REGEX = /^EM-[0-9A-F]{8}$/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

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

async function getProfile(userId) {
  let ul = await prisma.userLevel.findUnique({ where: { userId } });
  if (!ul) {
    ul = await prisma.userLevel.create({
      data: { userId, level: 'bronze', totalPoints: 0, currentStreak: 0, longestStreak: 0 },
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
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });

  // userIdHash: permette al client di identificarsi nella leaderboard
  // senza esporre l'UUID completo
  const userIdHash = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 8);

  return {
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
  };
}

async function getPoints(userId) {
  const ul = await prisma.userLevel.findUnique({ where: { userId } });
  return { points: ul?.totalPoints ?? 0, level: ul?.level ?? 'bronze' };
}

async function getLeaderboard() {
  // Cache Redis 5 minuti — evita full-scan ad ogni richiesta
  const CACHE_KEY = 'leaderboard:top20';
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

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
  return payload;
}

async function getVouchers(userId) {
  const now = new Date();

  // FIX: aggiorna scaduti con updateMany PRIMA della lettura
  // (i voucher "redeemed" scaduti vengono marcati expired in batch)
  await prisma.voucher.updateMany({
    where: {
      userId,
      status: 'redeemed',       // FIX: era 'available' — bug che non marcava mai scaduti
      expiresAt: { lt: now },
    },
    data: { status: 'expired' },
  });

  const vouchers = await prisma.voucher.findMany({
    where: { userId },
    orderBy: { redeemedAt: 'desc' },
  });

  return {
    available: vouchers.filter(v => v.status === 'redeemed' && v.expiresAt >= now),
    used:      vouchers.filter(v => v.status === 'used' || v.status === 'expired'),
  };
}

async function getVoucherCatalog(userId) {
  const ul     = await prisma.userLevel.findUnique({ where: { userId } });
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

  return { catalog, userPoints: points, userLevel: level };
}

async function purchaseVoucher(userId, catalogId) {
  if (!catalogId || typeof catalogId !== 'string') {
    throw httpError('catalogId obbligatorio', 400);
  }

  const template = VOUCHER_CATALOG.find(v => v.id === catalogId);
  if (!template) throw httpError('Voucher non trovato nel catalogo', 404);

  const ul = await prisma.userLevel.findUnique({ where: { userId } });
  if (!ul) throw httpError('Profilo utente non trovato', 404);

  if (ul.totalPoints < template.pointsCost) {
    throw httpError(
      `Punti insufficienti. Necessari: ${template.pointsCost}, disponibili: ${ul.totalPoints}`,
      400,
    );
  }

  if (template.minLevel) {
    const userIdx = LEVELS.findIndex(l => l.name === ul.level);
    const reqIdx  = LEVELS.findIndex(l => l.name === template.minLevel);
    if (userIdx < reqIdx) {
      throw httpError(`Richiede livello ${template.minLevel}`, 403);
    }
  }

  const newBalance = ul.totalPoints - template.pointsCost;
  const code       = generateVoucherCode();
  const expiresAt  = new Date(Date.now() + template.validDays * 86_400_000);

  // FIX TOCTOU (stesso pattern di useVoucher): tra la findUnique sopra e
  // questo update un'altra richiesta concorrente (doppio tap, due device)
  // poteva leggere lo stesso saldo e comprare un secondo voucher con gli
  // stessi punti — updateMany con guardia su totalPoints è atomico: se il
  // saldo è cambiato nel frattempo count è 0 e annulliamo la transazione.
  let voucher;
  try {
    [, , voucher] = await prisma.$transaction(async tx => {
      const guarded = await tx.userLevel.updateMany({
        where: { userId, totalPoints: ul.totalPoints },
        data:  { totalPoints: newBalance },
      });
      if (guarded.count === 0) {
        throw new Error('POINTS_CHANGED');
      }
      return Promise.all([
        guarded,
        tx.pointsTransaction.create({
          data: {
            userId,
            delta:   -template.pointsCost,
            action:  'voucher_redeem',
            balance: newBalance,
          },
        }),
        tx.voucher.create({
          data: {
            userId,
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
    });
  } catch (err) {
    if (err.message === 'POINTS_CHANGED') {
      throw httpError('Saldo punti cambiato, riprova.', 409);
    }
    throw err;
  }

  // Invalida cache leaderboard (punti cambiati)
  await redis.del('leaderboard:top20').catch(() => {});

  // Notifica l'owner via email così può consegnare il premio entro 8 ore (fire-and-forget)
  (async () => {
    try {
      const { sendMailWithAttachment } = require('./mailer');
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true, username: true },
      });
      const ownerEmail = process.env.OWNER_EMAIL || process.env.SMTP_USER;
      if (ownerEmail) {
        await sendMailWithAttachment(
          ownerEmail,
          `🎁 Premio riscattato: ${template.description}`,
          `<p>Un utente ha riscattato un premio.</p>
           <ul>
             <li><b>Premio:</b> ${template.description}</li>
             <li><b>Codice:</b> ${code}</li>
             <li><b>Utente:</b> ${u?.name || u?.username || '—'} (${u?.email || '—'})</li>
             <li><b>Punti spesi:</b> ${template.pointsCost}</li>
           </ul>
           <p>Consegna il premio all'utente entro 8 ore.</p>`,
          null,
        );
      }
    } catch (e) {
      console.warn('[gamification] owner notify error:', e.message);
    }
  })();

  return {
    voucher,
    remainingPoints: newBalance,
    message: 'Premio riscattato! Lo riceverai via email entro 8 ore.',
  };
}

async function useVoucher(userId, code) {
  if (!code || typeof code !== 'string') {
    throw httpError('Codice voucher obbligatorio', 400);
  }
  if (!VOUCHER_CODE_REGEX.test(code.trim())) {
    throw httpError('Formato codice non valido (atteso: EM-XXXXXXXX)', 400);
  }

  // Prima verifica che esista ed appartenga all'utente
  const voucher = await prisma.voucher.findUnique({ where: { code: code.trim() } });
  if (!voucher)                       throw httpError('Codice non valido', 404);
  if (voucher.userId !== userId)      throw httpError('Non autorizzato', 403);
  if (voucher.expiresAt < new Date()) throw httpError('Voucher scaduto', 400);
  if (voucher.status === 'used')      throw httpError('Voucher già utilizzato', 409);
  if (voucher.status === 'expired')   throw httpError('Voucher scaduto', 400);
  if (voucher.status !== 'redeemed')  throw httpError(`Stato voucher non valido: ${voucher.status}`, 400);

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
    throw httpError('Voucher non più disponibile', 409);
  }

  const label = voucher.type === 'percent_discount'
    ? `${voucher.value}% di sconto`
    : `€${voucher.value} di sconto`;

  return {
    voucher: { ...voucher, status: 'used' },
    message: `${label} applicato! ✅`,
  };
}

module.exports = {
  LEVELS,
  POINTS_MAP,
  VOUCHER_CATALOG,
  getLevelForPoints,
  getNextLevel,
  awardPoints,
  getProfile,
  getPoints,
  getLeaderboard,
  getVouchers,
  getVoucherCatalog,
  purchaseVoucher,
  useVoucher,
};
