const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { forecastPriceQuerySchema, forecastCompetitorQuerySchema } = require('../validation/schemas');
const { getPriceForecast, getCompetitorAnalysis } = require('../controllers/forecast.controller');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/price', validate(forecastPriceQuerySchema, 'query'), asyncHandler(getPriceForecast));
router.get('/competitor', validate(forecastCompetitorQuerySchema, 'query'), asyncHandler(getCompetitorAnalysis));

module.exports = router;
