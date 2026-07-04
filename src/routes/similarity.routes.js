const router = require('express').Router();
const c = require('../controllers/similarity.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { similarityFindSchema, similarityIndexSchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');
const adminOnly = require('../middleware/adminOnly');

router.use(auth);
router.post('/find', validate(similarityFindSchema), asyncHandler(c.findSimilar));
router.post('/index', validate(similarityIndexSchema), asyncHandler(c.indexProduct));
router.post('/seed', adminOnly, asyncHandler(c.seedProducts)); // solo admin (bulk seed)

module.exports = router;
