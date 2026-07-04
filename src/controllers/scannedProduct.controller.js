const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { awardPoints } = require('./gamification.controller');
const { sendMonthlyReportEmail } = require('../utils/email');
const { uploadToS3 } = require('../config/s3');
const { generateReportHtml } = require('../templates/reportHtml');

async function create(req, res) {
  const { barcode, name, productName, price, quantity = 1, storeId, storeName, groupId, groupMemberId } = req.body;
  
  const finalName = name || productName;
  if (!finalName || price === undefined) return error(res, 'name e price obbligatori');

  const finalStore = storeId || storeName;

  // Arrotonda a 2 decimali alla scrittura: evita di persistere valori con
  // deriva float (es. 28.129999999999992) che poi si propagano nelle somme.
  // (Migrazione piena a Decimal rimandata: cambierebbe il tipo di price in
  //  ogni risposta API + aritmetica backend — vedi nota nel commit.)
  const roundedPrice = Math.round((parseFloat(price) || 0) * 100) / 100;

  const sp = await prisma.scannedProduct.create({
    data: {
      userId: req.userId,
      barcode,
      name: finalName,
      price: roundedPrice,
      quantity: parseInt(quantity),
      storeId: finalStore,
      groupId,
      groupMemberId,
    },
  });

  // Award 5 points per barcode scan (fire and forget)
  awardPoints(req.userId, 5, 'barcode_scan', sp.id);

  return success(res, { scannedProduct: sp }, 201);
}

async function getMergedProductsAndReceipts(userId, startDate, endDate) {
  // Cap difensivo: la finestra è mensile, ma un range anomalo dal client
  // non deve poter caricare l'intero storico utente in memoria.
  const HARD_CAP = 2000;

  // 1. Fetch scanned products
  const scannedProducts = await prisma.scannedProduct.findMany({
    where: {
      userId,
      timestamp: { gte: startDate, lte: endDate },
    },
    orderBy: { timestamp: 'desc' },
    take: HARD_CAP,
  });

  // 2. Fetch processed receipts with their items
  const receipts = await prisma.receipt.findMany({
    where: {
      userId,
      status: 'processed',
      OR: [
        {
          receiptDate: { gte: startDate, lte: endDate },
        },
        {
          receiptDate: null,
          processedAt: { gte: startDate, lte: endDate },
        },
      ],
    },
    include: {
      items: true,
    },
    orderBy: { processedAt: 'desc' },
    take: 500, // ~500 scontrini/mese è già oltre ogni uso reale
  });

  // 3. Map scanned products to standardized format
  const mappedScanned = scannedProducts.map(item => ({
    id: item.id,
    userId: item.userId,
    groupId: item.groupId,
    groupMemberId: item.groupMemberId,
    barcode: item.barcode,
    name: item.name,
    productName: item.name, // Frontend compatibility
    price: item.price,
    quantity: item.quantity,
    storeId: item.storeId || 'Altro',
    storeName: item.storeId || 'Altro', // Frontend compatibility
    timestamp: item.timestamp,
    createdAt: item.timestamp, // Frontend compatibility
    category: 'Scansionati',
    imageUrl: null,
    isFromReceipt: false,
  }));

  // 4. Map receipt items to standardized format
  const mappedReceiptItems = [];
  for (const receipt of receipts) {
    const timestamp = receipt.receiptDate || receipt.processedAt;
    const store = receipt.storeChain || receipt.storeName || 'Scontrino';
    for (const item of receipt.items) {
      mappedReceiptItems.push({
        id: item.id,
        userId: receipt.userId,
        groupId: null,
        groupMemberId: null,
        barcode: item.barcode,
        name: item.name,
        productName: item.name, // Frontend compatibility
        price: parseFloat(item.totalPrice.toString()), // totalPrice contains total spent for this item line
        quantity: parseFloat(item.quantity.toString()) || 1,
        storeId: store,
        storeName: store, // Frontend compatibility
        timestamp,
        createdAt: timestamp, // Frontend compatibility
        category: item.category || 'Spesa',
        imageUrl: receipt.imageUrl,
        isFromReceipt: true,
      });
    }
  }

  // 5. Combine and sort by date descending
  const combined = [...mappedScanned, ...mappedReceiptItems];
  combined.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return combined;
}

