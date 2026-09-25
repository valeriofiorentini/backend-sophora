'use strict';

/**
 * platform.js
 *
 * L'app manda su ogni richiesta l'header `X-Platform` ("ios", "android", ...).
 *
 * App Store guideline 3.1.1: su iOS non si possono sbloccare contenuti o
 * funzioni a pagamento acquistati fuori dall'app se non sono acquistabili
 * anche con l'acquisto in-app. Finche' su iOS non c'e' l'IAP, una richiesta
 * che arriva da iOS va trattata come Free anche se l'utente ha un abbonamento
 * Stripe (comprato su Android/web). Il dato nel DB non si tocca.
 */

function getPlatform(req) {
  const p = String(req?.headers?.['x-platform'] ?? '').trim().toLowerCase();
  return p || null;
}

function isIosRequest(req) {
  return getPlatform(req) === 'ios';
}

module.exports = { getPlatform, isIosRequest };
