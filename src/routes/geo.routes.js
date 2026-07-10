const router = require('express').Router();
const c = require('../controllers/geo.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/search-city', asyncHandler(c.searchCity));

module.exports = router;
