const router = require('express').Router();
const c = require('../controllers/product.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.get('/store/:storeId', c.getProductsByStore);
router.get('/barcode/:barcode', c.getProductByBarcode);
router.get('/:productId', c.getProductById);

module.exports = router;
