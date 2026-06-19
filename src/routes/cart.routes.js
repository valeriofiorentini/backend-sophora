const router = require('express').Router();
const c = require('../controllers/cart.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.get('/', c.getCart);
router.post('/add', c.addToCart);
router.put('/update', c.updateCartItem);
router.delete('/clear', c.clearCart);
router.delete('/remove/:productId', c.removeFromCart);

module.exports = router;
