const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { optimizeShoppingRoute } = require('../controllers/routing.controller');

router.use(auth);
router.post('/optimize', optimizeShoppingRoute);

module.exports = router;
