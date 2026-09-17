'use strict';

const express = require('express');
const router  = express.Router();
const c       = require('../controllers/iap.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// Chiamato da Apple sui rinnovi/cancellazioni — nessuna autenticazione utente
router.post('/apple-notifications', asyncHandler(c.handleAppleNotification));

// Chiamato dall'app dopo un acquisto riuscito — richiede utente loggato
router.post('/verify-receipt', auth, asyncHandler(c.verifyReceipt));

module.exports = router;
