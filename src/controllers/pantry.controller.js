/**
 * pantry.controller.js
 *
 * Scansione dispensa: l'utente fotografa frigo/credenza, GPT-4o Vision
 * riconosce i prodotti e popola automaticamente la dispensa virtuale.
 *
 * Endpoints:
 *  POST /api/pantry/scan        → foto dispensa → lista prodotti riconosciuti
 *  GET  /api/pantry             → dispensa corrente
 *  POST /api/pantry/items       → aggiungi item manuale
 *  PUT  /api/pantry/:id         → aggiorna item (quantità, scadenza…)
 *  DELETE /api/pantry/:id       → rimuovi item
 *  DELETE /api/pantry           → svuota dispensa
 *  POST /api/pantry/recipes     → suggerisci ricette da quello che c'è
 *  POST /api/pantry/shopping    → genera lista spesa per quello che manca
 */

'use strict';

const OpenAI  = require('openai');
const prisma  = require('../config/database');
const { uploadToS3 } = require('../config/s3');
const { success, error } = require('../utils/response');
const { normalizeName, findSimilarKey } = require('../services/pantrySync.service');
const { PANTRY_SCAN_PROMPT, buildRecipesPrompt, buildShoppingPrompt } = require('../prompts/pantry.prompts');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});

// Su OpenRouter i modelli OpenAI richiedono il prefisso 'openai/'
const OR = !!process.env.OPENROUTER_API_KEY;
const MODEL_VISION = OR ? 'openai/gpt-4o'      : 'gpt-4o';
const MODEL_FAST   = OR ? 'openai/gpt-4o-mini' : 'gpt-4o-mini';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// PANTRY_SCAN_PROMPT e i builder ricette/spesa sono in prompts/pantry.prompts.

