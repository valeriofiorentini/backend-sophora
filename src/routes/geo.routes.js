const router = require('express').Router();
const c = require('../controllers/geo.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { geoSearchCitySchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/search-city', validate(geoSearchCitySchema, 'query'), asyncHandler(c.searchCity));

module.exports = router;