async function getByTimestamp(req, res) {
  const { timeStamp } = req.params;
  const { groupId } = req.query;

  // timeStamp can be "YYYY-MM" for monthly view, a number in milliseconds, or a full ISO date
  let startDate, endDate;
  if (/^\d{4}-\d{2}$/.test(timeStamp)) {
    const [year, month] = timeStamp.split('-').map(Number);
    startDate = new Date(year, month - 1, 1);
    endDate = new Date(year, month, 0, 23, 59, 59);
  } else {
    const parsedNum = Number(timeStamp);
    const date = !isNaN(parsedNum) ? new Date(parsedNum) : new Date(timeStamp);

    if (isNaN(date.getTime())) {
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    } else {
      // Since all client screens displaying this expect a monthly report/breakdown,
      // we query for the entire month containing the date.
      startDate = new Date(date.getFullYear(), date.getMonth(), 1);
      endDate = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
    }
  }

  try {
    const combined = await getMergedProductsAndReceipts(req.userId, startDate, endDate);

    // Apply groupId filter if present
    const filtered = groupId 
      ? combined.filter(item => item.groupId === groupId)
      : combined;

    // Calculate total spent
    const total = filtered.reduce(
      (sum, item) => sum + (item.isFromReceipt ? item.price : item.price * item.quantity),
      0
    );

    return success(res, {
      products: filtered,
      items: filtered,
      total: parseFloat(total.toFixed(2)),
    });
  } catch (err) {
    console.error('[scannedProduct] getByTimestamp error:', err.message);
    return error(res, 'Errore recupero acquisti/budget', 500);
  }
}

async function deleteById(req, res) {
  const id = req.params.id;

  // 1. Prova come prodotto scansionato (barcode)
  const sp = await prisma.scannedProduct.findUnique({ where: { id } });
  if (sp) {
    if (sp.userId !== req.userId) return error(res, 'Non autorizzato', 403);
    await prisma.scannedProduct.delete({ where: { id } });
    return success(res, { message: 'Eliminato' });
  }

  // 2. La lista unisce anche le righe degli scontrini: se l'id è di un receiptItem,
  //    elimina quella riga (prima dava 404 "Non trovato" → errore nell'app).
  const ri = await prisma.receiptItem.findUnique({
    where:   { id },
    include: { receipt: { select: { userId: true } } },
  });
  if (ri && ri.receipt?.userId === req.userId) {
    await prisma.receiptItem.delete({ where: { id } });
    return success(res, { message: 'Eliminato' });
  }

  return error(res, 'Non trovato o non autorizzato', 404);
}

// generateReportHtml spostata in templates/reportHtml.js (vedi import in cima).

// Prima data di attività dell'utente (primo scontrino o primo prodotto
// scansionato) — serve al frontend per sapere da che mese mostrare il
// confronto storico, invece di generare sempre i 12 mesi dell'anno corrente
// (che mostrerebbero "€0" ingannevoli per i mesi prima che l'utente iniziasse
// a usare l'app).
// receiptDate viene letta dall'OCR su un formato scontrino spesso ambiguo
// (GG/MM/AA): un anno letto male (es. "26" scambiato per "24", stessa
// famiglia di errori di lettura cifre dei prezzi) farebbe apparire un falso
// "primo scontrino" anni prima che l'utente abbia mai usato l'app. processedAt
// è generato dal server al momento dell'upload ed è sempre affidabile: se
// receiptDate si discosta troppo da processedAt (più di 60 giorni prima, o
// nel futuro), è quasi certamente un errore sull'ANNO — è raro scansionare
// uno scontrino vecchio di anni. Invece di scartare mese/giorno (informazione
// comunque utile), si tenta prima la correzione più probabile: stesso
// mese/giorno ma con l'anno di processedAt.
const RECEIPT_DATE_MAX_DAYS_BEFORE_UPLOAD = 60;
function plausibleReceiptDate(receiptDate, processedAt) {
  if (!receiptDate) return null;
  const rd = new Date(receiptDate);
  if (isNaN(rd.getTime())) return null;
  if (!processedAt) return receiptDate;

  const pa = new Date(processedAt);
  const daysBefore = (pa.getTime() - rd.getTime()) / (1000 * 60 * 60 * 24);
  if (daysBefore <= RECEIPT_DATE_MAX_DAYS_BEFORE_UPLOAD && daysBefore >= -1) {
    return receiptDate; // già plausibile così com'è
  }

  // Anno probabilmente letto male: riprova con l'anno di processedAt,
  // mantenendo mese/giorno originali dello scontrino.
  const corrected = new Date(rd);
  corrected.setFullYear(pa.getFullYear());
  const correctedDaysBefore = (pa.getTime() - corrected.getTime()) / (1000 * 60 * 60 * 24);
  if (correctedDaysBefore <= RECEIPT_DATE_MAX_DAYS_BEFORE_UPLOAD && correctedDaysBefore >= -1) {
    return corrected;
  }

  return null; // nessuna correzione plausibile: meglio scartarla del tutto
}

