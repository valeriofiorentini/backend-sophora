const router = require('express').Router();
const c = require('../controllers/favourite.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { favouriteSchema } = require('../validation/schemas');

router.use(auth);
router.get('/', c.getFavourites);
router.post('/add', validate(favouriteSchema), c.addFavourite);
router.delete('/delete/:storeId', c.removeFavourite);

module.exports = router;
