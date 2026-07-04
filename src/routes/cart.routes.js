const router = require('express').Router();
const c = require('../controllers/cart.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/', asyncHandler(c.getCart));
router.post('/add', asyncHandler(c.addToCart));
router.put('/update', asyncHandler(c.updateCartItem));
router.delete('/clear', asyncHandler(c.clearCart));
router.delete('/remove/:productId', asyncHandler(c.removeFromCart));

module.exports = router;
