const router       = require('express').Router();
const c            = require('../controllers/shoppingList.controller');
const { auth }     = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { validate } = require('../middleware/validate');
const { estimateListSchema } = require('../validation/schemas');

router.use(auth);
router.get('/smart',      asyncHandler(c.getSmartList));
router.post('/estimate',  validate(estimateListSchema), asyncHandler(c.estimateList));

module.exports = router;
