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
const { awardPoints }    = require('../services/gamification.service');
const { checkReceiptLimit } = require('../utils/planLimits');
const { getPlatform } = require('../utils/platform');
const { runReceiptOcr }  = require('../services/receiptOcr.service');
const { populatePantryFromReceipt, VALID_CATEGORIES } = require('../services/pantrySync.service');
const {
  cleanStr, cleanDate, clampQuantity, clampPrice, clampPercent, normalizeProductKey,
} = require('../utils/sanitize');
const { canonicalizeChain } = require('../utils/storeChain');
const { haversineKm } = require('../services/geo.service');
const {
  receiptImagePath, saveReceiptImage, deleteReceiptImage,
} = require('../utils/receiptImages');

// ─── Tipi MIME accettati ───────────────────────────────────────────────────────
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const RECEIPT_SCAN_POINTS = 50;

const ADDRESS_STOPWORDS = new Set(['via', 'viale', 'piazza', 'piazzale', 'corso', 'largo', 'strada', 'localita', 'località', 'loc', 'snc']);
const addressWords = s => (s || '')
  .toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter(w => w.length > 2 && !ADDRESS_STOPWORDS.has(w));

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Parole "uguali a meno di una lettera" (es. "rona" letto dall'OCR al posto di "roma").
const similarWord = (a, b) =>
  a === b || (a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 1 && editDistance(a, b) <= 1);

// Verifica (best-effort) che il negozio/indirizzo letto dall'OCR corrisponda
// a un negozio noto di quella catena nel nostro DB — l'OCR può leggere male
// (es. "Via Rona 1E0179" invece di "Via Roma 177/179") o "allucinare" un
// indirizzo di sfondo. Se non corrisponde, suggerisce il negozio della catena
// più simile/vicino all'utente. Se la catena non ha copertura nel nostro
// Store DB, non giudica (troppi falsi positivi altrimenti).
async function verifyStoreAddress(storeChain, storeAddress, userLoc) {
  if (!storeChain || !storeAddress) return null;
  const targetWords = [...new Set(addressWords(storeAddress))];
  if (targetWords.length === 0) return null;

  const chainWhere = { chain: { equals: storeChain, mode: 'insensitive' } };
  const select = { address: true, latitude: true, longitude: true };
  // Prima: solo i primi 300 negozi della catena, in ordine qualunque — per
  // catene grandi (Eurospin ~1300) il negozio giusto spesso non c'era e
  // scattava l'avviso anche con l'indirizzo corretto.
  let stores = [];
  if (userLoc) {
    stores = await prisma.store.findMany({
      where: {
        ...chainWhere,
        latitude:  { gte: userLoc.lat - 0.4, lte: userLoc.lat + 0.4 },
        longitude: { gte: userLoc.lon - 0.5, lte: userLoc.lon + 0.5 },
      },
      select,
      take: 500,
    });
  }
  if (stores.length === 0) {
    stores = await prisma.store.findMany({ where: chainWhere, select, take: 3000 });
  }
  if (stores.length === 0) return null; // nessuna copertura per questa catena

  const candidates = [];
  for (const s of stores) {
    const words = addressWords(s.address);
    const exact = targetWords.filter(w => words.includes(w)).length;
    // Riconosciuto: 2 parole in comune, o tutte quelle disponibili se uno dei
    // due indirizzi è corto (es. nel DB solo "Via Tiburtina", senza civico).
    if (words.length > 0 && exact >= Math.min(2, targetWords.length, words.length)) return null;
    if (!s.address || !/\d/.test(s.address)) continue; // senza via/civico non è un suggerimento utile
    candidates.push({
      address: s.address,
      exact,
      fuzzy: targetWords.filter(w => words.some(x => similarWord(w, x))).length,
      distanceKm: userLoc ? haversineKm(userLoc.lat, userLoc.lon, s.latitude, s.longitude) : null,
    });
  }

  // Con la posizione: il negozio più vicino tra quelli con almeno una parola
  // simile, altrimenti il più vicino entro 5 km. Senza posizione: il più
  // simile, solo se combaciano almeno due parole (via e città) — altrimenti
  // una "Via Roma" di un'altra città vincerebbe a caso.
  let best = null;
  if (userLoc) {
    const byDistance = (a, b) => a.distanceKm - b.distanceKm;
    best = candidates.filter(c => c.fuzzy >= 1).sort(byDistance)[0]
      || candidates.filter(c => c.distanceKm <= 5).sort(byDistance)[0]
      || null;
  } else {
    best = candidates
      .filter(c => c.fuzzy >= 2)
      .sort((a, b) => b.fuzzy - a.fuzzy || b.exact - a.exact)[0] || null;
  }
  const confident = !!best;
  return {
    storeChain,
    storeAddress,
    ...(confident ? {
      suggestedAddress: best.address,
      suggestedDistanceKm: best.distanceKm != null ? Math.round(best.distanceKm * 10) / 10 : null,
    } : {}),
  };
}

// Ricompone più foto (es. metà superiore + metà inferiore di uno scontrino
// troppo lungo per uno scatto solo) in UNA sola immagine verticale, così il
// resto della pipeline OCR (pensata per un'unica immagine) non cambia.
// Le foto vengono allineate alla larghezza della più stretta e impilate
// nell'ordine in cui l'utente le ha scattate/selezionate.
// Ogni foto passa da Jimp anche se è una sola: Jimp applica l'orientamento
// EXIF ai pixel (non tutti i motori OCR/vision lo leggono) e poi la rotazione
// scelta dall'utente nell'anteprima (gradi in senso orario, multipli di 90).
async function combineReceiptPhotos(files, rotations = []) {
  const Jimp = require('jimp');
  const images = await Promise.all(files.map(async (f, i) => {
    const im = await Jimp.read(f.buffer);
    const deg = (((Number(rotations[i]) || 0) % 360) + 360) % 360;
    // Jimp ruota in senso antiorario: 360-deg = deg in senso orario.
    if (deg % 90 === 0 && deg !== 0) im.rotate(360 - deg);
    return im;
  }));
  if (images.length === 1) {
    const buffer = await images[0].quality(85).getBufferAsync(Jimp.MIME_JPEG);
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }
  const width = Math.min(...images.map(im => im.bitmap.width));
  const resized = images.map(im => im.clone().resize(width, Jimp.AUTO));
  // Fascia scura con "=== FOTO N ===" tra una foto e l'altra: le foto di uno
  // scontrino lungo si sovrappongono, e senza un confine visibile l'AI
  // contava due volte le righe ripetute. Il prompt (receipt.prompts, regola 9)
  // spiega che intorno alla fascia i prodotti ripetuti vanno presi una volta.
  const BAND = 70;
  const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE).catch(() => null);
  const totalHeight = resized.reduce((sum, im) => sum + im.bitmap.height, 0) + BAND * (resized.length - 1);
  const combined = new Jimp(width, totalHeight, 0xffffffff);
  let y = 0;
  resized.forEach((im, i) => {
    if (i > 0) {
      combined.composite(new Jimp(width, BAND, 0x222222ff), 0, y);
      if (font) {
        combined.print(font, 20, y + 18, `=== FOTO ${i + 1} (continuazione) ===`);
      }
      y += BAND;
    }
    combined.composite(im, 0, y);
    y += im.bitmap.height;
  });
  const buffer = await combined.quality(85).getBufferAsync(Jimp.MIME_JPEG);
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

// ─── Scansione in background ──────────────────────────────────────────────────
// Scontrini lunghi / più foto: tra OCR, consensus fino a 3 modelli e
// riconciliazione si superano spesso i 60s — l'app (e il proxy HTTPS davanti
// al server) chiudevano la connessione con "ci ha messo troppo". Con
// ?async=1 si risponde subito con un jobId e l'app chiede il risultato a
// GET /api/receipts/scan-jobs/:jobId. Senza ?async=1 (app vecchie) resta
// tutto com'era. I job vivono in memoria (PM2 in fork, un solo processo):
// dopo un riavvio del server il job non esiste più e l'app chiede di riprovare.
const scanJobs = new Map(); // jobId → { userId, status, httpStatus, body, at }
const SCAN_JOB_TTL_MS = 15 * 60 * 1000;

function cleanupScanJobs() {
  const now = Date.now();
  for (const [id, job] of scanJobs) {
    if (now - job.at > SCAN_JOB_TTL_MS) scanJobs.delete(id);
  }
}

async function scanReceipt(req, res) {
  if (req.query?.async !== '1') return scanReceiptCore(req, res);

  cleanupScanJobs();
  const jobId = require('crypto').randomUUID();
  scanJobs.set(jobId, { userId: req.userId, status: 'processing', at: Date.now() });

  // Stessa logica della scansione normale, ma la risposta viene catturata
  // e salvata nel job invece di essere inviata subito.
  const capture = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  scanReceiptCore(req, capture)
    .catch(e => {
      console.error('[receipt] scansione in background fallita:', e.message);
      capture.status(500).json({ success: false, message: 'Errore durante la lettura dello scontrino' });
    })
    .finally(() => {
      scanJobs.set(jobId, {
        userId: req.userId, status: 'done', httpStatus: capture.statusCode, body: capture.body, at: Date.now(),
      });
    });

  return success(res, { jobId, status: 'processing' }, 202);
}

// ─── GET /api/receipts/scan-jobs/:jobId ──────────────────────────────────────
async function getScanJob(req, res) {
  const job = scanJobs.get(req.params.jobId);
  if (!job || job.userId !== req.userId) {
    return error(res, 'Scansione non trovata (il server potrebbe essere stato riavviato): riprova.', 404);
  }
  if (job.status === 'processing') return success(res, { status: 'processing' });
  return success(res, { status: 'done', httpStatus: job.httpStatus, result: job.body });
}

// ─── POST /api/receipts/scan ───────────────────────────────────────────────────
async function scanReceiptCore(req, res) {
  // Tempo massimo per la lettura: le app che aspettano la risposta (senza
  // ?async=1) chiudono dopo 60s compreso l'upload → 45s qui; in background
  // nessuno aspetta la connessione: 4 minuti bastano per OCR testo (≤30s) +
  // tutti e 3 i modelli (≤45s l'uno) + eventuali ritentativi. L'app attende
  // fino a 5 minuti.
  const budget = { deadline: Date.now() + (req.query?.async === '1' ? 240000 : 45000) };
  const files = req.files || (req.file ? [req.file] : []);
  if (files.length === 0) return error(res, 'Immagine scontrino obbligatoria');

  // Controllo limite piano gratuito (10 scontrini/mese)
  const limitCheck = await checkReceiptLimit(req.userId, getPlatform(req));
  if (!limitCheck.allowed) {
    return error(res,
      `Hai raggiunto il limite di ${limitCheck.limit} scontrini al mese del piano gratuito. ` +
      `Passa a Shopora Premium per scansioni illimitate.`,
      403,
    );
  }

  // Validazione MIME type (su tutte le foto, se sono più d'una)
  for (const f of files) {
    if (!ALLOWED_MIME.has(f.mimetype)) {
      return error(res, `Formato immagine non supportato: ${f.mimetype}. Usa JPEG, PNG o WEBP.`);
    }
  }

  // 1. Se sono più foto (scontrino diviso in 2-3 scatti), ricomponile in una
  // sola immagine verticale PRIMA di passarla all'OCR.
  let rotations = [];
  try { rotations = JSON.parse(req.body?.rotations || '[]'); } catch { rotations = []; }
  if (!Array.isArray(rotations)) rotations = [];
  let imageBase64;
  try {
    imageBase64 = await combineReceiptPhotos(files, rotations);
  } catch (e) {
    console.warn('[receipt] combineReceiptPhotos fallito, uso solo la prima foto:', e.message);
    imageBase64 = `data:${files[0].mimetype};base64,${files[0].buffer.toString('base64')}`;
  }
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
    parsed = await runReceiptOcr(imageBase64, budget);
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
  // canonicalizeChain: riconduce varianti (IPER COOP/Ipercoop/EXTRACOOP…) a
  // una forma unica → niente più catene duplicate a valle (offerte, statistiche).
  parsed.storeChain    = canonicalizeChain(cleanStr(parsed.storeChain));
  parsed.storeAddress  = cleanStr(parsed.storeAddress);
  parsed.paymentMethod = cleanStr(parsed.paymentMethod);
  parsed.receiptDate   = cleanDate(parsed.receiptDate);

  // 3a2. Verifica negozio/indirizzo contro il DB Store (best-effort, vedi sopra).
  const userPos = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { latitude: true, longitude: true },
  }).catch(() => null);
  const userLoc = userPos?.latitude != null && userPos?.longitude != null
    ? { lat: userPos.latitude, lon: userPos.longitude }
    : null;
  const addressMismatch = await verifyStoreAddress(parsed.storeChain, parsed.storeAddress, userLoc)
    .catch(e => { console.warn('[receipt] verifyStoreAddress error:', e.message); return null; });
  if (addressMismatch) {
    console.warn(`[receipt] INDIRIZZO NON TROVATO per ${addressMismatch.storeChain}: "${addressMismatch.storeAddress}" non corrisponde a nessun negozio noto di questa catena.`);
  }

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

  // 3c2. Nessun prodotto riconosciuto = scan fallito, non un successo "vuoto".
  // Prima si salvava comunque uno scontrino processed con 0 item e si
  // assegnavano ugualmente i punti — l'utente vedeva "fatto" con la lista
  // vuota e nessuna indicazione di riprovare con una foto migliore.
  if (items.length === 0) {
    await prisma.receipt.update({
      where: { id: receipt.id },
      data:  { status: 'error' },
    }).catch(() => {});
    return error(
      res,
      'Non siamo riusciti a leggere i prodotti dallo scontrino. Riprova con una foto più nitida, ben illuminata e dritta, evitando riflessi e pieghe.',
      422,
    );
  }

  // 3d. RISPARMIATO: totalDiscount almeno pari alla somma degli sconti per riga.
  const itemDiscSum = items.reduce((a, i) => a + (parseFloat(i.discount) || 0), 0);
  const llmDisc = parseFloat(parsed.totalDiscount) || 0;
  parsed.totalDiscount = Math.round(Math.max(llmDisc, itemDiscSum) * 100) / 100;

  // 3e. RICONCILIAZIONE: somma righe (totalPrice - discount) vs totale stampato.
  // Se non torna, è quasi sempre un prezzo letto male dall'OCR (es. 1.79 invece
  // di 1.39) — non correggiamo automaticamente i prezzi (rischio di sbagliare
  // ancora di più), ma lo segnaliamo ONESTAMENTE al client (priceMismatch),
  // non solo nei log server: prima l'utente non aveva modo di saperlo e
  // vedeva prezzi sbagliati senza alcun avviso.
  const totalAmount = parseFloat(parsed.totalAmount);
  let priceMismatch = null;
  if (Number.isFinite(totalAmount) && items.length > 0) {
    const itemsNetSum = items.reduce(
      (a, i) => a + ((parseFloat(i.totalPrice) || 0) - (parseFloat(i.discount) || 0)),
      0,
    );
    // Sconti sul totale (es. "APP YOGURT DA BERE -0,40" dopo il SUBTOTALE) non
    // sono su nessuna riga: prima facevano scattare l'avviso anche su scontrini
    // letti perfettamente. Quadra se torna con o senza quello sconto (l'AI non
    // sempre lo separa dai prezzi di riga).
    const globalDiscount = Math.max(0, parsed.totalDiscount - itemDiscSum);
    const diffRaw = Math.round((itemsNetSum - totalAmount) * 100) / 100;
    const diffDisc = Math.round((itemsNetSum - globalDiscount - totalAmount) * 100) / 100;
    const diff = Math.abs(diffDisc) < Math.abs(diffRaw) ? diffDisc : diffRaw;
    if (Math.abs(diff) > 0.05) {
      console.warn(
        `[receipt] TOTALE NON QUADRA (receipt=${receipt.id}, store=${parsed.storeChain || parsed.storeName || '?'}): ` +
        `somma righe=${itemsNetSum.toFixed(2)} vs totale scontrino=${totalAmount.toFixed(2)} (diff=${diff.toFixed(2)}) — possibile prezzo letto male dall'OCR.`,
      );
      priceMismatch = { itemsSum: Math.round((totalAmount + diff) * 100) / 100, receiptTotal: totalAmount, diff };
    }
  }

  // 4. Controllo duplicato: stessa data + negozio + totale + n° prodotti
  let isDuplicate = false;

  if (parsed.receiptDate && (parsed.storeChain || parsed.storeName) && parsed.totalAmount) {
    const dateFrom = new Date(parsed.receiptDate);
    const dateTo   = new Date(parsed.receiptDate);
    dateTo.setDate(dateTo.getDate() + 1);
    const total = parseFloat(parsed.totalAmount);

    // Prima: match ESATTO su totalAmount e n° item. Due scan dello stesso
    // scontrino fisico possono differire di un centesimo (arrotondamento) o
    // di un prodotto (variabilità dell'OCR) — il duplicato non veniva mai
    // riconosciuto, creando uno scontrino doppio con punti e dati duplicati.
    // Ora si usa una tolleranza: ±0.05€ sul totale, ±1 sul numero di item.
    const candidates = await prisma.receipt.findMany({
      where: {
        userId: req.userId,
        id:     { not: receipt.id },
        receiptDate: { gte: dateFrom, lt: dateTo },
        totalAmount: { gte: total - 0.05, lte: total + 0.05 },
        ...(parsed.storeChain ? { storeChain: parsed.storeChain } : { storeName: parsed.storeName }),
        status: 'processed',
      },
      include: { _count: { select: { items: true } } },
    });
    const existing = candidates.find(c => Math.abs(c._count.items - items.length) <= 1);

    if (existing) {
      isDuplicate = true;
      console.info(`[receipt] duplicato rilevato (id=${existing.id}) — aggiorno dati, nessun punto aggiunto`);
      await prisma.receipt.delete({ where: { id: receipt.id } }).catch(() => {});
      receipt = existing;
    }
  }

  // 4-bis. Foto (quella letta dall'AI: già raddrizzata/unita) salvata sul
  // server per lo storico scontrini. Best-effort: se il disco fallisce lo
  // scontrino si salva comunque, solo senza foto.
  const imageSaved = await saveReceiptImage(req.userId, receipt.id, imageBase64)
    .then(() => true)
    .catch(e => { console.warn('[receipt] salvataggio foto fallito:', e.message); return false; });

  let updated;

  try {
    updated = await prisma.$transaction(async tx => {
      // Duplicato: prima i prodotti della nuova lettura si AGGIUNGEVANO a
      // quelli già salvati, raddoppiando le righe dello scontrino esistente.
      if (isDuplicate) {
        await tx.receiptItem.deleteMany({ where: { receiptId: receipt.id } });
      }

      // 4a. Aggiorna Receipt con i dati estratti
      await tx.receipt.update({
        where: { id: receipt.id },
        data: {
          ...(imageSaved ? { imageUrl: `/api/receipts/${receipt.id}/image` } : {}),
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
    if (imageSaved && !isDuplicate) deleteReceiptImage(req.userId, receipt.id).catch(() => {});
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
        data: priceEntries.map(item => {
          // Prezzo NETTO effettivamente pagato: sottrai lo sconto per riga
          // (es. "Taglio Prezzo -0.40") dal prezzo di listino, altrimenti
          // PriceHistory registra il prezzo lordo pre-sconto.
          const gross = parseFloat(item.unitPrice);
          const discount = item.discount != null ? parseFloat(item.discount) : 0;
          const net = Math.max(0, gross - (discount || 0));
          return {
          productKey:  normalizeProductKey(item.name),
          storeChain:  parsed.storeChain,
          price:       net,
          isOnSale:    !!(item.discount || item.discountPercent),
          salePercent: item.discountPercent != null ? parseFloat(item.discountPercent) : null,
          observedAt,
          source:      'receipt_ocr',
          };
        }),
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
    ...(priceMismatch ? { priceMismatch } : {}),
    ...(addressMismatch ? { addressMismatch } : {}),
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
  await deleteReceiptImage(req.userId, req.params.id).catch(() => {});
  return success(res, { message: 'Scontrino eliminato' });
}

// ─── GET /api/receipts/:id/image ─────────────────────────────────────────────
// Foto dello scontrino salvata sul server: solo il proprietario può vederla.
async function getReceiptImage(req, res) {
  const receipt = await prisma.receipt.findUnique({
    where:  { id: req.params.id },
    select: { userId: true, imageUrl: true },
  });
  if (!receipt || receipt.userId !== req.userId || !receipt.imageUrl) {
    return error(res, 'Foto non disponibile', 404);
  }
  res.set('Cache-Control', 'private, max-age=86400');
  return res.sendFile(receiptImagePath(req.userId, req.params.id), err => {
    if (err && !res.headersSent) error(res, 'Foto non disponibile', 404);
  });
}

// ─── PATCH /api/receipts/:id/address ─────────────────────────────────────────
// L'utente conferma l'indirizzo suggerito (negozio noto più vicino) al posto
// di quello letto male dall'OCR.
async function updateReceiptAddress(req, res) {
  const storeAddress = cleanStr(req.body.storeAddress);
  if (!storeAddress) return error(res, 'Indirizzo obbligatorio');
  const receipt = await prisma.receipt.findUnique({ where: { id: req.params.id } });
  if (!receipt || receipt.userId !== req.userId) {
    return error(res, 'Scontrino non trovato', 404);
  }
  const updated = await prisma.receipt.update({
    where: { id: req.params.id },
    data:  { storeAddress: storeAddress.slice(0, 200) },
  });
  return success(res, { receipt: updated });
}

// ─── POST /api/receipts/export/excel (solo Premium) ──────────────────────────
// Genera il CSV e lo invia via email all'utente (non download diretto)
async function exportReceiptsExcel(req, res) {
  const { isPremium: checkPremium } = require('../utils/planLimits');
  if (!await checkPremium(req.userId, getPlatform(req))) {
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

module.exports = { scanReceipt, getScanJob, getReceipts, getReceiptById, getReceiptImage, deleteReceipt, updateReceiptAddress, getReceiptStats, exportReceiptsExcel };
