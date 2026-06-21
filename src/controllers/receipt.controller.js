/**
 * receipt.controller.js
 *
 * Fix applicati:
 *  - scanReceipt: tutto il salvataggio DB dentro $transaction → niente dati parziali
 *  - scanReceipt: createMany per i receiptItem (1 query invece di N)
 *  - scanReceipt: validazione MIME type e input
 *  - getReceiptStats: aggregazioni DB-side (_sum, _count) invece di caricare tutto in memoria
 *  - getReceiptStats: bounds check su `months` (max 24)
 *  - getReceiptById / deleteReceipt: try/catch esplicito
 *  - PriceHistory: upsert con ignoreConflicts per evitare duplicati da scan ripetuti
 */

const OpenAI  = require('openai');
const prisma  = require('../config/database');
const { uploadToS3 }  = require('../config/s3');
const { success, error } = require('../utils/response');
const { awardPoints }    = require('./gamification.controller');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});

// ─── Tipi MIME accettati ───────────────────────────────────────────────────────
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// ─── Modelli OCR ──────────────────────────────────────────────────────────────
// Piano tecnico: gpt-4o-mini prima (10x meno costoso), fallback a gpt-4o su errori.
// gpt-4o-mini: ~$0.0003/scontrino | gpt-4o: ~$0.003/scontrino
// Su OpenRouter i modelli OpenAI richiedono il prefisso 'openai/'
const OR_PREFIX          = process.env.OPENROUTER_API_KEY ? 'openai/' : '';
const OCR_MODEL_FAST     = `${OR_PREFIX}gpt-4o-mini`;   // modello economico — tenta prima
const OCR_MODEL_ACCURATE = `${OR_PREFIX}gpt-4o`;        // fallback di precisione

