/**
 * finetuning.routes.js
 *
 * Sicurezza:
 *  - /correct e /stats: tutti gli utenti autenticati possono inviare correzioni
 *    ai propri scontrini e vedere le statistiche aggregate (nessun dato personale)
 *  - /export e /trigger: SOLO ADMIN — esportano dati di tutti gli utenti
 *    e avviano job OpenAI costosi (€50-100 a run)
 *  - /jobs/:jobId: SOLO ADMIN
 */

const router       = require('express').Router();
const { auth }     = require('../middleware/auth');
const adminOnly    = require('../middleware/adminOnly');
const asyncHandler = require('../middleware/asyncHandler');
const c            = require('../controllers/finetuning.controller');

router.use(auth);

// Utenti autenticati: invio correzioni e statistiche pubbliche
router.post('/correct', asyncHandler(c.submitCorrection));
router.get('/stats',    asyncHandler(c.getStats));

// Solo admin: operazioni costose / accesso dati aggregati
router.post('/export',          adminOnly, asyncHandler(c.exportDataset));
router.post('/trigger',         adminOnly, asyncHandler(c.triggerFineTuning));
router.get('/jobs/:jobId',      adminOnly, asyncHandler(c.getJobStatus));

module.exports = router;
