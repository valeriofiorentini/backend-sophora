/**
 * receiptOcr.service — pipeline completa di lettura scontrini.
 * Estratto da receipt.controller (spostamento puro, nessun cambio di logica).
 *
 * Strategie in ordine di preferenza (runReceiptOcr):
 *   1. Ibrida: OCR testuale (OCR.space / self-hosted) + immagine → LLM vision
 *      (il testo àncora i nomi esatti, l'immagine corregge i prezzi)
 *   2. Vision pura: modello primario → fallback su modello diverso se la
 *      somma degli item non torna col totale o il JSON è malformato
 */

const OpenAI = require('openai');
const axios  = require('axios');
const prisma = require('../config/database');
const { RECEIPT_PROMPT } = require('../prompts/receipt.prompts');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});

// ─── Modelli OCR ──────────────────────────────────────────────────────────────
// Primario: Claude Sonnet 4 — il più FEDELE nell'OCR (gpt-4o tendeva a "indovinare"
// i marchi: FROSTA→Findus/Ringo, LARIANO→Laranjina). Claude trascrive quello che vede.
// Fallback: gpt-4o (modello diverso, secondo parere). Override via env OCR_MODEL.
const ON_OPENROUTER      = !!process.env.OPENROUTER_API_KEY;
const OCR_MODEL_ACCURATE = process.env.OCR_MODEL
  || (ON_OPENROUTER ? 'anthropic/claude-sonnet-4' : 'gpt-4o');   // primario (massima fedeltà)
const OCR_MODEL_FALLBACK = process.env.OCR_MODEL_FALLBACK
  || (ON_OPENROUTER ? 'openai/gpt-4o' : 'gpt-4o');               // secondo parere su modello diverso
// Terzo parere, famiglia di modello ancora diversa (Google invece di
// Anthropic/OpenAI) — usato solo se anche il secondo tentativo non riconcilia,
// per dare un vero "terzo voto" indipendente invece di ripetere gli stessi due.
const OCR_MODEL_THIRD = process.env.OCR_MODEL_THIRD
  || (ON_OPENROUTER ? 'google/gemini-2.0-flash-001' : 'gpt-4o-mini');

// Parser JSON robusto: modelli diversi a volte avvolgono l'output in ```json … ```
// o aggiungono testo. Ripuliamo prima di JSON.parse così il cambio modello è sicuro.
function parseOcrJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = s.indexOf('{');
  const last  = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}

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
  return null; // null = usa modello standard
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Errori transitori (rate limit, sovraccarico, timeout, rete) — vale la pena
// ritentare. Errori come 400 (prompt/immagine invalida) NON vanno ritentati.
function isTransientOcrError(e) {
  const status = e?.status || e?.response?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const code = e?.code || e?.cause?.code;
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'ENOTFOUND') return true;
  if (/timeout/i.test(e?.message || '')) return true;
  return false;
}

/**
 * Chiama l'API OCR con il modello specificato.
 * `store: false` = Zero Data Retention (GDPR): OpenAI non usa i dati per training.
 * Ritenta fino a 2 volte (backoff 800ms/1600ms) sugli errori transitori
 * (429/5xx/timeout upstream) — prima causavano un 500 immediato all'utente
 * anche se bastava riprovare pochi secondi dopo.
 */
async function callOcrApi(model, messages, attempt = 0) {
  try {
    return await openai.chat.completions.create({
      model,
      messages,
      response_format: { type: 'json_object' },
      // 8000 token: uno scontrino con ~90 prodotti sta dentro senza troncare il JSON.
      max_tokens: 8000,
      // temperature 0: estrazione deterministica, l'LLM NON inventa né traduce i nomi
      temperature: 0,
      store: false,   // GDPR: Zero Data Retention
      user: 'shopora-receipt-ocr',
      timeout: 45000,
    });
  } catch (e) {
    if (attempt < 2 && isTransientOcrError(e)) {
      const delay = 800 * Math.pow(2, attempt);
      console.warn(`[receipt] OCR ${model} errore transitorio (${e.message}) → retry tra ${delay}ms`);
      await sleep(delay);
      return callOcrApi(model, messages, attempt + 1);
    }
    throw e;
  }
}

