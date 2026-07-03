const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { routeOptimizeSchema } = require('../validation/schemas');
const { optimizeShoppingRoute } = require('../controllers/routing.controller');

router.use(auth);
router.post('/optimize', validate(routeOptimizeSchema), optimizeShoppingRoute);

module.exports = router;