// ─── POST /api/pantry/scan ────────────────────────────────────────────────────
async function scanPantry(req, res) {
  if (!req.file) return error(res, 'Immagine dispensa obbligatoria');
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return error(res, `Formato non supportato: ${req.file.mimetype}. Usa JPEG o PNG.`);
  }

  // 1. Upload S3 (opzionale — per storico scansioni)
  let imageUrl;
  try {
    imageUrl = await uploadToS3(req.file, 'pantry-scans');
  } catch {
    // Se S3 non è configurato, usiamo base64 direttamente per il Vision call
    imageUrl = null;
  }

  // 2. Chiama GPT-4o Vision
  let parsed;
  try {
    const imageContent = imageUrl
      ? { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } }
      : {
          type: 'image_url',
          image_url: {
            url: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`,
            detail: 'high',
          },
        };

    const response = await openai.chat.completions.create({
      model: MODEL_VISION,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: PANTRY_SCAN_PROMPT }, imageContent],
      }],
      response_format: { type: 'json_object' },
      max_tokens: 3000,
      store: false,
    });

    parsed = JSON.parse(response.choices[0].message.content);
  } catch (ocrErr) {
    console.error('[pantry] scan error:', ocrErr.message);
    return error(res, 'Errore durante il riconoscimento prodotti', 500);
  }

  const scannedItems = Array.isArray(parsed.items) ? parsed.items : [];
  if (scannedItems.length === 0) {
    return success(res, { items: [], summary: parsed.summary || 'Nessun prodotto identificato', added: 0 });
  }

  // 3. Salva i prodotti riconosciuti nella dispensa.
  //    Prima: 2 query per prodotto in loop, senza transazione → su errore a metà
  //    la dispensa restava parziale. Ora: 1 lettura + tutte le scritture in
  //    un'unica $transaction (atomico) — o entra tutto o niente.
  const now = new Date();
  let addedCount = 0;

  const validItems = scannedItems.filter(i => i.name?.trim());
  const existing = await prisma.pantryItem.findMany({
    where:  { userId: req.userId },
    select: { id: true, name: true, quantity: true, expiresAt: true, notes: true },
  });
  const existingByKey = new Map(existing.map(e => [e.name.trim().toLowerCase(), e]));

  const ops = [];
  for (const item of validItems) {
    const match = existingByKey.get(item.name.trim().toLowerCase());
    if (match) {
      ops.push(prisma.pantryItem.update({
        where: { id: match.id },
        data: {
          quantity:  match.quantity + (parseFloat(item.quantity) || 1),
          expiresAt: item.expiresAt ? new Date(item.expiresAt) : match.expiresAt,
          notes:     item.notes ?? match.notes,
          updatedAt: now,
        },
      }));
    } else {
      ops.push(prisma.pantryItem.create({
        data: {
          userId:    req.userId,
          name:      item.name.trim(),
          category:  item.category ?? 'altro',
          quantity:  parseFloat(item.quantity) || 1,
          unit:      item.unit ?? 'pz',
          expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
          notes:     item.notes ?? null,
        },
      }));
      addedCount++;
    }
  }
  if (ops.length > 0) await prisma.$transaction(ops);

  // 4. Leggi dispensa aggiornata
  const pantry = await prisma.pantryItem.findMany({
    where:   { userId: req.userId },
    orderBy: { category: 'asc' },
  });

  return success(res, {
    items:      scannedItems,
    summary:    parsed.summary || '',
    added:      addedCount,
    pantryTotal: pantry.length,
    pantry,
  }, 200);
}

// ─── GET /api/pantry ──────────────────────────────────────────────────────────
async function getPantry(req, res) {
  const items = await prisma.pantryItem.findMany({
    where:   { userId: req.userId },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  });

  // Raggruppa per categoria per comodità del frontend
  const grouped = {};
  for (const item of items) {
    const cat = item.category || 'altro';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }

  // Avvisi scadenza (prossimi 3 giorni)
  const soon = new Date();
  soon.setDate(soon.getDate() + 3);
  const expiringSoon = items.filter(i => i.expiresAt && i.expiresAt <= soon && i.expiresAt >= new Date());

  return success(res, { items, grouped, expiringSoon, total: items.length });
}

// ─── POST /api/pantry/items ───────────────────────────────────────────────────
async function addItem(req, res) {
  const { name, category, quantity, unit, expiresAt, notes, barcode } = req.body;

  if (!name?.trim()) return error(res, 'Nome prodotto obbligatorio');

  const cleanName = String(name).trim().slice(0, 100);
  const qty       = parseFloat(quantity) || 1;

  // upsert sul vincolo unique (userId, name): se il prodotto esiste già
  // somma la quantità e lo rimette in stock, invece di fallire o duplicare.
  const item = await prisma.pantryItem.upsert({
    where:  { userId_name: { userId: req.userId, name: cleanName } },
    update: { quantity: { increment: qty }, inStock: true },
    create: {
      userId:    req.userId,
      name:      cleanName,
      category:  category ?? 'altro',
      quantity:  qty,
      unit:      unit ?? 'pz',
      barcode:   barcode ?? null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      notes:     notes ? String(notes).slice(0, 200) : null,
      inStock:   true,
      source:    'manual',
    },
  });

  return success(res, { item }, 201);
}

// ─── PUT /api/pantry/:id ──────────────────────────────────────────────────────
async function updateItem(req, res) {
  const { id } = req.params;
  const { name, category, quantity, unit, expiresAt, notes, inStock } = req.body;

  const existing = await prisma.pantryItem.findFirst({
    where: { id, userId: req.userId },
  });
  if (!existing) return error(res, 'Prodotto non trovato', 404);

  const updated = await prisma.pantryItem.update({
    where: { id },
    data: {
      ...(name     !== undefined && { name:      String(name).trim().slice(0, 100) }),
      ...(category !== undefined && { category }),
      ...(quantity !== undefined && { quantity:  parseFloat(quantity) || existing.quantity }),
      ...(unit     !== undefined && { unit }),
      ...(expiresAt !== undefined && { expiresAt: expiresAt ? new Date(expiresAt) : null }),
      ...(notes    !== undefined && { notes:     notes ? String(notes).slice(0, 200) : null }),
      ...(inStock  !== undefined && { inStock:   Boolean(inStock) }),
    },
  });

  return success(res, { item: updated });
}

// ─── DELETE /api/pantry/:id ───────────────────────────────────────────────────
async function deleteItem(req, res) {
  const { id } = req.params;

  const existing = await prisma.pantryItem.findFirst({
    where: { id, userId: req.userId },
  });
  if (!existing) return error(res, 'Prodotto non trovato', 404);

  await prisma.pantryItem.delete({ where: { id } });
  return success(res, { message: 'Prodotto rimosso' });
}

// ─── POST /api/pantry/bulk-delete ─────────────────────────────────────────────
// Elimina più prodotti in un colpo solo (selezione multipla / per categoria /
// tutti) — con decine di prodotti in dispensa, eliminarli uno alla volta non
// è praticabile.
async function bulkDeleteItems(req, res) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return error(res, 'Nessun prodotto selezionato', 400);
  }
  const { count } = await prisma.pantryItem.deleteMany({
    where: { id: { in: ids }, userId: req.userId },
  });
  return success(res, { message: `${count} prodotti rimossi`, count });
}

// ─── DELETE /api/pantry ───────────────────────────────────────────────────────
async function clearPantry(req, res) {
  const { count } = await prisma.pantryItem.deleteMany({ where: { userId: req.userId } });
  return success(res, { message: `Dispensa svuotata (${count} prodotti rimossi)` });
}

// ─── POST /api/pantry/dedupe ──────────────────────────────────────────────────
// Pulizia una tantum dei duplicati già esistenti in dispensa (creati prima
// che populatePantryFromReceipt normalizzasse i nomi) — stessa logica di
// dedup usata per le nuove scansioni, applicata retroattivamente: raggruppa
// per nome normalizzato/simile, somma le quantità, tiene il più vecchio.
async function dedupePantry(req, res) {
  const items = await prisma.pantryItem.findMany({
    where: { userId: req.userId },
    orderBy: { addedAt: 'asc' }, // PantryItem non ha createdAt, ha addedAt/updatedAt
  });

  const groups = new Map(); // normalizedKey -> [items in ordine di creazione]
  for (const item of items) {
    let key = normalizeName(item.name || '');
    const similar = findSimilarKey(key, groups.keys());
    if (similar) key = similar;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const ops = [];
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const [keep, ...dupes] = group;
    const totalQuantity = group.reduce((sum, it) => sum + (it.quantity || 0), 0);
    ops.push(prisma.pantryItem.update({
      where: { id: keep.id },
      data:  { quantity: totalQuantity },
    }));
    ops.push(prisma.pantryItem.deleteMany({
      where: { id: { in: dupes.map(d => d.id) } },
    }));
    merged += dupes.length;
  }

  if (ops.length > 0) await prisma.$transaction(ops);
  return success(res, { message: `${merged} duplicati uniti`, merged });
}

// ─── POST /api/pantry/recipes ─────────────────────────────────────────────────
async function suggestRecipes(req, res) {
  const { people = 2, mealType = 'pranzo o cena', dietNotes = '' } = req.body;
  // customIngredients: selezione esplicita dell'utente (checkbox su prodotti
  // in dispensa + testo libero per ingredienti non presenti) — se assente,
  // comportamento invariato: usa tutta la dispensa.
  const customIngredients = Array.isArray(req.body.customIngredients)
    ? req.body.customIngredients.filter(s => typeof s === 'string' && s.trim()).slice(0, 60)
    : null;

  let pantryList;
  if (customIngredients && customIngredients.length > 0) {
    pantryList = customIngredients.map(name => `- ${name.trim()}`).join('\n');
  } else {
    const items = await prisma.pantryItem.findMany({
      where:   { userId: req.userId },
      orderBy: { expiresAt: 'asc' }, // prima le cose in scadenza
    });

    if (items.length === 0) {
      return error(res, 'La dispensa è vuota. Aggiungi prodotti prima di chiedere ricette.');
    }

    // Costruisci lista dispensa per il prompt
    pantryList = items
      .map(i => `- ${i.name} (${i.quantity} ${i.unit ?? 'pz'}${i.expiresAt ? `, scade ${i.expiresAt.toLocaleDateString('it-IT')}` : ''})`)
      .join('\n');
  }

  // Leggi profilo nutrizionale e lingua utente
  const [nutritionProfile, userLang] = await Promise.all([
    prisma.nutritionProfile.findUnique({ where: { userId: req.userId } }).catch(() => null),
    prisma.user.findUnique({ where: { id: req.userId }, select: { language: true } }).catch(() => null),
  ]);

  const dietContext = [
    nutritionProfile?.dietType?.length ? `Dieta: ${nutritionProfile.dietType.join(', ')}` : '',
    nutritionProfile?.allergens?.length ? `Allergie: ${nutritionProfile.allergens.join(', ')}` : '',
    dietNotes ? `Note extra: ${dietNotes}` : '',
  ].filter(Boolean).join(' | ');

  const prompt = buildRecipesPrompt({
    pantryList, people, mealType, dietContext, langCode: userLang?.language,
  });

  try {
    const response = await openai.chat.completions.create({
      model: MODEL_FAST,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 2500,
      store: false,
    });

    const result = JSON.parse(response.choices[0].message.content);
    return success(res, {
      recipes:     result.recipes ?? [],
      pantryCount: customIngredients ? customIngredients.length : pantryList.split('\n').length,
    });
  } catch (err) {
    console.error('[pantry] recipes error:', err.message);
    return error(res, 'Errore generazione ricette', 500);
  }
}

// ─── POST /api/pantry/shopping ────────────────────────────────────────────────
// Genera lista spesa per quello che manca rispetto a un pasto o obiettivo
async function generateShoppingList(req, res) {
  const { goal = 'spesa settimanale bilanciata per 2 persone con budget 60€' } = req.body;

  const items = await prisma.pantryItem.findMany({ where: { userId: req.userId } });
  const [nutritionProfile, userLang] = await Promise.all([
    prisma.nutritionProfile.findUnique({ where: { userId: req.userId } }).catch(() => null),
    prisma.user.findUnique({ where: { id: req.userId }, select: { language: true } }).catch(() => null),
  ]);

  const pantryList = items.length > 0
    ? items.map(i => `${i.name} (${i.quantity} ${i.unit ?? 'pz'})`).join(', ')
    : 'dispensa vuota';

  const dietContext = nutritionProfile?.dietType?.length
    ? `Dieta: ${nutritionProfile.dietType.join(', ')}. Allergie: ${nutritionProfile.allergens?.join(', ') || 'nessuna'}.`
    : '';

  const prompt = buildShoppingPrompt({
    goal, pantryList, dietContext, langCode: userLang?.language,
  });

  try {
    const response = await openai.chat.completions.create({
      model: MODEL_FAST,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      store: false,
    });

    const result = JSON.parse(response.choices[0].message.content);
    return success(res, result);
  } catch (err) {
    console.error('[pantry] shopping list error:', err.message);
    return error(res, 'Errore generazione lista spesa', 500);
  }
}

module.exports = {
  scanPantry,
  getPantry,
  addItem,
  updateItem,
  deleteItem,
  bulkDeleteItems,
  clearPantry,
  dedupePantry,
  suggestRecipes,
  generateShoppingList,
};
