const jwt = require('jsonwebtoken');
const prisma = require('../config/database');
const { error } = require('../utils/response');

// Cache esistenza utente: evita una query DB a ogni richiesta autenticata.
// TTL 60s = un account eliminato può usare il token ancora per max 1 minuto.
const existsCache = new Map(); // userId → scadenza cache (ms epoch)
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
  // (eliminato, o DB resettato): verifica con cache breve.
  try {
    const now = Date.now();
    const cachedUntil = existsCache.get(payload.userId);
    if (!cachedUntil || cachedUntil < now) {
      const user = await prisma.user.findUnique({
        where:  { id: payload.userId },
        select: { id: true },
      });
      if (!user) return error(res, 'Account non trovato', 401);
      // Evita crescita illimitata della cache
      if (existsCache.size > 10_000) existsCache.clear();
      existsCache.set(payload.userId, now + EXISTS_TTL_MS);
    }
  } catch (e) {
    return next(e); // errore DB → 500 dal error handler
  }

  req.userId = payload.userId;
  next();
}

module.exports = { auth, invalidateAuthCache };
