const router = require('express').Router();
const c = require('../controllers/feed.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');

router.use(auth);
router.get('/', c.getFeeds);
router.post('/add', upload.single('image'), c.createFeed);
router.delete('/:id', c.deleteFeed);

module.exports = router;
