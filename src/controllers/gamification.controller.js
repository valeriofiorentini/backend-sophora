/**
 * gamification.controller.js — V4
 * Sistema completo: punti con moltiplicatore livello, streak, voucher QR.
 *
 * La logica di dominio (calcolo livelli, transazioni punti, voucher) è in
 * services/gamification.service.js — questo file resta un layer sottile:
 * legge la request, chiama il service, traduce il risultato in risposta HTTP.
 * Gli errori "attesi" (voucher non trovato, punti insufficienti, race
 * condition sul saldo) arrivano dal service come Error con .statusCode e
 * vengono lasciati risalire ad asyncHandler → errorHandler centralizzato.
 */

const { success } = require('../utils/response');
const gamification = require('../services/gamification.service');

// ─── GET /api/gamification/profile ───────────────────────────────────────────
async function getProfile(req, res) {
  return success(res, await gamification.getProfile(req.userId));
}

// ─── GET /api/gamification/points (legacy) ────────────────────────────────────
async function getPoints(req, res) {
  return success(res, await gamification.getPoints(req.userId));
}

// ─── GET /api/gamification/leaderboard ───────────────────────────────────────
async function getLeaderboard(req, res) {
  return success(res, await gamification.getLeaderboard());
}

// ─── GET /api/gamification/vouchers ──────────────────────────────────────────
async function getVouchers(req, res) {
  return success(res, await gamification.getVouchers(req.userId));
}

// ─── GET /api/gamification/vouchers/catalog ───────────────────────────────────
async function getVoucherCatalog(req, res) {
  return success(res, await gamification.getVoucherCatalog(req.userId));
}

// ─── POST /api/gamification/vouchers/purchase ─────────────────────────────────
async function purchaseVoucher(req, res) {
  const result = await gamification.purchaseVoucher(req.userId, req.body.catalogId);
  return success(res, result, 201);
}

// ─── POST /api/gamification/vouchers/use ──────────────────────────────────────
async function useVoucher(req, res) {
  const result = await gamification.useVoucher(req.userId, req.body.code);
  return success(res, result);
}

module.exports = {
  // Riesportata per retrocompatibilità: scannedProduct.controller.js e
  // receipt.controller.js la importavano da qui prima che esistesse un
  // service dedicato — meglio migrarli a importarla da lì direttamente
  // (vedi services/gamification.service.js), questa resta come alias.
  awardPoints: gamification.awardPoints,
  POINTS_MAP: gamification.POINTS_MAP,
  getPoints,
  getLeaderboard,
  getProfile,
  getVouchers,
  getVoucherCatalog,
  purchaseVoucher,
  useVoucher,
};
