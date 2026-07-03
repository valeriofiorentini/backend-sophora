const router = require('express').Router();
const c = require('../controllers/similarity.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { similarityFindSchema, similarityIndexSchema } = require('../validation/schemas');

router.use(auth);
router.post('/find', validate(similarityFindSchema), c.findSimilar);
router.post('/index', validate(similarityIndexSchema), c.indexProduct);
router.post('/seed', c.seedProducts); // admin use

module.exports = router;
