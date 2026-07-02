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

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});

// Su OpenRouter i modelli OpenAI richiedono il prefisso 'openai/'
const OR = !!process.env.OPENROUTER_API_KEY;
const MODEL_VISION = OR ? 'openai/gpt-4o'      : 'gpt-4o';
const MODEL_FAST   = OR ? 'openai/gpt-4o-mini' : 'gpt-4o-mini';

// Lingua di output AI: segue User.language
const LANG_NAMES = {
  it: 'italiano',
  en: 'inglese (English)',
  fr: 'francese (français)',
  es: 'spagnolo (español)',
  de: 'tedesco (Deutsch)',
};
function langInstruction(code) {
  const name = LANG_NAMES[code] ?? LANG_NAMES.it;
  return `Scrivi nomi, istruzioni e consigli SEMPRE in ${name}.`;
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// ─── Prompt scansione dispensa ────────────────────────────────────────────────
const PANTRY_SCAN_PROMPT = `Sei un esperto di alimentazione italiana. Analizza l'immagine (frigo, credenza o dispensa) e restituisci SOLO un JSON valido.

Identifica TUTTI i prodotti alimentari visibili, anche parzialmente.

Per ogni prodotto stima:
- nome in italiano chiaro e completo (es. "Latte intero", "Mozzarella fiordilatte", "Pasta penne rigate")
- categoria tra le seguenti (scegli quella più adatta):
  • latticini → latte, yogurt, formaggio, mozzarella, burro, panna, ricotta, uova
  • verdure → ortaggi freschi o in busta, insalata, pomodori, zucchine, carote
  • frutta → frutta fresca o in busta
  • carne → carne fresca, salumi, prosciutto, wurstel, mortadella, pollo crudo
  • pesce → pesce fresco, tonno in scatola, salmone, acciughe, merluzzo
  • pasta → pasta secca, pasta fresca, riso, gnocchi, cous cous, cereali da cucina
  • pane → pane, panini, grissini, crackers, fette biscottate, piadine, focaccia
  • condimenti → olio, aceto, sale, zucchero, salse, ketchup, maionese, pesto, sughi, spezie
  • scatolame → conserve, legumi in scatola, pelati, passata, tonno in scatola, cibo in lattina
  • bevande → acqua, succhi, bibite, birra, vino, caffè, tè, latte UHT
  • dolci → biscotti, merendine, cioccolato, caramelle, gelato, torte, crostate, snack dolci
  • surgelati → qualsiasi prodotto congelato: pizza surgelata, pizza farcita, supplì, arancini, crocchette, cotolette, sofficini, verdure surgelate, minestre surgelate, piatti pronti surgelati, gelati, ghiaccioli
  • altro → solo se non rientra in nessuna delle categorie sopra
- quantità approssimativa visibile (numero)
- unità di misura: kg | g | l | ml | pz | conf
- scadenza se leggibile sulle confezioni: "YYYY-MM-DD" oppure null
- note opzionali (es. "aperto", "quasi finito", "confezione integra")

Struttura JSON:
{
  "items": [
    {
      "name": "nome prodotto",
      "category": "categoria",
      "quantity": 1,
      "unit": "pz",
      "expiresAt": null,
      "notes": null
    }
  ],
  "summary": "Breve descrizione di cosa c'è in dispensa in 1 frase"
}

Se l'immagine non mostra cibo o è illeggibile, restituisci {"items": [], "summary": "Nessun prodotto identificato"}.`;

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

  // 3. Salva i prodotti riconosciuti nella dispensa
  //    Usa upsert-like: per ogni prodotto con stesso nome, aggiorna quantità
  //    Per prodotti nuovi, crea record
  const now = new Date();
  let addedCount = 0;

  for (const item of scannedItems) {
    if (!item.name?.trim()) continue;

    const normalizedName = item.name.trim().toLowerCase();
    const existing = await prisma.pantryItem.findFirst({
      where: {
        userId: req.userId,
        name:   { equals: normalizedName, mode: 'insensitive' },
      },
    });

    if (existing) {
      // Aggiorna quantità sommando
      await prisma.pantryItem.update({
        where: { id: existing.id },
        data: {
          quantity:  existing.quantity + (parseFloat(item.quantity) || 1),
          expiresAt: item.expiresAt ? new Date(item.expiresAt) : existing.expiresAt,
          notes:     item.notes ?? existing.notes,
          updatedAt: now,
        },
      });
    } else {
      await prisma.pantryItem.create({
        data: {
          userId:    req.userId,
          name:      item.name.trim(),
          category:  item.category ?? 'altro',
          quantity:  parseFloat(item.quantity) || 1,
          unit:      item.unit ?? 'pz',
          expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
          notes:     item.notes ?? null,
        },
      });
      addedCount++;
    }
  }

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

// ─── DELETE /api/pantry ───────────────────────────────────────────────────────
async function clearPantry(req, res) {
  const { count } = await prisma.pantryItem.deleteMany({ where: { userId: req.userId } });
  return success(res, { message: `Dispensa svuotata (${count} prodotti rimossi)` });
}

// ─── POST /api/pantry/recipes ─────────────────────────────────────────────────
async function suggestRecipes(req, res) {
  const { people = 2, mealType = 'pranzo o cena', dietNotes = '' } = req.body;

  const items = await prisma.pantryItem.findMany({
    where:   { userId: req.userId },
    orderBy: { expiresAt: 'asc' }, // prima le cose in scadenza
  });

  if (items.length === 0) {
    return error(res, 'La dispensa è vuota. Aggiungi prodotti prima di chiedere ricette.');
  }

  // Costruisci lista dispensa per il prompt
  const pantryList = items
    .map(i => `- ${i.name} (${i.quantity} ${i.unit ?? 'pz'}${i.expiresAt ? `, scade ${i.expiresAt.toLocaleDateString('it-IT')}` : ''})`)
    .join('\n');

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

  const prompt = `Sei un cuoco italiano esperto. L'utente ha questi prodotti in dispensa:

${pantryList}

Contesto: ${people} persone, ${mealType}${dietContext ? `, ${dietContext}` : ''}.

Suggerisci 3 ricette REALISTICHE usando PRINCIPALMENTE i prodotti disponibili (puoi assumere che abbia sale, olio, pepe e spezie base).

Per ogni ricetta indica:
- nome piatto
- tempo di preparazione in minuti
- difficoltà: facile | media | difficile
- ingredienti dalla dispensa usati (con quantità)
- ingredienti mancanti da comprare (lista concisa)
- istruzioni in 3-5 step sintetici
- stima calorie per porzione

Dai priorità ai prodotti con scadenza più vicina.
${langInstruction(userLang?.language)}

Rispondi SOLO in JSON:
{
  "recipes": [
    {
      "name": "Nome piatto",
      "time_minutes": 20,
      "difficulty": "facile",
      "ingredients_available": ["item1 (100g)", "item2 (2 pz)"],
      "ingredients_missing": ["item mancante 1"],
      "steps": ["Step 1...", "Step 2..."],
      "calories_per_serving": 450,
      "tip": "Consiglio dello chef"
    }
  ]
}`;

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
      pantryCount: items.length,
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

  const prompt = `Sei un esperto nutrizionista e pianificatore della spesa italiano.

Obiettivo dell'utente: "${goal}"
Prodotti già in dispensa: ${pantryList}
${dietContext}

Genera una lista della spesa OTTIMALE per raggiungere l'obiettivo, escludendo ciò che è già in dispensa.

Raggruppa per reparto supermercato. Per ogni prodotto indica:
- nome preciso come appare in supermercato
- quantità consigliata
- perché è utile (brevissimo)

${langInstruction(userLang?.language)}

Rispondi SOLO in JSON:
{
  "summary": "In 1 frase cosa compra e perché",
  "estimated_cost": 55.00,
  "sections": [
    {
      "label": "🥩 Carne e pesce",
      "items": [
        { "name": "Petto di pollo", "quantity": "500g", "why": "proteine principali" }
      ]
    }
  ]
}`;

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
  clearPantry,
  suggestRecipes,
  generateShoppingList,
};
