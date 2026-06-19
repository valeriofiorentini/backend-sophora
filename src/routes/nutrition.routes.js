const router = require('express').Router();
const c = require('../controllers/nutrition.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.get('/barcode/:barcode', c.getNutritionByBarcode);
router.get('/profile', c.getNutritionProfile);
router.put('/profile', c.upsertNutritionProfile);
router.post('/check-cart', c.checkCartCompatibility);

module.exports = router;
