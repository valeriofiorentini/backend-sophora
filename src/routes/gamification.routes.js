const router = require('express').Router();
const c = require('../controllers/gamification.controller');
const { auth } = require('../middleware/auth');
const { rateLimitMiddleware } = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);

// Rate limit specifico per acquisto voucher — max 5 acquisti/min per prevenire abuse
const purchaseLimit = rateLimitMiddleware(5, 60, 'voucher_purchase');

// Profilo + storia punti
router.get('/profile',           asyncHandler(c.getProfile));

// Legacy
router.get('/points',            asyncHandler(c.getPoints));
router.get('/leaderboard',       asyncHandler(c.getLeaderboard));

// Voucher
router.get('/vouchers',          asyncHandler(c.getVouchers));
router.get('/vouchers/catalog',  asyncHandler(c.getVoucherCatalog));
router.post('/vouchers/purchase', purchaseLimit, asyncHandler(c.purchaseVoucher));
router.post('/vouchers/use',     asyncHandler(c.useVoucher));

module.exports = router;
