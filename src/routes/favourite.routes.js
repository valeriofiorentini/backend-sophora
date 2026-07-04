const router = require('express').Router();
const c = require('../controllers/favourite.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { validate } = require('../middleware/validate');
const { favouriteSchema } = require('../validation/schemas');

router.use(auth);
router.get('/', asyncHandler(c.getFavourites));
router.post('/add', validate(favouriteSchema), asyncHandler(c.addFavourite));
router.delete('/delete-all', asyncHandler(c.removeAllFavourites));
router.delete('/delete/:storeId', asyncHandler(c.removeFavourite));

module.exports = router;