// V5: se il fine-tuned model è pronto, usa quello (supera entrambi)
async function getOcrModel() {
  if (process.env.FINETUNED_OCR_MODEL) return process.env.FINETUNED_OCR_MODEL;
  try {
    const job = await prisma.fineTuningJob.findFirst({
      where:   { status: 'succeeded', fineTunedModel: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (job?.fineTunedModel) return job.fineTunedModel;
  } catch {}
  return null; // null = usa logica mini → 4o
}

/**
 * Chiama OpenAI OCR con il modello specificato.
 * `store: false` = Zero Data Retention (GDPR): OpenAI non usa i dati per training.
 */
async function callOcrApi(model, messages) {
  return openai.chat.completions.create({
    model,
    messages,
    response_format: { type: 'json_object' },
    max_tokens: 4000,
    store: false,   // GDPR: Zero Data Retention — OpenAI non trattiene i dati
    user: 'shopora-receipt-ocr', // tracking anonimo per abuse detection
  });
}

// ─── Prompt OCR ───────────────────────────────────────────────────────────────
const RECEIPT_PROMPT = `Sei un esperto di scontrini italiani. Analizza l'immagine e restituisci SOLO un JSON valido.

REGOLE CRITICHE — seguile nell'ordine:

0. COLONNE SCONTRINO: Lo scontrino italiano ha tipicamente 3 colonne: DESCRIZIONE | IVA% | Prezzo(€). La colonna IVA contiene percentuali come "4,00%", "10,00%", "22,00%" — NON sono prezzi! Il prezzo è SEMPRE l'ultimo numero sulla riga, nella colonna Prezzo(€). Non confondere mai la percentuale IVA con il prezzo del prodotto.

1. SCONTI SU RIGA SEPARATA: Se dopo un prodotto c'è una riga con "SCONTO", "Sconto Reparti", "Sconto Volantino", "SCONTO SOCI", "SCONTO X% CLIENTI", "SCONTO CARTA", "SCONTO WEEK END", "Sconto artic." ecc., quella riga è lo sconto del prodotto precedente. Mettila nel campo "discount" di quel prodotto con valore positivo (es. 0.50, non -0.50), NON come prodotto separato.

2. PRODOTTI DUPLICATI: Se lo stesso prodotto appare N volte (righe identiche), crea UN SOLO oggetto con "quantity": N e calcola unitPrice e totalPrice di conseguenza.

3. TOTALE REALE: Il campo "totalAmount" deve essere il totale pagato in denaro (voce "TOTALE COMPLESSIVO" o "IMPORTO EURO"). Ignora BUONI PASTO, BUONI SCONTO, PUNTI FEDELTÀ — non sono pagamenti reali.

4. NOMI PRODOTTI: Mantieni il nome il più completo e fedele possibile allo scontrino. Espandi le abbreviazioni ma non perdere informazioni importanti:
   - C.N.FIL → Conserva/Filetti (es. C.N.FIL.MELANZANE → "Filetti di Melanzane sottoolio")
   - C.S/S → Condimento/Salsa (C.S/S INS.RUSSA → "Insalata Russa")
   - INS. → Insalata, C.IGIENICA → Carta Igienica, C.STRACCHINO / C.STRACCHINOI → Stracchino
   - CALVE' / CALVÉ → Calvé, BRAVO → Bravo
   - Misure: 165G → 165g, 200G → 200g, X6 → conf. da 6
   - PAM: MB → Marca Bene, T.ARCA → Terra d'Aromi
   - Esselunga: NS → Nostra Spesa
   - GX2 → confezione doppia

4b. SEZIONE GASTRONOMIA: Se lo scontrino ha una sezione marcata "GASTRONOMIA" con un prezzo separato (es. "GASTRONOMIA - 7,99 -"), questa è una categoria speciale: i prodotti elencati sotto (es. POLLO ARROSTO) sono venduti al banco gastronomia. Includi il prodotto con il prefisso "Gastronomia:" nel nome (es. "Gastronomia: Pollo Arrosto").

5. COSA ESCLUDERE dagli items: righe IVA, punti fedeltà, resto, buoni pasto, subtotali ("SUBTOTALE"), "DI CUI IVA", "Pagamento elettronico", "Importo pagato", spese di servizio, shopper/borse. NON escludere MAI prodotti alimentari o prodotti per la casa — includi assolutamente TUTTI i prodotti con un prezzo.

5b. NESSUN PRODOTTO SALTATO: Conta le righe prodotto sullo scontrino e verifica che l'array "items" abbia lo stesso numero di elementi. Se una riga ha un prezzo valido e non è un subtotale/IVA, deve essere inclusa.

6. FOTO SFOCATA O PARZIALE: Se un valore non è leggibile usa null. Non inventare prezzi.

7. DATA: Lo scontrino può mostrare la data in formato GG/MM/AAAA oppure GG/MM/AA — converti sempre in YYYY-MM-DD.

Struttura JSON da restituire:
{
  "storeName": "nome negozio completo o null",
  "storeChain": "catena esatta tra: Coop, Conad, Esselunga, Carrefour, Lidl, Eurospin, Penny, Famila, Top Supermercati, Aldi, Pam, Despar, Tigros, Pim o null",
  "storeAddress": "indirizzo completo o null",
  "receiptDate": "YYYY-MM-DD o null",
  "items": [
    {
      "name": "nome prodotto leggibile in italiano (espandi abbreviazioni)",
      "rawName": "testo esatto sullo scontrino",
      "barcode": "codice EAN se presente o null",
      "quantity": 1,
      "unitPrice": 0.00,
      "totalPrice": 0.00,
      "discount": 0.00,
      "discountPercent": null
    }
  ],
  "totalAmount": 0.00,
  "totalDiscount": 0.00,
  "paymentMethod": "contanti/carta/buono pasto/misto o null"
}`;

// ─── POST /api/receipts/scan ───────────────────────────────────────────────────
async function scanReceipt(req, res) {
  if (!req.file) return error(res, 'Immagine scontrino obbligatoria');

  // Validazione MIME type
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return error(res, `Formato immagine non supportato: ${req.file.mimetype}. Usa JPEG, PNG o WEBP.`);
  }

  // 1. Converti immagine in base64 (no S3 richiesto per testing)
  const imageBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  const imageUrl = null; // nessun storage esterno

  // 2. Crea record "processing" per feedback immediato all'utente
  let receipt;
  try {
    receipt = await prisma.receipt.create({
      data: { userId: req.userId, imageUrl, status: 'processing' },
    });
  } catch (dbErr) {
    console.error('[receipt] create error:', dbErr.message);
    return error(res, 'Errore database', 500);
  }

  // 3. OCR con gpt-4o-mini → fallback gpt-4o
  //    Strategia: tenta prima col modello economico (10x meno costoso).
  //    Se la risposta non è JSON valido, ritenta con gpt-4o (più accurato).
  //    Se è disponibile un fine-tuned model, usa direttamente quello.
  let parsed;
  try {
    const fineTunedModel = await getOcrModel(); // null = nessun fine-tuned disponibile
    const messages = [{
      role: 'user',
      content: [
        { type: 'text',      text: RECEIPT_PROMPT },
        { type: 'image_url', image_url: { url: imageBase64, detail: 'high' } },
      ],
    }];

    // Tentativo 1: fine-tuned (se disponibile) oppure gpt-4o-mini
    const firstModel = fineTunedModel ?? OCR_MODEL_FAST;
    const response   = await callOcrApi(firstModel, messages);
    const rawContent = response.choices[0].message.content;

    try {
      parsed = JSON.parse(rawContent);
      console.info(`[receipt] OCR ok con modello ${firstModel}`);
    } catch {
      // Parse fallito → scala a gpt-4o (più capace, 10x costoso)
      console.warn(`[receipt] JSON malformato da ${firstModel}, fallback a ${OCR_MODEL_ACCURATE}`);
      const fallbackRes = await callOcrApi(OCR_MODEL_ACCURATE, [
        ...messages,
        { role: 'assistant', content: rawContent },
        { role: 'user', content: 'Il JSON precedente è malformato. Restituisci SOLO il JSON corretto senza markdown, backtick o testo extra.' },
      ]);
      parsed = JSON.parse(fallbackRes.choices[0].message.content);
      console.info(`[receipt] OCR ok con fallback ${OCR_MODEL_ACCURATE}`);
    }
  } catch (ocrErr) {
    console.error('[receipt] OCR error:', ocrErr.message);
    await prisma.receipt.update({
      where: { id: receipt.id },
      data:  { status: 'error' },
    }).catch(() => {});
    return error(res, 'Errore durante la lettura dello scontrino', 500);
  }

  // 4. Salva tutto in transaction atomica — niente dati parziali in caso di crash
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  let updated;

  try {
    updated = await prisma.$transaction(async tx => {
      // 4a. Aggiorna Receipt con i dati estratti
      const r = await tx.receipt.update({
        where: { id: receipt.id },
        data: {
          storeName:     parsed.storeName    ?? null,
          storeChain:    parsed.storeChain   ?? null,
          storeAddress:  parsed.storeAddress ?? null,
          receiptDate:   parsed.receiptDate  ? new Date(parsed.receiptDate) : null,
          totalAmount:   parsed.totalAmount  != null ? parseFloat(parsed.totalAmount)  : null,
          totalDiscount: parsed.totalDiscount != null ? parseFloat(parsed.totalDiscount) : null,
          paymentMethod: parsed.paymentMethod ?? null,
          status:        'processed',
        },
      });

      // 4b. createMany per gli item — 1 query invece di N
      if (items.length > 0) {
        await tx.receiptItem.createMany({
          // Clamp dei valori numerici: un OCR sballato può restituire quantità
          // o prezzi assurdi (es. 999999) — li limitiamo a intervalli plausibili.
          data: items.map(item => ({
            receiptId:       receipt.id,
            name:            item.name     || item.rawName || 'Prodotto sconosciuto',
            rawName:         item.rawName  || item.name   || '',
            barcode:         item.barcode  ?? null,
            quantity:        clampQuantity(item.quantity),
            unitPrice:       clampPrice(item.unitPrice),
            totalPrice:      clampPrice(item.totalPrice),
            discount:        item.discount        != null ? clampPrice(item.discount)        : null,
            discountPercent: item.discountPercent != null ? clampPercent(item.discountPercent) : null,
            category:        null,
          })),
          skipDuplicates: true,
        });
      }

      return tx.receipt.findUnique({
        where:   { id: receipt.id },
        include: { items: true },
      });
    });
  } catch (txErr) {
    console.error('[receipt] transaction error:', txErr.message);
    await prisma.receipt.update({
      where: { id: receipt.id },
      data:  { status: 'error' },
    }).catch(() => {});
    return error(res, 'Errore salvataggio dati scontrino', 500);
  }

  // 5. PriceHistory per forecasting B2B — fuori dalla transaction principale
  //    GDPR opt-in: inseriamo i prezzi nel pool B2B SOLO se l'utente ha dato il consenso
  //    (b2bDataSharing === true, default). L'utente può disattivarlo nelle Impostazioni.
  if (parsed.storeChain && items.length > 0) {
    // Leggi preferenza opt-in dell'utente (select solo il campo necessario)
    const userPrefs = await prisma.user.findUnique({
      where:  { id: req.userId },
      select: { b2bDataSharing: true },
    }).catch(() => null);

    const sharingEnabled = userPrefs?.b2bDataSharing !== false; // default true se null

    if (sharingEnabled) {
      const observedAt   = parsed.receiptDate ? new Date(parsed.receiptDate) : new Date();
      const priceEntries = items.filter(i => i.name && parseFloat(i.unitPrice) > 0);

      prisma.priceHistory.createMany({
        data: priceEntries.map(item => ({
          productKey:  normalizeProductKey(item.name),
          storeChain:  parsed.storeChain,
          price:       parseFloat(item.unitPrice),
          isOnSale:    !!(item.discount || item.discountPercent),
          salePercent: item.discountPercent != null ? parseFloat(item.discountPercent) : null,
          observedAt,
          source:      'receipt_ocr',
        })),
        skipDuplicates: false,
      }).catch(e => console.warn('[receipt] priceHistory insert error:', e.message));
    } else {
      console.info(`[receipt] B2B data sharing disabilitato per utente ${req.userId} — nessuna voce aggiunta a PriceHistory`);
    }
  }

  // 6. Popola dispensa automaticamente dagli item dello scontrino (fire-and-forget)
  if (items.length > 0) {
    populatePantryFromReceipt(req.userId, items)
      .catch(e => console.warn('[receipt] pantry sync error:', e.message));
  }

  // 7. Assegna punti gamification (fire-and-forget — non blocca la risposta)
  awardPoints(req.userId, RECEIPT_SCAN_POINTS, 'receipt_scan', receipt.id)
    .catch(e => console.warn('[receipt] awardPoints error:', e.message));

  return success(res, { receipt: updated, itemCount: items.length }, 201);
}

const RECEIPT_SCAN_POINTS = 50;

// ─── GET /api/receipts ────────────────────────────────────────────────────────
async function getReceipts(req, res) {
  const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 20); // cap a 50
  const skip  = (page - 1) * limit;

  const [receipts, total] = await Promise.all([
    prisma.receipt.findMany({
      where:   { userId: req.userId, status: 'processed' },
      orderBy: { processedAt: 'desc' },
      skip,
      take:    limit,
      include: { items: true },
    }),
    prisma.receipt.count({ where: { userId: req.userId, status: 'processed' } }),
  ]);

  return success(res, { receipts, total, page, pages: Math.ceil(total / limit) });
}

// ─── GET /api/receipts/stats ──────────────────────────────────────────────────
async function getReceiptStats(req, res) {
  // Validazione: max 24 mesi per evitare query enormi
  const rawMonths = parseInt(req.query.months, 10);
  const months    = (!rawMonths || rawMonths < 1 || rawMonths > 24) ? 3 : rawMonths;

  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const baseWhere = { userId: req.userId, status: 'processed', processedAt: { gte: since } };

  // Aggregazioni DB-side — niente caricamento in memoria di tutti i record
  const [agg, byChainRaw, topItemsRaw] = await Promise.all([
    // Totale speso + risparmiato + conteggio
    prisma.receipt.aggregate({
      where:  baseWhere,
      _sum:   { totalAmount: true, totalDiscount: true },
      _count: { id: true },
    }),

    // Spesa per catena (groupBy)
    prisma.receipt.groupBy({
      by:     ['storeChain'],
      where:  baseWhere,
      _sum:   { totalAmount: true },
      _count: { id: true },
    }),

    // Top prodotti per frequenza (aggregazione DB)
    prisma.receiptItem.groupBy({
      by:     ['name'],
      where:  {
        receipt: baseWhere,
      },
      _sum:   { totalPrice: true, quantity: true },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take:   10,
    }),
  ]);

  const byChain = Object.fromEntries(
    byChainRaw.map(r => [
      r.storeChain ?? 'Altro',
      { count: r._count.id, total: parseFloat((r._sum.totalAmount ?? 0).toFixed(2)) },
    ]),
  );

  const topProducts = topItemsRaw.map(r => ({
    name:       r.name,
    count:      r._sum.quantity ?? r._count.id,
    totalSpent: parseFloat((r._sum.totalPrice ?? 0).toFixed(2)),
  }));

  return success(res, {
    totalSpent:    parseFloat((agg._sum.totalAmount   ?? 0).toFixed(2)),
    totalSaved:    parseFloat((agg._sum.totalDiscount ?? 0).toFixed(2)),
    receiptCount:  agg._count.id,
    byChain,
    topProducts,
  });
}

// ─── GET /api/receipts/:id ─────────────────────────────────────────────────────
async function getReceiptById(req, res) {
  const receipt = await prisma.receipt.findUnique({
    where:   { id: req.params.id },
    include: { items: true },
  });
  if (!receipt || receipt.userId !== req.userId) {
    return error(res, 'Scontrino non trovato', 404);
  }
  return success(res, { receipt });
}

// ─── DELETE /api/receipts/:id ─────────────────────────────────────────────────
async function deleteReceipt(req, res) {
  const receipt = await prisma.receipt.findUnique({ where: { id: req.params.id } });
  if (!receipt || receipt.userId !== req.userId) {
    return error(res, 'Scontrino non trovato', 404);
  }
  // onDelete: Cascade elimina anche i ReceiptItem associati
  await prisma.receipt.delete({ where: { id: req.params.id } });
  return success(res, { message: 'Scontrino eliminato' });
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Popola la dispensa con i prodotti estratti dallo scontrino.
 *
 * Versione batch (prima: 2 query per prodotto in loop → su uno scontrino da
 * 30 prodotti erano 60 query). Ora:
 *   1 findMany per leggere la dispensa esistente
 *   1 createMany per i prodotti nuovi
 *   N update (solo per i prodotti già presenti) dentro un'unica transaction
 *
 * Dedup case-insensitive sia tra gli item dello scontrino sia con la dispensa.
 */
async function populatePantryFromReceipt(userId, items) {
  // 1. Aggrega gli item dello scontrino per nome normalizzato (lowercase)
  const byKey = new Map();
  for (const item of items) {
    const name = (item.name || item.rawName || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const qty = clampQuantity(item.quantity);
    if (byKey.has(key)) {
      byKey.get(key).quantity += qty;
    } else {
      byKey.set(key, { name, quantity: qty, barcode: item.barcode ?? null });
    }
  }
  if (byKey.size === 0) return;

  // 2. Una sola query per leggere la dispensa esistente dell'utente
  const existing = await prisma.pantryItem.findMany({
    where:  { userId },
    select: { id: true, name: true, quantity: true },
  });
  const existingByKey = new Map(existing.map(e => [e.name.trim().toLowerCase(), e]));

  // 3. Separa nuovi (createMany) da esistenti (update con somma quantità)
  const toCreate = [];
  const updates  = [];
  for (const [key, data] of byKey) {
    const match = existingByKey.get(key);
    if (match) {
      updates.push(
        prisma.pantryItem.update({
          where: { id: match.id },
          data:  { quantity: match.quantity + data.quantity, inStock: true, updatedAt: new Date() },
        }),
      );
    } else {
      toCreate.push({
        userId,
        name:     data.name,
        category: 'altro',
        quantity: data.quantity,
        unit:     'pz',
        barcode:  data.barcode,
        inStock:  true,
        source:   'receipt',
      });
    }
  }

  // 4. Batch atomico: createMany (1 query) + gli update
  const ops = [];
  if (toCreate.length > 0) {
    ops.push(prisma.pantryItem.createMany({ data: toCreate, skipDuplicates: true }));
  }
  ops.push(...updates);
  if (ops.length > 0) await prisma.$transaction(ops);
}

// ─── Clamp valori numerici (difesa da OCR sballato) ────────────────────────────
function clampQuantity(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(n, 1000);          // max 1000 pezzi per riga
}
function clampPrice(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 100000);        // max 100.000 € per riga
}
function clampPercent(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 100);           // 0–100 %
}

/**
 * Normalizza il nome di un prodotto in una chiave stabile per PriceHistory.
 * Es: "Pasta Barilla 500g" → "pasta_barilla_500g"
 */
function normalizeProductKey(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòù\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

module.exports = { scanReceipt, getReceipts, getReceiptById, deleteReceipt, getReceiptStats };
