const router       = require('express').Router();
const c            = require('../controllers/receipt.controller');
const { auth }     = require('../middleware/auth');
const { upload }   = require('../config/s3');
const { receiptRateLimit } = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);

router.post('/scan',   receiptRateLimit, upload.single('image'), asyncHandler(c.scanReceipt));
router.get('/',        asyncHandler(c.getReceipts));
router.get('/stats',   asyncHandler(c.getReceiptStats));
router.get('/:id',     asyncHandler(c.getReceiptById));
router.delete('/:id',  asyncHandler(c.deleteReceipt));

module.exports = router;
