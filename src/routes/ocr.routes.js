const router = require('express').Router();
const { processFlyer } = require('../controllers/ocr.controller');
const { auth } = require('../middleware/auth');
const { upload } = require('../config/s3');
const { validate } = require('../middleware/validate');
const { ocrFlyerBodySchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.post('/flyer', upload.single('image'), validate(ocrFlyerBodySchema), asyncHandler(processFlyer));

module.exports = router;
