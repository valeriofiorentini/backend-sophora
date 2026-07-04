/**
 * adminOnly — protegge endpoint riservati agli amministratori.
 * DEVE stare DOPO il middleware `auth` (che imposta req.isAdmin dal DB).
 *
 * Due modi di autorizzazione:
 *  1. Utente con User.isAdmin = true (letto dal DB dall'auth middleware,
 *     cache 60s) → req.isAdmin. Per promuovere un utente:
 *       UPDATE "User" SET "isAdmin" = true WHERE email = '...';
 *  2. API key statica ADMIN_API_KEY (per script/cron/dashboard B2B senza
 *     login utente), passata come header X-Admin-Key.
 */
const { error } = require('../utils/response');

function adminOnly(req, res, next) {
  // Opzione 1: utente admin (flag isAdmin dal DB, via auth middleware)
  if (req.isAdmin === true) {
    return next();
  }

  // Opzione 2: API key statica (per script interni / cron / B2B dashboard)
  const adminKey = req.headers['x-admin-key'];
  if (process.env.ADMIN_API_KEY && adminKey === process.env.ADMIN_API_KEY) {
    return next();
  }

  return error(res, 'Accesso riservato agli amministratori', 403);
}

module.exports = adminOnly;
