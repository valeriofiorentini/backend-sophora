const router = require('express').Router();
const c = require('../controllers/feed.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');

router.use(auth);
router.get('/', c.getFeeds);
router.post('/add', upload.array('images', 5), c.createFeed);
router.put('/:id', c.updateFeed);
router.delete('/:id', c.deleteFeed);

module.exports = router;
