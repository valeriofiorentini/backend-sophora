const router       = require('express').Router();
const c            = require('../controllers/advisor.controller');
const { auth }     = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);

router.get('/basket',       asyncHandler(c.getBasketAdvice));
router.get('/health',       asyncHandler(c.getHealthAdvice));
router.get('/associations', asyncHandler(c.getAssociations));

module.exports = router;
