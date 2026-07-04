const router = require('express').Router();
const c = require('../controllers/nutrition.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { nutritionProfileSchema, checkCartSchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/barcode/:barcode', asyncHandler(c.getNutritionByBarcode));
router.get('/profile', asyncHandler(c.getNutritionProfile));
router.put('/profile', validate(nutritionProfileSchema), asyncHandler(c.upsertNutritionProfile));
router.post('/check-cart', validate(checkCartSchema), asyncHandler(c.checkCartCompatibility));

module.exports = router;
