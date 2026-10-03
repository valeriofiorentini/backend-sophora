/**
 * Foto degli scontrini salvate sul disco del server, una cartella per utente:
 *   <RECEIPT_IMAGES_DIR>/<userId>/<receiptId>.jpg
 * Di default fuori dalla cartella del repo (accanto a backend-sophora), così
 * un `git pull` non le tocca. Non sono pubbliche: si leggono solo da
 * GET /api/receipts/:id/image, che controlla il proprietario.
 * Si cancellano con lo scontrino e con l'account (GDPR).
 */
const fs = require('fs/promises');
const path = require('path');

const ROOT = process.env.RECEIPT_IMAGES_DIR || path.resolve(__dirname, '../../../receipt-images');

const safe = v => String(v).replace(/[^\w-]/g, '');
const userDir = userId => path.join(ROOT, safe(userId));
const receiptImagePath = (userId, receiptId) => path.join(userDir(userId), `${safe(receiptId)}.jpg`);

async function saveReceiptImage(userId, receiptId, dataUrl) {
  const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  await fs.mkdir(userDir(userId), { recursive: true });
  await fs.writeFile(receiptImagePath(userId, receiptId), Buffer.from(b64, 'base64'));
}

const deleteReceiptImage = (userId, receiptId) =>
  fs.rm(receiptImagePath(userId, receiptId), { force: true });

const deleteUserReceiptImages = userId =>
  fs.rm(userDir(userId), { recursive: true, force: true });

module.exports = { receiptImagePath, saveReceiptImage, deleteReceiptImage, deleteUserReceiptImages };
