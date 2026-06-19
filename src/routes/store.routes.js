const router = require('express').Router();
const c = require('../controllers/store.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.get('/location', c.getStoresByLocation);
router.get('/nearByStores/:productId', c.getNearbyStoresForProduct);
router.get('/:storeId', c.getStoreById);

module.exports = router;
