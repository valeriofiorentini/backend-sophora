/**
 * adminOnly — protegge endpoint riservati agli amministratori.
 *
 * Controlla il campo `isAdmin` sul JWT payload O su una API key dedicata.
 * Per attivare: imposta ADMIN_API_KEY nel .env e passala come header
 *   X-Admin-Key: <valore>
 *
 * In alternativa, aggiungi `isAdmin: true` al payload JWT dell'utente admin
 * (richiede migrazione schema + logica signup admin fuori scope).
 */
const { error } = require('../utils/response');

function adminOnly(req, res, next) {
  // Opzione 1: API key statica (per script interni / cron / B2B dashboard)
  const adminKey = req.headers['x-admin-key'];
  if (process.env.ADMIN_API_KEY && adminKey === process.env.ADMIN_API_KEY) {
    return next();
  }

  // Opzione 2: flag isAdmin nel JWT (per future implementazioni)
  if (req.isAdmin === true) {
    return next();
  }

  return error(res, 'Accesso riservato agli amministratori', 403);
}

module.exports = adminOnly;
