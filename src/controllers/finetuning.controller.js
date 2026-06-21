/**
 * finetuning.controller.js — V5
 * Raccoglie scontrini validati per il fine-tuning di GPT-4o mini.
 *
 * Flusso:
 * 1. L'utente scannerizza uno scontrino → receipt.controller salva il risultato
 * 2. Se l'utente corregge un item (prezzo sbagliato, nome errato) → POST /api/finetuning/correct
 * 3. Lo scontrino corretto diventa un training sample (immagine + JSON validato)
 * 4. POST /api/finetuning/export → genera il file JSONL per OpenAI fine-tuning
 * 5. POST /api/finetuning/trigger → avvia il fine-tuning job su OpenAI
 */

const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── POST /api/finetuning/correct ─────────────────────────────────────────────
// L'utente corregge il risultato OCR di uno scontrino.
// GDPR: raccogliamo il consenso esplicito dell'utente (campo `consent`).
// Senza consenso la correzione NON viene usata per il training.
async function submitCorrection(req, res) {
  const { receiptId, correctedItems, correctedTotal, correctedStoreName, correctedStoreChain } = req.body;
  if (!receiptId) return error(res, 'receiptId obbligatorio');

  // GDPR Art. 6 — base giuridica: consenso esplicito dell'utente
  // L'app deve mostrare un checkbox "Acconsento a usare questa correzione per migliorare l'AI"
  if (req.body.consent !== true) {
    return error(
      res,
      'Consenso al trattamento dati richiesto per contribuire al miglioramento dell\'AI. ' +
      'Imposta `consent: true` per procedere.',
      400,
    );
  }

  const receipt = await prisma.receipt.findUnique({ where: { id: receiptId }, include: { items: true } });
  if (!receipt || receipt.userId !== req.userId) return error(res, 'Scontrino non trovato', 404);

  // Aggiorna i dati reali del Receipt se ci sono correzioni
  const ops = [];
  if (correctedItems && Array.isArray(correctedItems)) {
    // Cancella gli item vecchi e ricreali corretti
    ops.push(prisma.receiptItem.deleteMany({ where: { receiptId } }));
    ops.push(prisma.receiptItem.createMany({
      data: correctedItems.map(item => ({
        receiptId,
        name: item.name || 'Prodotto',
        rawName: item.rawName || item.name || '',
        barcode: item.barcode ?? null,
        quantity: item.quantity || 1,
        unitPrice: parseFloat(item.unitPrice) || parseFloat(item.totalPrice) || 0,
        totalPrice: parseFloat(item.totalPrice) || 0,
        discount: item.discount ? parseFloat(item.discount) : null,
        discountPercent: item.discountPercent ? parseFloat(item.discountPercent) : null,
        category: item.category || null,
      })),
    }));
    if (correctedTotal) {
      ops.push(prisma.receipt.update({ where: { id: receiptId }, data: { totalAmount: correctedTotal } }));
    }
  }
  if (ops.length > 0) await prisma.$transaction(ops);

  // Salva come training sample SOLO se c'è un'immagine (per fine-tuning futuro)
  let sample = null;
  if (receipt.imageUrl && req.body.consent === true) {
    sample = await prisma.fineTuningSample.create({
      data: {
        receiptId,
        userId: req.userId,
        imageUrl: receipt.imageUrl,
        correctedJson: JSON.stringify({
          storeName: correctedStoreName || receipt.storeName,
          storeChain: correctedStoreChain || receipt.storeChain,
          storeAddress: receipt.storeAddress,
          receiptDate: receipt.receiptDate?.toISOString().split('T')[0] || null,
          totalAmount: correctedTotal || receipt.totalAmount,
          totalDiscount: receipt.totalDiscount,
          items: correctedItems || receipt.items.map(i => ({
            name: i.name, rawName: i.rawName, quantity: i.quantity,
            unitPrice: i.unitPrice, totalPrice: i.totalPrice,
            discount: i.discount, discountPercent: i.discountPercent,
          })),
        }),
        status: 'validated',
      },
    });
  }

  return success(res, { corrected: true, sample: sample ? { id: sample.id } : null }, 200);
}

// ─── GET /api/finetuning/stats ─────────────────────────────────────────────────
async function getStats(req, res) {
  const total = await prisma.fineTuningSample.count({ where: { status: 'validated' } });
  const lastJob = await prisma.fineTuningJob.findFirst({ orderBy: { createdAt: 'desc' } });
  return success(res, {
    validatedSamples: total,
    minRequired: 10,
    readyForTraining: total >= 10,
    lastJob: lastJob ? { id: lastJob.openaiJobId, status: lastJob.status, model: lastJob.model, createdAt: lastJob.createdAt } : null,
  });
}

