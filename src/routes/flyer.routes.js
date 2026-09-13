const router = require('express').Router();
const c = require('../controllers/flyer.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');
const { flyerRateLimit } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const { flyerScanBodySchema, flyerSearchQuerySchema, flyerPriceHistoryQuerySchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
// upload.single prima di validate: multer deve parsare il multipart prima
// che req.body contenga i campi testo (latitude/longitude) da validare.
router.post('/scan', flyerRateLimit, upload.single('image'), validate(flyerScanBodySchema), asyncHandler(c.processFlyerAI));  // replaces /api/ocr/flyer
router.get('/search', validate(flyerSearchQuerySchema, 'query'), asyncHandler(c.semanticSearch));
router.get('/price-history', validate(flyerPriceHistoryQuerySchema, 'query'), asyncHandler(c.getPriceHistory));

module.exports = router;
