const router = require('express').Router();
const c = require('../controllers/promo.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.get('/', c.getPromos);
router.get('/today', c.getTodayPromos);
router.delete('/cleanup', c.deletePromo);

module.exports = router;
