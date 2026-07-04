/**
 * Template HTML del report mensile spese — estratto da scannedProduct.controller
 * (spostamento puro). Genera l'HTML che viene poi convertito/inviato via email.
 */
function generateReportHtml(report, userId) {
  const monthNames = [
    'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
    'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
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
      <title>Shopora Report Spesa — ${monthName} ${report.year}</title>
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
        <h1>Shopora</h1>
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

module.exports = { generateReportHtml };
