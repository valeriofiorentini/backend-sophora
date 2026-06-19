const router = require('express').Router();
const c = require('../controllers/flyer.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');
const { flyerRateLimit } = require('../middleware/rateLimit');

router.use(auth);
router.post('/scan', flyerRateLimit, upload.single('image'), c.processFlyerAI);  // replaces /api/ocr/flyer
router.get('/search', c.semanticSearch);
router.get('/price-history', c.getPriceHistory);

module.exports = router;
