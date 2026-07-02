const router = require('express').Router();
const c = require('../controllers/group.controller');
const { auth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { groupCreateSchema, groupJoinSchema } = require('../validation/schemas');

router.use(auth);
router.get('/', c.getGroups);
router.post('/create', validate(groupCreateSchema), c.createGroup);
router.post('/join', validate(groupJoinSchema), c.joinGroup);

// Lista della spesa condivisa
router.get('/:groupId/list', c.getList);
router.post('/:groupId/list', c.addListItem);
router.post('/:groupId/list/bulk', c.addListItemsBulk);
router.put('/:groupId/list/:itemId', c.updateListItem);
router.delete('/:groupId/list/:itemId', c.deleteListItem);

router.get('/:groupId', c.getGroupById);
router.delete('/:groupId', c.deleteGroup);

module.exports = router;
