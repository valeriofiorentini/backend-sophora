const router = require('express').Router();
const { processFlyer } = require('../controllers/ocr.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');

router.use(auth);
router.post('/flyer', upload.single('image'), processFlyer);

module.exports = router;
