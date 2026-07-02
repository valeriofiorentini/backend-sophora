const router = require('express').Router();
const c = require('../controllers/feed.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');
const { validate } = require('../middleware/validate');
const { feedCreateSchema, feedUpdateSchema } = require('../validation/schemas');

router.use(auth);
router.get('/', c.getFeeds);
// validate DOPO multer: i campi multipart sono in req.body solo a quel punto
router.post('/add', upload.array('images', 5), validate(feedCreateSchema), c.createFeed);
router.put('/:id', validate(feedUpdateSchema), c.updateFeed);
router.delete('/:id', c.deleteFeed);

module.exports = router;
