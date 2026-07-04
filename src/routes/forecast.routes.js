const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { getPriceForecast, getCompetitorAnalysis } = require('../controllers/forecast.controller');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/price', asyncHandler(getPriceForecast));
router.get('/competitor', asyncHandler(getCompetitorAnalysis));

module.exports = router;
