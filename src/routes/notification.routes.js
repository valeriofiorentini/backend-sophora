const router = require('express').Router();
const c = require('../controllers/notification.controller');
const { auth } = require('../middleware/auth');

router.use(auth);
router.get('/', c.getNotifications);
router.patch('/read-all', c.markAsRead);

module.exports = router;
