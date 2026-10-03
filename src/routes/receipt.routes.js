const router       = require('express').Router();
const c            = require('../controllers/receipt.controller');
const { auth }     = require('../middleware/auth');
const { uploadReceiptImages } = require('../config/s3');
const { receiptRateLimit } = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);

// Fino a 3 foto per scontrino: uno scontrino troppo lungo per uno scatto
// solo può essere diviso in più foto (es. metà superiore + metà inferiore),
// ricomposte in un'unica immagine prima dell'OCR (vedi receipt.controller).
router.post('/scan',   receiptRateLimit, uploadReceiptImages('image', 3), asyncHandler(c.scanReceipt));
router.get('/',        asyncHandler(c.getReceipts));
router.get('/scan-jobs/:jobId', asyncHandler(c.getScanJob));
router.get('/stats',          asyncHandler(c.getReceiptStats));
router.post('/export/excel',  asyncHandler(c.exportReceiptsExcel));
router.get('/:id',            asyncHandler(c.getReceiptById));
router.get('/:id/image',      asyncHandler(c.getReceiptImage));
router.delete('/:id',  asyncHandler(c.deleteReceipt));
router.patch('/:id/address', asyncHandler(c.updateReceiptAddress));

module.exports = router;
