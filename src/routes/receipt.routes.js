const router       = require('express').Router();
const c            = require('../controllers/receipt.controller');
const { auth }     = require('../middleware/auth');
const { uploadReceiptImage } = require('../config/s3');
const { receiptRateLimit } = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);

router.post('/scan',   receiptRateLimit, uploadReceiptImage('image'), asyncHandler(c.scanReceipt));
router.get('/',        asyncHandler(c.getReceipts));
router.get('/stats',          asyncHandler(c.getReceiptStats));
router.post('/export/excel',  asyncHandler(c.exportReceiptsExcel));
router.get('/:id',            asyncHandler(c.getReceiptById));
router.delete('/:id',  asyncHandler(c.deleteReceipt));

module.exports = router;
