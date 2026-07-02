/**
 * sanitize — difese contro output OCR/LLM sballato.
 * Estratto da receipt.controller (spostamento puro, nessun cambio di logica).
 */

// Stringhe: "null"/"N/A"/vuote → null
function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === 'null' || low === 'undefined' || low === 'n/a' || low === 'na' || low === '-') return null;
  return s;
}

// Date: invalide o assurde (prima del 2000, oltre 1 anno nel futuro) → null
function cleanDate(v) {
  const s = cleanStr(v);
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  if (year < 2000 || year > new Date().getFullYear() + 1) return null;
  return d;
}

// Clamp numerici: un OCR sballato può restituire 999999
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

module.exports = { cleanStr, cleanDate, clampQuantity, clampPrice, clampPercent, normalizeProductKey };
