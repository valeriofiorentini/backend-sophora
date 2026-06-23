const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { awardPoints } = require('./gamification.controller');
const { sendMonthlyReportEmail } = require('../utils/email');
const { uploadToS3 } = require('../config/s3');

async function create(req, res) {
  const { barcode, name, productName, price, quantity = 1, storeId, storeName, groupId, groupMemberId } = req.body;
  
  const finalName = name || productName;
  if (!finalName || price === undefined) return error(res, 'name e price obbligatori');

  const finalStore = storeId || storeName;

  const sp = await prisma.scannedProduct.create({
    data: {
      userId: req.userId,
      barcode,
      name: finalName,
      price: parseFloat(price),
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
  // 1. Fetch scanned products
  const scannedProducts = await prisma.scannedProduct.findMany({
    where: {
      userId,
      timestamp: { gte: startDate, lte: endDate },
    },
    orderBy: { timestamp: 'desc' },
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
  const sp = await prisma.scannedProduct.findUnique({ where: { id: req.params.id } });
  if (!sp || sp.userId !== req.userId) return error(res, 'Non trovato o non autorizzato', 404);

  await prisma.scannedProduct.delete({ where: { id: req.params.id } });
  return success(res, { message: 'Eliminato' });
}

function generateReportHtml(report, userId) {
  const monthNames = [
    'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
    'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'
  ];
  const monthName = monthNames[report.month - 1] || `${report.month}`;

  let itemsHtml = '';
  for (const item of report.items) {
    const formattedDate = new Date(item.timestamp).toLocaleDateString('it-IT');
    itemsHtml += `
      <tr>
        <td>${formattedDate}</td>
        <td>${item.name}</td>
        <td style="text-align: center;">${item.quantity}</td>
        <td style="text-align: right;">€ ${item.price.toFixed(2)}</td>
        <td>${item.storeName}</td>
        <td style="text-align: center;">${item.isFromReceipt ? '🧾 Scontrino' : '📦 Scan'}</td>
      </tr>
    `;
  }

  let categoriesHtml = '';
  for (const [cat, sum] of Object.entries(report.categoryTotals)) {
    categoriesHtml += `
      <div class="category-card">
        <span class="category-name">${cat}</span>
        <span class="category-value">€ ${sum.toFixed(2)}</span>
      </div>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>EasyMarket Report Spesa — ${monthName} ${report.year}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #333; line-height: 1.5; padding: 20px; max-width: 800px; margin: 0 auto; }
        h1, h2, h3 { color: #1e3a8a; }
        .header { border-bottom: 2px solid #3b82f6; padding-bottom: 10px; margin-bottom: 20px; }
        .summary-box { background: linear-gradient(135deg, #eff6ff, #dbeafe); padding: 20px; border-radius: 12px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
        .total-amount { font-size: 28px; font-weight: bold; color: #1d4ed8; }
        .categories-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 15px; margin-bottom: 30px; }
        .category-card { background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; border-radius: 8px; display: flex; flex-direction: column; }
        .category-name { font-size: 14px; color: #64748b; }
        .category-value { font-size: 18px; font-weight: bold; color: #0f172a; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: left; font-size: 14px; }
        th { background-color: #f1f5f9; color: #475569; font-weight: 600; }
        tr:hover { background-color: #f8fafc; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>EasyMarket</h1>
        <p>Report mensile delle spese — <strong>${monthName} ${report.year}</strong></p>
      </div>

      <div class="summary-box">
        <div>
          <span style="font-size: 14px; color: #60a5fa; text-transform: uppercase; font-weight: bold;">Spesa Totale</span>
          <div class="total-amount">€ ${report.total.toFixed(2)}</div>
        </div>
        <div style="text-align: right;">
          <div>Articoli totali: <strong>${report.itemCount}</strong></div>
          <div style="font-size: 12px; color: #64748b; margin-top: 5px;">ID Utente: ${userId}</div>
        </div>
      </div>

      <h2>Spesa per Categoria</h2>
      <div class="categories-grid">
        ${categoriesHtml}
      </div>

      <h2>Dettaglio Acquisti</h2>
      <table>
        <thead>
          <tr>
            <th>Data</th>
            <th>Prodotto</th>
            <th style="text-align: center;">Quantità</th>
            <th style="text-align: right;">Prezzo</th>
            <th>Negozio</th>
            <th style="text-align: center;">Origine</th>
          </tr>
        </thead>
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>
    </body>
    </html>
  `;
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

module.exports = { create, getByTimestamp, deleteById, exportReport };
