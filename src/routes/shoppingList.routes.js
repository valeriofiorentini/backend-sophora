const router       = require('express').Router();
const c            = require('../controllers/shoppingList.controller');
const { auth }     = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/smart',      asyncHandler(c.getSmartList));
router.post('/estimate',  asyncHandler(c.estimateList));

module.exports = router;