// ─── OCR dedicato (OCR.space) → testo esatto ──────────────────────────────────
async function ocrSpaceText(imageBase64) {
  const params = new URLSearchParams();
  params.append('apikey', process.env.OCRSPACE_API_KEY || 'helloworld');
  params.append('base64Image', imageBase64);   // data:image/...;base64,...
  params.append('language', 'ita');
  params.append('OCREngine', '2');               // engine 2 = migliore su scontrini
  params.append('scale', 'true');
  params.append('isTable', 'true');
  const r = await axios.post('https://api.ocr.space/parse/image', params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000, maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  if (r.data?.IsErroredOnProcessing) {
    throw new Error('OCR.space: ' + JSON.stringify(r.data.ErrorMessage));
  }
  return (r.data?.ParsedResults || []).map(p => p.ParsedText || '').join('\n').trim();
}

// OCR self-hosted: POST l'immagine a un servizio OCR sulla VPS (Docker).
// Config: OCR_PROVIDER=selfhosted  e  OCR_URL=http://127.0.0.1:8884/tesseract
async function ocrSelfHostedText(imageBase64) {
  const url = process.env.OCR_URL;
  if (!url) throw new Error('OCR_URL non configurato');
  const FormData = require('form-data');
  const b64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const buf = Buffer.from(b64, 'base64');
  const form = new FormData();
  form.append('file', buf, { filename: 'receipt.jpg', contentType: 'image/jpeg' });
  form.append('options', JSON.stringify({ languages: ['ita'] }));
  const r = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 60000, maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  const d = r.data || {};
  const text = d?.data?.stdout || d?.text || d?.result
    || d?.ParsedResults?.[0]?.ParsedText || (typeof d === 'string' ? d : '');
  return String(text).trim();
}

// Divide uno scontrino MOLTO alto in 2 metà sovrapposte, così l'OCR legge anche
// il fondo. Richiede 'jimp'; se manca o l'immagine non è lunga → null.
async function splitTallImage(imageBase64) {
  let Jimp;
  try { Jimp = require('jimp'); } catch { return null; }
  const b64 = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const img = await Jimp.read(Buffer.from(b64, 'base64'));
  const w = img.bitmap.width, h = img.bitmap.height;
  if (h < w * 1.8) return null;                 // non abbastanza lunga: niente split
  const mid = Math.round(h / 2);
  const ov  = Math.round(h * 0.06);             // 6% sovrapposizione al centro
  const top = img.clone().crop(0, 0, w, mid + ov);
  const bot = img.clone().crop(0, mid - ov, w, h - (mid - ov));
  const enc = async im => 'data:image/jpeg;base64,' +
    (await im.quality(82).getBufferAsync(Jimp.MIME_JPEG)).toString('base64');
  return [await enc(top), await enc(bot)];
}

// Sceglie la fonte OCR (OCR_PROVIDER) e, per scontrini lunghi, legge in 2 metà.
async function extractReceiptText(imageBase64) {
  const provider = (process.env.OCR_PROVIDER || 'ocrspace').toLowerCase();
  const ocrOne = img => ['selfhosted', 'tesseract', 'paddle', 'http'].includes(provider)
    ? ocrSelfHostedText(img) : ocrSpaceText(img);

  let halves = null;
  try { halves = await splitTallImage(imageBase64); } catch (e) { console.warn('[receipt] split immagine fallito:', e.message); }
  if (halves) {
    console.info('[receipt] scontrino lungo → OCR in 2 metà');
    const [t1, t2] = await Promise.all([ocrOne(halves[0]), ocrOne(halves[1])]);
    return `${t1}\n=== PARTE 2 (continuazione: le righe SUBITO vicino a questo punto possono ripetersi per la sovrapposizione) ===\n${t2}`.trim();
  }
  return ocrOne(imageBase64);
}

// PaddleOCR separa le 3 colonne dello scontrino su righe distinte:
// questo pre-processore le riunisce in 1 riga sola così l'LLM
// non confonde l'aliquota IVA con il prezzo.
function reassembleReceiptLines(text) {
  const ivaRe   = /^\d{1,2}[.,]\d{2}%$/;
  const priceRe = /^-?\d+[.,]\d{2}$/;
  const lines = text.split('\n').map(l => l.trim());
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    const next = lines[i + 1] || '';
    const after = lines[i + 2] || '';
    // Pattern: NOME / IVA% / PREZZO → unisci in una riga sola
    if (cur && ivaRe.test(next) && priceRe.test(after)) {
      out.push(`${cur} ${next} ${after}`);
      i += 3;
    } else {
      if (cur) out.push(cur);
      i++;
    }
  }
  return out.join('\n');
}

