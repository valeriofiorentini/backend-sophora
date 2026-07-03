const router = require('express').Router();
const c = require('../controllers/gamification.controller');
const { auth } = require('../middleware/auth');
const { rateLimitMiddleware } = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');
const { validate } = require('../middleware/validate');
const { voucherPurchaseSchema, voucherUseSchema } = require('../validation/schemas');

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
router.post('/vouchers/purchase', purchaseLimit, validate(voucherPurchaseSchema), asyncHandler(c.purchaseVoucher));
router.post('/vouchers/use',     validate(voucherUseSchema), asyncHandler(c.useVoucher));

module.exports = router;
