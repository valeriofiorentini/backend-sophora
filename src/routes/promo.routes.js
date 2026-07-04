const router = require('express').Router();
const c = require('../controllers/promo.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/', asyncHandler(c.getPromos));
router.get('/today', asyncHandler(c.getTodayPromos));
router.delete('/cleanup', asyncHandler(c.deletePromo));

module.exports = router;
