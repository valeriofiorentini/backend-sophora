'use strict';

const express = require('express');
const router  = express.Router();
const c       = require('../controllers/stripe.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// Webhook — DEVE essere prima di auth e del body parser JSON
// (Stripe manda il body raw, non JSON)
router.post('/webhook', asyncHandler(c.handleWebhook));

// Tutti gli altri endpoint richiedono autenticazione
router.use(auth);
router.get('/checkout-url', asyncHandler(c.getCheckoutUrl));    // URL Payment Link
router.get('/status',       asyncHandler(c.getSubscriptionStatus));
router.post('/cancel',      asyncHandler(c.cancelSubscription));

module.exports = router;
