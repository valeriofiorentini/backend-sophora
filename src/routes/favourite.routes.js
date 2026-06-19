const router = require('express').Router();
const c = require('../controllers/favourite.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.get('/', c.getFavourites);
router.post('/add', c.addFavourite);
router.delete('/delete/:storeId', c.removeFavourite);

module.exports = router;
