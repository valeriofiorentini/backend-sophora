const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { error } = require('../utils/response');

// Cache esistenza + ruolo utente: evita una query DB a ogni richiesta
// autenticata. TTL 60s = un account eliminato (o promosso/declassato admin)
// riflette il cambiamento entro max 1 minuto.
const existsCache = new Map(); // userId → { until: ms epoch, isAdmin: bool }
const EXISTS_TTL_MS = 60_000;

/** Da chiamare quando un utente viene eliminato (delete-account). */
function invalidateAuthCache(userId) {
  existsCache.delete(userId);
}

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return error(res, 'Token mancante', 401);
  }

  const token = header.split(' ')[1];
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return error(res, 'Token non valido o scaduto', 401);
  }

  // Il token è firmato ma l'account potrebbe non esistere più
  // (eliminato, o DB resettato): verifica con cache breve. La cache tiene
  // anche isAdmin così adminOnly può fidarsi di req.isAdmin senza query extra.
  let isAdmin = false;
  try {
    const now = Date.now();
    const cached = existsCache.get(payload.userId);
    if (cached && cached.until >= now) {
      isAdmin = cached.isAdmin;
    } else {
      const user = await prisma.user.findUnique({
        where:  { id: payload.userId },
        select: { id: true, isAdmin: true },
      });
      if (!user) return error(res, 'Account non trovato', 401);
      isAdmin = user.isAdmin === true;
      // Evita crescita illimitata della cache
      if (existsCache.size > 10_000) existsCache.clear();
      existsCache.set(payload.userId, { until: now + EXISTS_TTL_MS, isAdmin });
    }
  } catch (e) {
    return next(e); // errore DB → 500 dal error handler
  }

  req.userId = payload.userId;
  req.isAdmin = isAdmin;
  next();
}

module.exports = { auth, invalidateAuthCache };