async function getFirstActivityDate(req, res) {
  const [firstReceipt, firstScan] = await Promise.all([
    prisma.receipt.findFirst({
      where: { userId: req.userId, status: 'processed' },
      orderBy: [{ receiptDate: 'asc' }, { processedAt: 'asc' }],
      select: { receiptDate: true, processedAt: true },
    }),
    prisma.scannedProduct.findFirst({
      where: { userId: req.userId },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
    }),
  ]);

  const dates = [
    plausibleReceiptDate(firstReceipt?.receiptDate, firstReceipt?.processedAt),
    firstReceipt?.processedAt,
    firstScan?.timestamp,
  ].filter(Boolean);

  const firstDate = dates.length > 0
    ? new Date(Math.min(...dates.map(d => new Date(d).getTime())))
    : null;

  return success(res, { firstDate });
}

async function exportReport(req, res) {
  const { month, year } = req.query;
  const { isEmail } = req.params;

  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year) || new Date().getFullYear();

  const startDate = new Date(y, m - 1, 1);
  const endDate = new Date(y, m, 0, 23, 59, 59);

  try {
    const combined = await getMergedProductsAndReceipts(req.userId, startDate, endDate);
    const reportItems = [...combined].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const total = reportItems.reduce(
      (sum, item) => sum + (item.isFromReceipt ? item.price : item.price * item.quantity),
      0
    );

    const categoryTotals = reportItems.reduce((acc, item) => {
      const key = item.category || 'Altro';
      acc[key] = (acc[key] || 0) + (item.isFromReceipt ? item.price : item.price * item.quantity);
      return acc;
    }, {});

    const reportData = {
      month: m,
      year: y,
      items: reportItems,
      total: parseFloat(total.toFixed(2)),
      categoryTotals,
      itemCount: reportItems.length,
    };

    const isEmailFlag = isEmail === 'true';

    if (isEmailFlag) {
      const user = await prisma.user.findUnique({ where: { id: req.userId } });
      if (!user || !user.email) {
        return error(res, 'Email utente non disponibile', 400);
      }

      await sendMonthlyReportEmail(user.email, reportData, user);
      return success(res, { message: 'Report inviato via email' });
    } else {
      const htmlContent = generateReportHtml(reportData, req.userId);
      let downloadUrl;
      try {
        if (process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID !== 'your-access-key') {
          const reportFile = {
            originalname: `report-${y}-${m}.html`,
            mimetype: 'text/html',
            buffer: Buffer.from(htmlContent, 'utf-8'),
          };
          downloadUrl = await uploadToS3(reportFile, 'reports');
        } else {
          downloadUrl = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;
        }
      } catch (uploadErr) {
        console.warn('[scannedProduct] S3 upload failed for report, using data URI:', uploadErr.message);
        downloadUrl = `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`;
      }

      return success(res, { downloadUrl, report: reportData });
    }
  } catch (err) {
    console.error('[scannedProduct] exportReport error:', err.message);
    return error(res, 'Errore generazione report', 500);
  }
}

module.exports = { create, getByTimestamp, deleteById, exportReport, getFirstActivityDate };
