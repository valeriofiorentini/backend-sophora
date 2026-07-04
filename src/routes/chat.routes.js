const router = require('express').Router();
const c = require('../controllers/chat.controller');
const { auth } = require('../middleware/auth');
const { chatRateLimit } = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.post('/sessions', asyncHandler(c.createSession));
router.get('/sessions', asyncHandler(c.getSessions));
router.get('/sessions/:sessionId/messages', asyncHandler(c.getMessages));
router.post('/sessions/:sessionId/message', chatRateLimit, asyncHandler(c.sendMessage));
router.post('/message', chatRateLimit, asyncHandler(c.sendMessage));
router.post('/message-sync', chatRateLimit, asyncHandler(c.sendMessageSync));
router.delete('/sessions/:sessionId', asyncHandler(c.deleteSession));

module.exports = router;
