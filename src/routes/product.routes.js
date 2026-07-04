const router = require('express').Router();
const c = require('../controllers/product.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/store/:storeId', asyncHandler(c.getProductsByStore));
router.get('/barcode/:barcode', asyncHandler(c.getProductByBarcode));
router.get('/:productId', asyncHandler(c.getProductById));

module.exports = router;
