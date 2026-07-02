/**
 * receipt.controller.js — controller HTTP scontrini.
 *
 * La logica pesante vive nei moduli dedicati:
 *   services/receiptOcr.service  → pipeline OCR (ibrida + vision, doppio modello)
 *   services/pantrySync.service  → sync dispensa con dedup per sourceReceiptId
 *   prompts/receipt.prompts      → prompt OCR
 *   utils/sanitize               → pulizia stringhe/date/numeri dall'OCR
 *
 * Qui restano solo: validazione richiesta, orchestrazione, salvataggio DB.
 */

const prisma  = require('../config/database');
const { success, error } = require('../utils/response');
const { awardPoints }    = require('./gamification.controller');
const { checkReceiptLimit } = require('../utils/planLimits');
const { runReceiptOcr }  = require('../services/receiptOcr.service');
const { populatePantryFromReceipt, VALID_CATEGORIES } = require('../services/pantrySync.service');
const {
  cleanStr, cleanDate, clampQuantity, clampPrice, clampPercent, normalizeProductKey,
} = require('../utils/sanitize');

// ─── Tipi MIME accettati ───────────────────────────────────────────────────────
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const RECEIPT_SCAN_POINTS = 50;

// ─── POST /api/receipts/scan ───────────────────────────────────────────────────
async function scanReceipt(req, res) {
  if (!req.file) return error(res, 'Immagine scontrino obbligatoria');

  // Controllo limite piano gratuito (10 scontrini/mese)
  const limitCheck = await checkReceiptLimit(req.userId);
  if (!limitCheck.allowed) {
    return error(res,
      `Hai raggiunto il limite di ${limitCheck.limit} scontrini al mese del piano gratuito. ` +
      `Passa a Shopora Premium per scansioni illimitate.`,
      403,
    );
  }

  // Validazione MIME type
  if (!ALLOWED_MIME.has(req.file.mimetype)) {
    return error(res, `Formato immagine non supportato: ${req.file.mimetype}. Usa JPEG, PNG o WEBP.`);
  }

  // 1. Converti immagine in base64 (no S3 richiesto)
  const imageBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  const imageUrl = null;

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

  // 3. OCR (pipeline completa nel service: ibrida → vision con doppio modello)
  let parsed;
  try {
    parsed = await runReceiptOcr(imageBase64);
  } catch (ocrErr) {
    console.error('[receipt] OCR error:', ocrErr.message);
    await prisma.receipt.update({
      where: { id: receipt.id },
      data:  { status: 'error' },
    }).catch(() => {});
    return error(res, 'Errore durante la lettura dello scontrino', 500);
  }

  // 3b. SANITIZE: l'OCR a volte restituisce la stringa "null"/"N/A" o date non valide.
  parsed.storeName     = cleanStr(parsed.storeName);
  parsed.storeChain    = cleanStr(parsed.storeChain);
  parsed.storeAddress  = cleanStr(parsed.storeAddress);
  parsed.paymentMethod = cleanStr(parsed.paymentMethod);
  parsed.receiptDate   = cleanDate(parsed.receiptDate);

  // 3c. SANITIZE ITEMS: rimuovi pseudo-righe "sconto" e ghost row a prezzo 0.
  const DISCOUNT_LABEL = /^\s*(scont|taglio?\s*prezz|articolo\s*prezzo\s*fisso|volantin|promo\b|offert|riduzion|buono\s*sconto)/i;
  const items = (Array.isArray(parsed.items) ? parsed.items : []).filter(it => {
    const name = (it?.name || it?.rawName || '').trim();
    if (!name) return false;
    const price = parseFloat(it?.totalPrice);
    if (DISCOUNT_LABEL.test(name) && (!Number.isFinite(price) || price <= 0)) return false;
    if (!Number.isFinite(price) || price <= 0) return false;
    return true;
  });
  parsed.items = items;

  // 3d. RISPARMIATO: totalDiscount almeno pari alla somma degli sconti per riga.
  const itemDiscSum = items.reduce((a, i) => a + (parseFloat(i.discount) || 0), 0);
  const llmDisc = parseFloat(parsed.totalDiscount) || 0;
  parsed.totalDiscount = Math.round(Math.max(llmDisc, itemDiscSum) * 100) / 100;

  // 4. Controllo duplicato: stessa data + negozio + totale + n° prodotti
  let isDuplicate = false;

  if (parsed.receiptDate && (parsed.storeChain || parsed.storeName) && parsed.totalAmount) {
    const dateFrom = new Date(parsed.receiptDate);
    const dateTo   = new Date(parsed.receiptDate);
    dateTo.setDate(dateTo.getDate() + 1);

    const existing = await prisma.receipt.findFirst({
      where: {
        userId: req.userId,
        id:     { not: receipt.id },
        receiptDate: { gte: dateFrom, lt: dateTo },
        totalAmount: parseFloat(parsed.totalAmount),
        ...(parsed.storeChain ? { storeChain: parsed.storeChain } : { storeName: parsed.storeName }),
        status: 'processed',
      },
      include: { _count: { select: { items: true } } },
    });

    if (existing && existing._count.items === items.length) {
      isDuplicate = true;
      console.info(`[receipt] duplicato rilevato (id=${existing.id}) — aggiorno dati, nessun punto aggiunto`);
      await prisma.receipt.delete({ where: { id: receipt.id } }).catch(() => {});
      receipt = existing;
    }
  }

  let updated;

  try {
    updated = await prisma.$transaction(async tx => {
      // 4a. Aggiorna Receipt con i dati estratti
      await tx.receipt.update({
        where: { id: receipt.id },
        data: {
          storeName:     parsed.storeName    ?? null,
          storeChain:    parsed.storeChain   ?? null,
          storeAddress:  parsed.storeAddress ?? null,
          receiptDate:   parsed.receiptDate,   // già Date valida o null (cleanDate)
          totalAmount:   parsed.totalAmount  != null ? parseFloat(parsed.totalAmount)  : null,
          totalDiscount: parsed.totalDiscount != null ? parseFloat(parsed.totalDiscount) : null,
          paymentMethod: parsed.paymentMethod ?? null,
          status:        'processed',
        },
      });

      // 4b. createMany per gli item — 1 query invece di N
      if (items.length > 0) {
        await tx.receiptItem.createMany({
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
            category:        VALID_CATEGORIES.has(item.category) ? item.category : null,
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

  // 5. PriceHistory per forecasting B2B — GDPR opt-in (b2bDataSharing)
  if (parsed.storeChain && items.length > 0) {
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

  // 6. Popola dispensa (fire-and-forget) — dedup per sourceReceiptId nel service
  if (items.length > 0) {
    populatePantryFromReceipt(req.userId, items, receipt.id)
      .catch(e => console.warn('[receipt] pantry sync error:', e.message));
  }

  // 7. Punti gamification — solo se NON è un duplicato
  if (!isDuplicate) {
    awardPoints(req.userId, RECEIPT_SCAN_POINTS, 'receipt_scan', receipt.id)
      .catch(e => console.warn('[receipt] awardPoints error:', e.message));
  }

  return success(res, {
    receipt:     updated,
    itemCount:   items.length,
    isDuplicate,
    ...(isDuplicate ? { message: 'Scontrino già presente: dati aggiornati, nessun punto aggiunto.' } : {}),
  }, 201);
}

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
    prisma.receipt.aggregate({
      where:  baseWhere,
      _sum:   { totalAmount: true, totalDiscount: true },
      _count: { id: true },
    }),
    prisma.receipt.groupBy({
      by:     ['storeChain'],
      where:  baseWhere,
      _sum:   { totalAmount: true },
      _count: { id: true },
    }),
    prisma.receiptItem.groupBy({
      by:     ['name'],
      where:  { receipt: baseWhere },
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

// ─── POST /api/receipts/export/excel (solo Premium) ──────────────────────────
// Genera il CSV e lo invia via email all'utente (non download diretto)
async function exportReceiptsExcel(req, res) {
  const { isPremium: checkPremium } = require('../utils/planLimits');
  if (!await checkPremium(req.userId)) {
    return error(res, 'L\'export Excel è una funzione Premium. Abbonati a Shopora Premium.', 403);
  }

  const user = await prisma.user.findUnique({
    where:  { id: req.userId },
    select: { email: true, name: true, username: true },
  });
  if (!user?.email) return error(res, 'Email utente non trovata', 400);

  const receipts = await prisma.receipt.findMany({
    where:   { userId: req.userId, status: 'processed' },
    orderBy: { receiptDate: 'desc' },
    include: { items: true },
  });

  // Genera CSV (separatore ; standard europeo, BOM UTF-8 per Excel)
  const rows = [
    ['Data', 'Negozio', 'Prodotto', 'Qtà', 'Prezzo unitario €', 'Totale €', 'Sconto €'].join(';'),
  ];
  for (const r of receipts) {
    const date  = r.receiptDate ? r.receiptDate.toISOString().slice(0, 10) : '';
    const store = (r.storeName || r.storeChain || '').replace(/;/g, ',');
    if (r.items.length === 0) {
      rows.push([date, store, '', '', '', (r.totalAmount ?? ''), ''].join(';'));
    }
    for (const item of r.items) {
      rows.push([
        date,
        store,
        (item.name || '').replace(/;/g, ','),
        item.quantity ?? 1,
        (item.unitPrice  ?? '').toString().replace('.', ','),
        (item.totalPrice ?? '').toString().replace('.', ','),
        (item.discount   ?? '').toString().replace('.', ','),
      ].join(';'));
    }
  }
  const csv = '﻿' + rows.join('\r\n');

  // Manda via email
  try {
    const { sendMailWithAttachment } = require('../services/mailer');
    const userName = user.name || user.username || 'Utente';
    await sendMailWithAttachment(
      user.email,
      'Shopora — La tua storia della spesa',
      `<p>Ciao ${userName},</p>
       <p>In allegato trovi la storia completa della tua spesa in formato CSV, apribile con Microsoft Excel o Google Sheets.</p>
       <p>Per aprirlo correttamente in Excel: File → Importa → scegli CSV → separatore punto e virgola (;).</p>
       <br><p>Buona spesa! 🛒<br><b>Il team Shopora</b></p>`,
      {
        filename:    'shopora_spesa.csv',
        content:     csv,
        contentType: 'text/csv; charset=utf-8',
        encoding:    'utf8',
      },
    );
    return success(res, { message: `Export inviato a ${user.email}. Controlla la posta (può richiedere qualche minuto).` });
  } catch (mailErr) {
    console.error('[export] email error:', mailErr.message);
    // Fallback: ritorna il CSV direttamente se email non funziona
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="shopora_spesa.csv"');
    return res.send(csv);
  }
}

module.exports = { scanReceipt, getReceipts, getReceiptById, deleteReceipt, getReceiptStats, exportReceiptsExcel };
