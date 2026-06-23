const router = require('express').Router();
const c = require('../controllers/scannedProduct.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.post('/create', c.create);
router.get('/export/:isEmail?', c.exportReport);
router.get('/get/:timeStamp', c.getByTimestamp);
router.delete('/delete/:id', c.deleteById);

module.exports = router;
