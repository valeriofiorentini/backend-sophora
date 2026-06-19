const router = require('express').Router();
const c = require('../controllers/similarity.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.post('/find', c.findSimilar);
router.post('/index', c.indexProduct);
router.post('/seed', c.seedProducts); // admin use

module.exports = router;
