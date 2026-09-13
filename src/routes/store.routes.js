const router = require('express').Router();
const c = require('../controllers/store.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { storeLocationQuerySchema, nearbyStoresQuerySchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/location', validate(storeLocationQuerySchema, 'query'), asyncHandler(c.getStoresByLocation));
router.get('/nearByStores/:productId', validate(nearbyStoresQuerySchema, 'query'), asyncHandler(c.getNearbyStoresForProduct));
router.get('/:storeId', asyncHandler(c.getStoreById));

module.exports = router;
