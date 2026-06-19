const router = require('express').Router();
const { auth } = require('../middleware/auth');
const { getPriceForecast, getCompetitorAnalysis } = require('../controllers/forecast.controller');

router.use(auth);
router.get('/price', getPriceForecast);
router.get('/competitor', getCompetitorAnalysis);

module.exports = router;