// Discrepanza relativa somma netta item vs totalAmount. 0 = torna perfettamente,
// 1 = differenza pari all'intero totale. JSON mancante/vuoto → discrepanza max.
function diffRatio(parsed) {
  if (!parsed) return 1;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const sumItems = items.reduce((acc, i) =>
    acc + (parseFloat(i.totalPrice) || 0) - (parseFloat(i.discount) || 0), 0);
  const total = parseFloat(parsed.totalAmount) || 0;
  if (total <= 0 || items.length === 0) return 0; // niente da confrontare: non blocca la pipeline
  return Math.abs(sumItems - total) / total;
}

// >5% di discrepanza = l'LLM ha quasi certamente letto male un prezzo o
// saltato una riga — soglia sotto cui una lettura viene accettata subito.
const MISMATCH_THRESHOLD = 0.05;

function medianOf(nums) {
  const s = nums.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Nessuno dei tentativi riconcilia esattamente: invece di accettare ciecamente
// l'ultimo letto, si fondono le letture riga per riga prendendo la MEDIANA di
// prezzo/sconto tra i tentativi disponibili (se hanno lo stesso numero di
// righe, quindi probabilmente lo stesso ordine) — un prezzo "di mezzo" tra i
// 3 pareri è statisticamente più vicino al vero valore di un singolo tentativo.
function mergeAttempts(attempts) {
  const valid = attempts.filter(a => a.parsed && Array.isArray(a.parsed.items));
  if (valid.length === 0) return attempts[attempts.length - 1]?.parsed || null;

  const base = [...valid].sort((a, b) => a.diff - b.diff)[0]; // il "meno sbagliato"
  const sameCount = valid.length > 1 && valid.every(a => a.parsed.items.length === base.parsed.items.length);

  if (!sameCount) {
    console.warn(`[receipt] consensus: righe di conteggio diverso tra i tentativi → uso la lettura con discrepanza minore (${base.model})`);
    return base.parsed;
  }

  const mergedItems = base.parsed.items.map((item, idx) => {
    const totalPrices = valid.map(a => parseFloat(a.parsed.items[idx]?.totalPrice)).filter(Number.isFinite);
    const unitPrices  = valid.map(a => parseFloat(a.parsed.items[idx]?.unitPrice)).filter(Number.isFinite);
    const discounts   = valid.map(a => parseFloat(a.parsed.items[idx]?.discount)).filter(Number.isFinite);
    return {
      ...item,
      totalPrice: totalPrices.length ? medianOf(totalPrices) : item.totalPrice,
      unitPrice:  unitPrices.length  ? medianOf(unitPrices)  : item.unitPrice,
      discount:   discounts.length   ? medianOf(discounts)   : item.discount,
    };
  });
  console.info(`[receipt] consensus: fuse ${valid.length} letture riga per riga (mediana prezzi)`);
  return { ...base.parsed, items: mergedItems };
}

/**
 * Legge lo scontrino con fino a 3 modelli diversi in cascata, fermandosi al
 * primo che riconcilia (somma righe ≈ totale). Se nessuno riconcilia, fonde
 * le 3 letture (mediana per riga) invece di fidarsi ciecamente dell'ultima.
 * `baseMessages`: array messages already pronto (prompt ibrido o vision puro).
 * `hintText`: messaggio di correzione da aggiungere quando serve un secondo/
 * terzo parere in continuazione della conversazione.
 */
async function consensusOcr(baseMessages, hintText, models) {
  const [modelA, modelB, modelC] = models;
  const attempts = [];

  // Tentativo 1
  let model = modelA;
  let resp;
  try {
    resp = await callOcrApi(model, baseMessages);
  } catch (e) {
    console.warn(`[receipt] consensus: modello primario ${model} fallito (${e.message}) → ${modelB}`);
    model = modelB;
    resp = await callOcrApi(model, baseMessages);
  }
  let rawContent = resp.choices[0].message.content;
  let parsed = parseOcrJson(rawContent);
  attempts.push({ parsed, model, diff: diffRatio(parsed) });
  if (attempts[0].diff <= MISMATCH_THRESHOLD) return parsed;

  // Tentativo 2: secondo parere, in continuazione con hint di correzione
  const secondModel = model === modelB ? modelA : modelB;
  console.warn(`[receipt] consensus: tentativo 1 (${model}) non torna (diff=${(attempts[0].diff * 100).toFixed(1)}%) → tentativo 2 con ${secondModel}`);
  try {
    const resp2 = await callOcrApi(secondModel, [
      ...baseMessages,
      { role: 'assistant', content: rawContent },
      { role: 'user', content: hintText },
    ]);
    const parsed2 = parseOcrJson(resp2.choices[0].message.content);
    attempts.push({ parsed: parsed2, model: secondModel, diff: diffRatio(parsed2) });
    if (attempts[1].diff <= MISMATCH_THRESHOLD) return parsed2;
  } catch (e) {
    console.warn(`[receipt] consensus: tentativo 2 (${secondModel}) fallito: ${e.message}`);
  }

  // Tentativo 3: terzo modello, lettura INDIPENDENTE (non continuazione, per
  // non ereditare l'errore dei tentativi precedenti) con un modello di
  // famiglia diversa dai primi due.
  console.warn(`[receipt] consensus: tentativo 2 non torna → tentativo 3 con ${modelC} (lettura indipendente)`);
  try {
    const resp3 = await callOcrApi(modelC, baseMessages);
    const parsed3 = parseOcrJson(resp3.choices[0].message.content);
    attempts.push({ parsed: parsed3, model: modelC, diff: diffRatio(parsed3) });
    if (attempts[attempts.length - 1].diff <= MISMATCH_THRESHOLD) return parsed3;
  } catch (e) {
    console.warn(`[receipt] consensus: tentativo 3 (${modelC}) fallito: ${e.message}`);
  }

  console.warn(`[receipt] consensus: nessuno dei ${attempts.length} tentativi riconcilia perfettamente → fusione mediana`);
  return mergeAttempts(attempts);
}

// Pipeline ibrida: OCR testo → testo+immagine all'LLM. Ritorna il JSON parsato,
// o null se il provider è "vision" oppure OCR non disponibile.
async function tryOcrSpacePipeline(imageBase64) {
  if ((process.env.OCR_PROVIDER || '').toLowerCase() === 'vision') {
    console.info('[receipt] OCR_PROVIDER=vision → vision OCR diretto');
    return null;
  }
  let text;
  try {
    text = await extractReceiptText(imageBase64);
  } catch (e) {
    console.warn('[receipt] OCR (testo) non disponibile:', e.message);
    return null;
  }
  if (!text || text.replace(/\s/g, '').length < 40) {
    console.warn('[receipt] OCR testo troppo corto → fallback vision');
    return null;
  }
  // Qualità check: se >40% delle righe non-vuote mancano di un prezzo leggibile
  // il testo è troppo frammentato → fallback alla vision.
  const nonEmpty = text.split('\n').filter(l => l.trim().length > 3);
  const withPrice = nonEmpty.filter(l => /\d+[.,]\d{2}/.test(l));
  if (nonEmpty.length > 5 && withPrice.length / nonEmpty.length < 0.35) {
    console.warn(`[receipt] OCR testo frammentato (${withPrice.length}/${nonEmpty.length} righe con prezzo) → vision`);
    return null;
  }
  const rawLen = text.length;
  text = reassembleReceiptLines(text);
  console.info(`[receipt] OCR OK (${rawLen} char → ${text.length} dopo riassemblaggio) → vision+OCR ibrido`);

  // Strategia ibrida: testo OCR (nomi esatti) + immagine (prezzi) al modello vision.
  const hybridPrompt = `${RECEIPT_PROMPT}

ATTENZIONE — MODALITÀ IBRIDA: Ti fornisco sia l'IMMAGINE che il TESTO OCR già estratto.
Il testo OCR ha i nomi prodotto ESATTI (fidati di esso per i nomi, NON inventare).
L'immagine ha i prezzi nella colonna destra — usala per leggere i prezzi corretti.
Regola: per ogni prodotto, il NOME viene dal testo OCR, il PREZZO viene dall'immagine.

TESTO OCR (nomi esatti, prezzi potrebbero essere incompleti):
"""
${text}
"""`;

  const mimeType = imageBase64.includes('data:') ? imageBase64.split(';')[0].split(':')[1] : 'image/jpeg';
  const b64data  = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
  const messages = [{
    role: 'user',
    content: [
      { type: 'text',       text: hybridPrompt },
      { type: 'image_url',  image_url: { url: `data:${mimeType};base64,${b64data}` } },
    ],
  }];

  try {
    return await consensusOcr(
      messages,
      'La somma dei prezzi degli item non corrisponde al totalAmount. Probabilmente hai SALTATO una o più righe prodotto oppure hai letto male un prezzo nella colonna PREZZO(€) (occhio a cifre confondibili come 9/6, 8/6, 1/4). Rileggi TUTTE le righe usando sia il testo OCR che l\'immagine, e restituisci il JSON corretto e completo.',
      [OCR_MODEL_ACCURATE, OCR_MODEL_FALLBACK, OCR_MODEL_THIRD],
    );
  } catch (e) {
    console.warn('[receipt] pipeline ibrida fallita → fallback vision puro:', e.message);
    return null;
  }
}

/**
 * Entry point unico: ibrida → vision pura con doppio modello e verifica somma.
 * Ritorna il JSON parsato dello scontrino, o lancia se ogni strategia fallisce.
 */
async function runReceiptOcr(imageBase64) {
  // ── PASSO 1: pipeline ibrida (testo OCR + immagine)
  let parsed = await tryOcrSpacePipeline(imageBase64);
  if (parsed) return parsed;

  // ── PASSO 2: vision pura con fallback su modello diverso
  const fineTunedModel = await getOcrModel(); // null = nessun fine-tuned disponibile
  const messages = [{
    role: 'user',
    content: [
      { type: 'text',      text: RECEIPT_PROMPT },
      { type: 'image_url', image_url: { url: imageBase64, detail: 'high' } },
    ],
  }];

  const firstModel = fineTunedModel ?? OCR_MODEL_ACCURATE;
  parsed = await consensusOcr(
    messages,
    'La somma dei prezzi degli item non corrisponde al totalAmount. Probabilmente hai SALTATO una o più righe prodotto (controlla in particolare le sezioni "GASTRONOMIA - X,XX -" consecutive: ognuna è un prodotto distinto) oppure hai letto male un prezzo nella colonna PREZZO(€). Rileggi TUTTE le righe, includi ogni prodotto saltato, e restituisci il JSON corretto e completo.',
    [firstModel, OCR_MODEL_FALLBACK, OCR_MODEL_THIRD],
  );
  return parsed;
}

module.exports = { runReceiptOcr, parseOcrJson, callOcrApi };
