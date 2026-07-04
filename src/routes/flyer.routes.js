const router = require('express').Router();
const c = require('../controllers/flyer.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');
const { flyerRateLimit } = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.post('/scan', flyerRateLimit, upload.single('image'), asyncHandler(c.processFlyerAI));  // replaces /api/ocr/flyer
router.get('/search', asyncHandler(c.semanticSearch));
router.get('/price-history', asyncHandler(c.getPriceHistory));

module.exports = router;
