const router = require('express').Router();
const c = require('../controllers/feed.controller');
const { auth } = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { upload } = require('../config/s3');
const { validate } = require('../middleware/validate');
const { feedCreateSchema, feedUpdateSchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/', asyncHandler(c.getFeeds));
// validate DOPO multer: i campi multipart sono in req.body solo a quel punto
router.post('/add', upload.array('images', 5), validate(feedCreateSchema), asyncHandler(c.createFeed));
router.put('/:id', validate(feedUpdateSchema), asyncHandler(c.updateFeed));
router.delete('/:id', asyncHandler(c.deleteFeed));

// Segnalazione contenuti (qualsiasi utente loggato)
router.post('/:id/report', asyncHandler(c.reportFeed));

// Revisione segnalazioni (solo admin)
router.get('/admin/reported', adminOnly, asyncHandler(c.getReportedFeeds));
router.post('/admin/:reportId/resolve', adminOnly, asyncHandler(c.resolveReport));

module.exports = router;
