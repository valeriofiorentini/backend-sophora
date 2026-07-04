const router = require('express').Router();
const c = require('../controllers/scannedProduct.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { scannedProductSchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.post('/create', validate(scannedProductSchema), asyncHandler(c.create));
router.get('/export/:isEmail?', asyncHandler(c.exportReport));
router.get('/first-activity', asyncHandler(c.getFirstActivityDate));
router.get('/get/:timeStamp', asyncHandler(c.getByTimestamp));
router.delete('/delete/:id', asyncHandler(c.deleteById));

module.exports = router;
