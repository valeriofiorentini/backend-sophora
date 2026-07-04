const router = require('express').Router();
const c = require('../controllers/notification.controller');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/', asyncHandler(c.getNotifications));
router.patch('/read-all', asyncHandler(c.markAsRead));

module.exports = router;