// ─── POST /api/finetuning/export ──────────────────────────────────────────────
// Genera il file JSONL nel formato richiesto da OpenAI fine-tuning
async function exportDataset(req, res) {
  const samples = await prisma.fineTuningSample.findMany({ where: { status: 'validated' } });
  if (samples.length < 10) return error(res, `Campioni insufficienti: ${samples.length}/10 richiesti`, 400);

  const SYSTEM_MSG = `Sei un esperto di scontrini italiani. Analizza l'immagine e restituisci SOLO un JSON valido con storeName, storeChain, storeAddress, receiptDate, items (con name, rawName, quantity, unitPrice, totalPrice, discount, discountPercent), totalAmount, totalDiscount, paymentMethod.`;

  const lines = samples.map(s => JSON.stringify({
    messages: [
      { role: 'system', content: SYSTEM_MSG },
      { role: 'user', content: [
        { type: 'text', text: 'Analizza questo scontrino.' },
        { type: 'image_url', image_url: { url: s.imageUrl, detail: 'high' } },
      ]},
      { role: 'assistant', content: s.correctedJson },
    ],
  }));

  const jsonlContent = lines.join('\n');
  const exportDir = path.join(__dirname, '../../exports');
  if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });
  const filePath = path.join(exportDir, `receipt-finetune-${Date.now()}.jsonl`);
  fs.writeFileSync(filePath, jsonlContent, 'utf-8');

  // FIX: non esporre il path assoluto del filesystem nella risposta
  return success(res, {
    samples:  samples.length,
    fileName: path.basename(filePath), // solo il nome file, non il path completo
    message:  `File JSONL generato con ${samples.length} campioni. Usa POST /api/finetuning/trigger per avviare il training.`,
    // filePath restituito lato server solo per uso interno — non in produzione
    ...(process.env.NODE_ENV !== 'production' && { filePath }),
  });
}

// ─── POST /api/finetuning/trigger ─────────────────────────────────────────────
// Carica il dataset su OpenAI e avvia il fine-tuning job
async function triggerFineTuning(req, res) {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') return error(res, 'filePath obbligatorio');

  // FIX path traversal: verifica che il file sia dentro la directory exports
  const exportDir     = path.resolve(__dirname, '../../exports');
  const resolvedPath  = path.resolve(filePath);
  if (!resolvedPath.startsWith(exportDir + path.sep) && resolvedPath !== exportDir) {
    return error(res, 'Percorso file non valido', 400);
  }
  if (!fs.existsSync(resolvedPath)) return error(res, 'File non trovato', 404);

  try {
    // 1. Upload file su OpenAI
    const uploadRes = await openai.files.create({
      file: fs.createReadStream(resolvedPath),
      purpose: 'fine-tune',
    });

    // 2. Crea il job di fine-tuning
    const job = await openai.fineTuning.jobs.create({
      training_file: uploadRes.id,
      model: 'gpt-4o-mini-2024-07-18',
      hyperparameters: { n_epochs: 3 },
      suffix: 'shopora-receipt-ocr',
    });

    // 3. Salva il job nel DB
    await prisma.fineTuningJob.create({
      data: {
        openaiJobId: job.id,
        openaiFileId: uploadRes.id,
        model: 'gpt-4o-mini',
        status: job.status,
        samplesCount: (await prisma.fineTuningSample.count({ where: { status: 'validated' } })),
      },
    });

    return success(res, {
      jobId: job.id,
      status: job.status,
      message: 'Fine-tuning avviato. Riceverai una notifica OpenAI quando il modello è pronto (30-60 min).',
    });
  } catch (err) {
    console.error('[finetuning] trigger error:', err.message);
    return error(res, `Errore OpenAI: ${err.message}`, 500);
  }
}

// ─── GET /api/finetuning/jobs/:jobId ──────────────────────────────────────────
async function getJobStatus(req, res) {
  try {
    const job = await openai.fineTuning.jobs.retrieve(req.params.jobId);
    // Aggiorna il DB
    await prisma.fineTuningJob.updateMany({
      where: { openaiJobId: req.params.jobId },
      data: { status: job.status, fineTunedModel: job.fine_tuned_model || null },
    });
    return success(res, {
      jobId: job.id,
      status: job.status,
      model: job.fine_tuned_model || 'in training...',
      trainedTokens: job.trained_tokens,
    });
  } catch (err) {
    return error(res, `Job non trovato: ${err.message}`, 404);
  }
}

module.exports = { submitCorrection, getStats, exportDataset, triggerFineTuning, getJobStatus };
