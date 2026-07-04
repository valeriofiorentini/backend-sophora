const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { routeOptimizeSchema } = require('../validation/schemas');
const { optimizeShoppingRoute } = require('../controllers/routing.controller');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.post('/optimize', validate(routeOptimizeSchema), asyncHandler(optimizeShoppingRoute));

module.exports = router;
