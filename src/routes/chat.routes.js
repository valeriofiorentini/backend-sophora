const router = require('express').Router();
const c = require('../controllers/chat.controller');
const { auth } = require('../middleware/auth');
const { chatRateLimit } = require('../middleware/rateLimit');

router.use(auth);
router.post('/sessions', c.createSession);
router.get('/sessions', c.getSessions);
router.get('/sessions/:sessionId/messages', c.getMessages);
router.post('/sessions/:sessionId/message', chatRateLimit, c.sendMessage);
router.post('/message', chatRateLimit, c.sendMessage); // crea sessione automaticamente
router.delete('/sessions/:sessionId', c.deleteSession);

module.exports = router;
