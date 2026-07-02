const router = require('express').Router();
const c = require('../controllers/nutrition.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { nutritionProfileSchema, checkCartSchema } = require('../validation/schemas');

router.use(auth);
router.get('/barcode/:barcode', c.getNutritionByBarcode);
router.get('/profile', c.getNutritionProfile);
router.put('/profile', validate(nutritionProfileSchema), c.upsertNutritionProfile);
router.post('/check-cart', validate(checkCartSchema), c.checkCartCompatibility);

module.exports = router;
