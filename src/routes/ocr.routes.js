const router = require('express').Router();
const { processFlyer } = require('../controllers/ocr.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.post('/flyer', upload.single('image'), asyncHandler(processFlyer));

module.exports = router;
