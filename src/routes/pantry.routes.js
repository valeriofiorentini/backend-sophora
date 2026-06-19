'use strict';

const express    = require('express');
const multer     = require('multer');
const router     = express.Router();
const c          = require('../controllers/pantry.controller');
const { auth }   = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// Multer — immagini dispensa (max 10 MB, solo immagini)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo immagini supportate'));
  },
});

// Tutte le route richiedono autenticazione
router.use(auth);

// Scansione foto dispensa
router.post('/scan',     upload.single('image'), asyncHandler(c.scanPantry));

// CRUD dispensa
router.get('/',          asyncHandler(c.getPantry));
router.post('/items',    asyncHandler(c.addItem));
router.put('/:id',       asyncHandler(c.updateItem));
router.delete('/clear',  asyncHandler(c.clearPantry));   // prima di /:id
router.delete('/:id',    asyncHandler(c.deleteItem));

// AI
router.post('/recipes',  asyncHandler(c.suggestRecipes));
router.post('/shopping', asyncHandler(c.generateShoppingList));

module.exports = router;
