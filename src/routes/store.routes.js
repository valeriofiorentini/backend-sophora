const router = require('express').Router();
const c = require('../controllers/store.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/location', asyncHandler(c.getStoresByLocation));
router.get('/nearByStores/:productId', asyncHandler(c.getNearbyStoresForProduct));
router.get('/:storeId', asyncHandler(c.getStoreById));

module.exports = router;
