const router = require('express').Router();
const c = require('../controllers/group.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { groupCreateSchema, groupJoinSchema } = require('../validation/schemas');
const asyncHandler = require('../middleware/asyncHandler');

router.use(auth);
router.get('/', asyncHandler(c.getGroups));
router.post('/create', validate(groupCreateSchema), asyncHandler(c.createGroup));
router.post('/join', validate(groupJoinSchema), asyncHandler(c.joinGroup));

// Lista della spesa condivisa
router.get('/:groupId/list', asyncHandler(c.getList));
router.post('/:groupId/list', asyncHandler(c.addListItem));
router.post('/:groupId/list/bulk', asyncHandler(c.addListItemsBulk));
router.put('/:groupId/list/:itemId', asyncHandler(c.updateListItem));
router.delete('/:groupId/list/:itemId', asyncHandler(c.deleteListItem));

router.get('/:groupId', asyncHandler(c.getGroupById));
router.delete('/:groupId', asyncHandler(c.deleteGroup));

module.exports = router;
