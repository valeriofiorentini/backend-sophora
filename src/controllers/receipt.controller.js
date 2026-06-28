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
const { checkReceiptLimit } = require('../utils/planLimits');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});

// ─── Tipi MIME accettati ───────────────────────────────────────────────────────
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

// ─── Modelli OCR ──────────────────────────────────────────────────────────────
// Siamo su OpenRouter → possiamo scegliere qualsiasi modello.
// Per l'OCR scontrini serve il miglior modello VISION: Gemini 2.5 Pro è top per
// OCR di documenti (foto storte, scontrini lunghi 60+ righe, testo italiano) ed
// ha un output molto ampio. gpt-4o resta come secondo parere (fallback su modello
// diverso). Tutto override-abile via env: OCR_MODEL / OCR_MODEL_FALLBACK.
const ON_OPENROUTER      = !!process.env.OPENROUTER_API_KEY;
const OCR_MODEL_ACCURATE = process.env.OCR_MODEL
  || (ON_OPENROUTER ? 'google/gemini-2.5-pro' : 'gpt-4o');   // primario (massima precisione)
const OCR_MODEL_FALLBACK = process.env.OCR_MODEL_FALLBACK
  || (ON_OPENROUTER ? 'openai/gpt-4o' : 'gpt-4o');           // secondo parere su modello diverso
const OCR_MODEL_FAST     = OCR_MODEL_ACCURATE;               // retrocompat (non più mini)

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
    // 16000 token: anche scontrini lunghissimi stanno dentro senza troncare il JSON.
    // Con 4000 gli scontrini lunghi (60+ righe) venivano tagliati a metà → output corrotto.
    max_tokens: 16000,
    // temperature 0: estrazione deterministica, l'LLM NON inventa né traduce i nomi
    // (es. "BANANE" restava "BANANE", non diventava "Bananes").
    temperature: 0,
    store: false,   // GDPR: Zero Data Retention — OpenAI non trattiene i dati
    user: 'shopora-receipt-ocr', // tracking anonimo per abuse detection
  });
}

// ─── Prompt OCR ───────────────────────────────────────────────────────────────
const RECEIPT_PROMPT = `Sei un esperto di scontrini italiani. Analizza l'immagine e restituisci SOLO un JSON valido.

REGOLE CRITICHE — seguile nell'ordine:

0. COLONNE SCONTRINO: Lo scontrino italiano ha tipicamente 3 colonne: DESCRIZIONE | IVA% | Prezzo(€). La colonna IVA contiene percentuali come "4,00%", "10,00%", "22,00%" — NON sono prezzi! Il prezzo è SEMPRE l'ultimo numero sulla riga, nella colonna Prezzo(€). Non confondere mai la percentuale IVA con il prezzo del prodotto.

   ESEMPIO CRITICO — scontrino PIM/Coop/Conad con colonne:
   "BRAVO C.IGIENICA X6   22,00%   2,49"
   → IVA = 22,00% (ignora), Prezzo = 2,49 € ✓  (NON 22,00 €!)
   "C.STRACCHINOI 165G    4,00%    1,89"
   → IVA = 4,00% (ignora), Prezzo = 1,89 € ✓  (NON 4,00 €!)

   REGOLA ANTI-CONFUSIONE: se il "prezzo" che stai per scrivere è uguale a 4, 10 o 22 (con o senza decimali), FERMATI e rileggi la riga — stai quasi certamente leggendo la colonna IVA invece del prezzo reale. Cerca l'ultimo numero sulla riga che NON sia seguito da "%" — quello è il prezzo.

   NOTA: alcuni scontrini (es. PIM) hanno un trattino "-" dopo il prezzo (es. "2,49-"). Il trattino indica che l'IVA è inclusa nel prezzo — ignoralo, il prezzo è 2,49.

   ATTENZIONE PREZZI: Se un prezzo inizia con "4" o "4,xx" o "4.xx" verifica attentamente che non sia una lettura errata del "1" iniziale (es. "1,79" che sembra "4,79" su foto storta). Controlla sempre la coerenza col totale finale.

1. SCONTI SU RIGA SEPARATA: Se dopo un prodotto c'è una riga con "SCONTO", "Sconto Reparti", "Sconto Volantino", "VOLANTINO", "VOLANTINO XX" (dove XX è il numero dello sconto in centesimi o euro), "SCONTO SOCI", "SCONTO X% CLIENTI", "SCONTO CARTA", "SCONTO WEEK END", "Sconto artic.", "Taglio Prezzo", "TAGLIO PREZZO", "Articolo prezzo fisso", "ARTICOLO PREZZO FISSO", "Sconto 10% AH", "SCONTO AH", "sconto soci" ecc., quella riga è uno SCONTO/RIDUZIONE, NON un prodotto. Mettila nel campo "discount" del prodotto precedente con valore positivo (es. 1.30, non -1.30), NON come prodotto separato.
   REGOLA "VOLANTINO XX": il numero dopo VOLANTINO (es. "VOLANTINO 17") è il CODICE/NUMERO dell'offerta volantino — NON è l'importo dello sconto. L'importo dello sconto è sempre il valore nella colonna Prezzo(€) sulla stessa riga, che sarà negativo (es. -1,19). Usa quel valore come "discount" del prodotto precedente (positivo: 1.19). Ignora completamente il numero che segue VOLANTINO.
   Se non c'è un prodotto precedente chiaro, ignorala.

2. PRODOTTI DUPLICATI: Unisci in UN SOLO oggetto SOLO se il prodotto ha ESATTAMENTE lo stesso nome E lo stesso prezzo unitario. Due righe con nomi simili ma prezzi diversi sono prodotti DISTINTI — non unire. Esempio: due righe "CONSILIA STRACC.165G 4% 1,89" identiche → un oggetto con quantity:2, unitPrice:1.89, totalPrice:3.78. Ma "CONSILIA STRACC.165G" e "CONSILIA GOCCE 250G" sono prodotti DIVERSI anche se entrambi "Consilia".

3. TOTALE REALE: Il campo "totalAmount" deve essere il totale EFFETTIVAMENTE PAGATO, cioè il SUBTOTALE meno tutti gli sconti post-subtotale (es. "Sconto 10% AH", "SCONTO SOCI", "SCONTO X%"). Se lo scontrino mostra: SUBTOTALE 16,45 → Sconto 10% AH -1,65 → allora totalAmount = 14,80. NON usare il SUBTOTALE come totalAmount se ci sono sconti aggiuntivi dopo.
   Il campo "totalDiscount" include la somma di TUTTI gli sconti (per articolo + globali). Se lo scontrino mostra una riga "RISPARMIATO", "HAI RISPARMIATO", "TOTALE SCONTO" o simile con un importo (es. "-1,19"), usa quel valore come "totalDiscount" (positivo: 1.19). È la fonte più affidabile del risparmio totale — usala quando presente.

3b. NOME NEGOZIO: Leggi l'insegna/brand ESATTAMENTE come è stampato sullo scontrino (es. "IPER TRISCOUNT", "Conad", "Esselunga") — non inventare o correggere l'ortografia. Se è presente anche una ragione sociale generica (es. "SGM Supermercati Srl", "XYZ Srl", "ABC SpA"), combinale: "IPER TRISCOUNT - SGM Supermercati Srl". Se lo scontrino ha SOLO la ragione sociale senza un'insegna riconoscibile, usa solo quella. Priorità: insegna brand > ragione sociale.

4. NOMI PRODOTTI: Il "name" deve restare FEDELE allo scontrino — è una trascrizione, non una traduzione.
   REGOLA D'ORO: NON tradurre mai in altre lingue, NON inventare forme plurali/singolari diverse, NON cambiare parole già chiare in italiano. Esempi di errori da NON fare: "BANANE" → "Bananes" (SBAGLIATO, deve restare "Banane"), "BANANE" → "Banana" (SBAGLIATO), "PESCHE NETTARINE" → "Pesche" (SBAGLIATO, mantieni "Pesche Nettarine"). Se una parola è già una parola italiana corretta, lasciala IDENTICA (solo la prima lettera maiuscola).
   Espandi le abbreviazioni SOLO quando sono chiaramente troncature (es. "PROSC." → "Prosciutto"), ma non perdere informazioni:
   - C.N.FIL → Conserva/Filetti (es. C.N.FIL.MELANZANE → "Filetti di Melanzane sottoolio")
   - C.S/S → Condimento/Salsa (C.S/S INS.RUSSA → "Insalata Russa")
   - INS. → Insalata, C.IGIENICA → Carta Igienica, C.STRACCHINO / C.STRACCHINOI → Stracchino
   - CALVE' / CALVÉ → Calvé, BRAVO → Bravo
   - Misure: 165G → 165g, 200G → 200g, X6 → conf. da 6, X18 → conf. da 18, X10 → conf. da 10
   - Consilia: brand di prodotti a marchio IPER/SGM. CONSILIA STRACC. → "Consilia Stracchino", CONSILIA GOCCE → "Consilia Gocce (cioccolato)", CONSILIA SACCHI GELO → "Consilia Sacchi Gelo", CONSILIA STRAC. → "Consilia Stracchino"
   - PESCHE NETT. → "Pesche Nette", CREMA P.STELLE / CREMA PAN STELLE / CREMA STELLE → "Crema Pan di Stelle" (è il biscotto Nestlé Pan di Stelle, NON pasticcera generica), FOXY CARTA CUCINA → "Foxy Carta Cucina"
   - Regola "STELLE": se vedi "STELLE" o "P.STELLE" vicino a "CREMA", è sempre "Pan di Stelle" (Nestlé). Se vedi "PASTICCERA" senza "STELLE", allora è crema pasticcera generica.
   - PAM: MB → Marca Bene, T.ARCA → Terra d'Aromi, FROL. → Frollini, CAC → Cacao, BASTONCINI → Bastoncini, SFOGLIAVELO → Sfogliatelle Velo, BIO-POM.DATTER → Bio Pomodori Datterini, SOTTILISSIME → Sottilissime, GROS → Grossa, CHAMP. → Champignon, AFFET → Affettati, PANCARRE → Pancarré, PIADA → Piadina, PR.CRUDO → Prosciutto Crudo, STAG → Stagionato, PANINI → Panini, HAMBURG → Hamburger, BOVI → Bovino, BIANCA SFOGLIA → Pasta Sfoglia Bianca, YOG → Yogurt, MAGRO BIAN → Magro Bianco, UOVA MEDIE → Uova Medie, BAGUETTE RU → Baguette Rustica, G.PADANO GRATT → Grana Padano Grattugiato, FILETTO DI MER → Filetto di Merluzzo, PETTO FETTE FA → Petto di Pollo Fette Farcite, SALE GROSSO IO → Sale Grosso Iodato, INSALATA VIVAC → Insalata Vivace, PANBAUL BIANCO → Panbaul Bianco
   - PAM FREEZER → prodotto surgelato PAM (es. "PAM FREEZER MEDI" → "Surgelati PAM Medi")
   - BIO SACC. OF 60% → Sacchetto Biodegradabile Oxo-Flap 60% (shopper biodegradabile — ESCLUDI dagli items come shopper/borsa)
   - Esselunga: NS → Nostra Spesa
   - GX2 → confezione doppia
   - PETALI SPECK → Petali di Speck, NEGRO → (marca)
   - ROBERTO G. PIADA / ROBERT G.PIAD → Roberto Giordano Piadina
   - ROBER HAMB → Robert Hamburger, MEG MAX → Mega Max
   - KELL. → Kellogg's, COCOOPS BARC → CocoPops Barchette
   - MULLER / MULLER → Müller (marca yogurt), 8 BIANCO MULLER → Yogurt 8 Bianco Müller
   - FATT.ULIV OLIO EVO → Olio Extra Vergine di Oliva Frantoi Ulivi
   - MANT OLIO EX.V. EQ → Olio Extra Vergine Equosolidale
   - PASSATA MUTT → Passata Mutti
   - PATTATE / PATATTE → "Patate" (correzione ortografica automatica — non scrivere mai "pattate")
   - ACQUA VITAL / ACQUA VITASN / VITASNELLA → "Acqua Vitasnella"
   - SCHIACCIAT. / SCHIACCIATINE / SCHIACCIAT (con punto o troncato) → sempre "Schiacciatine". Solo se lo scontrino scrive per esteso "Schiacciata" (senza punto, senza troncatura) riferendosi a un prodotto da forno diverso, mantieni "Schiacciata". CONSILIA SCHIACCIAT. → "Consilia Schiacciatine".
   - LENTICCHIE VAPORE → Lenticchie al Vapore
   - SFOGLIAVELO CARNE → Sfogliatelle Velo alla Carne
   - CEREALI T.PETALI CA → Cereali Petali al Cacao
   - BARILLA PENN.RIGAT → Barilla Penne Rigate, BARILLA FUSILLI 98 → Barilla Fusilli n.98, BARILLA SPAGH.N.5 → Barilla Spaghetti n.5
   - RUMMO FUSILLI / RUMMO PENNE RIGATE / RUMMO MEZ.PENNE.RI / RUMMO SPAGHETTI / RUMMO SPAGHETTONI → pasta Rummo (mantieni il formato del nome)
   - P FILETTO FAM AIA → Filetto di Pollo Famiglia AIA
   - CANNAMELA → Cannamela (spezie, mantieni il nome)
   - Prefisso "T " sugli scontrini PAM = indicatore IVA, ignoralo nel nome prodotto

4b. SEZIONE GASTRONOMIA: Se lo scontrino ha una sezione marcata "GASTRONOMIA" con un prezzo separato (es. "GASTRONOMIA - 7,99 -"), questa è una categoria speciale: i prodotti elencati sotto sono venduti al banco gastronomia. Includi il prodotto con il prefisso "Gastronomia:" nel nome.
   Esempi gastronomia: POLLO ARR → "Gastronomia: Pollo Arrosto", PATATE ARR / PATTATE ARR / PAT.ARROSTO → "Gastronomia: Patate Arrosto" (NON "Pattate"), LASAGNE → "Gastronomia: Lasagne", ARISTA → "Gastronomia: Arista".

5. COSA ESCLUDERE dagli items: righe IVA, punti fedeltà, resto, buoni pasto, subtotali ("SUBTOTALE"), "DI CUI IVA", "Pagamento elettronico", "Importo pagato", spese di servizio.
   INCLUDI sempre shopper e sacchetti anche se costano poco (es. "SHOPPER MAT-BIO €0,12") — l'utente vuole vedere tutto quello che ha pagato.
   NON escludere MAI prodotti alimentari o prodotti per la casa — includi assolutamente TUTTI i prodotti con un prezzo.

5b. NESSUN PRODOTTO SALTATO: Conta le righe prodotto sullo scontrino e verifica che l'array "items" abbia lo stesso numero di elementi. Se una riga ha un prezzo valido e non è un subtotale/IVA, deve essere inclusa.

6. FOTO SFOCATA O PARZIALE: Se un valore non è leggibile usa null. Non inventare prezzi.

7. DATA: Lo scontrino può mostrare la data in formato GG/MM/AAAA oppure GG/MM/AA — converti sempre in YYYY-MM-DD.

Struttura JSON da restituire:
{
  "storeName": "nome negozio completo o null",
  "storeChain": "catena esatta tra: Coop, Conad, Esselunga, Carrefour, Lidl, Eurospin, Penny, Famila, Top Supermercati, Aldi, Pam, Despar, Tigros, Pim, Iper, MD, Todis, Pewex, Bennet o null",
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
  //    Strategia: usa il modello accurato (Gemini 2.5 Pro su OpenRouter).
  //    Se la somma non torna o il JSON è malformato, secondo parere con gpt-4o.
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

    // Tentativo 1: fine-tuned (se disponibile) oppure gpt-4o (accurato).
    // Prima si usava gpt-4o-mini per risparmiare, ma su scontrini reali (foto
    // storte, 60+ righe) sbagliava troppo: nomi alterati e prezzi errati.
    // L'accuratezza dell'estrazione È il valore dell'app → vale i ~$0.003/scontrino.
    let firstModel = fineTunedModel ?? OCR_MODEL_ACCURATE;
    // Resilienza: se il modello primario dà errore API (modello non disponibile,
    // response_format non supportato, rate limit…) ricade su gpt-4o, già provato.
    let response;
    try {
      response = await callOcrApi(firstModel, messages);
    } catch (primaryErr) {
      if (firstModel === OCR_MODEL_FALLBACK) throw primaryErr; // già su gpt-4o: rilancia
      console.warn(`[receipt] modello primario ${firstModel} fallito (${primaryErr.message}) → fallback ${OCR_MODEL_FALLBACK}`);
      firstModel = OCR_MODEL_FALLBACK;
      response = await callOcrApi(OCR_MODEL_FALLBACK, messages);
    }
    const rawContent = response.choices[0].message.content;

    let parsedFirst;
    try {
      parsedFirst = parseOcrJson(rawContent);
      console.info(`[receipt] OCR ok con modello ${firstModel}`);
    } catch {
      parsedFirst = null;
    }

    // Validazione somma item vs totalAmount: se discrepanza >5% o JSON malformato → fallback modello diverso
    const needsFallback = !parsedFirst || (() => {
      const items = Array.isArray(parsedFirst.items) ? parsedFirst.items : [];
      const sumItems = items.reduce((acc, i) => acc + (parseFloat(i.totalPrice) || 0), 0);
      const total = parseFloat(parsedFirst.totalAmount) || 0;
      if (total <= 0 || items.length === 0) return false;
      const diff = Math.abs(sumItems - total) / total;
      if (diff > 0.05) {
        console.warn(`[receipt] somma item (${sumItems.toFixed(2)}) ≠ total (${total.toFixed(2)}) diff=${(diff*100).toFixed(1)}% → fallback ${OCR_MODEL_FALLBACK}`);
        return true;
      }
      return false;
    })();

    if (needsFallback) {
      console.warn(`[receipt] fallback a ${OCR_MODEL_FALLBACK}`);
      const fallbackRes = await callOcrApi(OCR_MODEL_FALLBACK, [
        ...messages,
        ...(parsedFirst ? [
          { role: 'assistant', content: rawContent },
          { role: 'user', content: 'La somma dei prezzi degli item non corrisponde al totalAmount. Rileggi attentamente ogni riga del prezzo nella colonna PREZZO(€) e restituisci il JSON corretto.' },
        ] : [
          { role: 'assistant', content: rawContent },
          { role: 'user', content: 'Il JSON precedente è malformato. Restituisci SOLO il JSON corretto senza markdown, backtick o testo extra.' },
        ]),
      ]);
      parsed = parseOcrJson(fallbackRes.choices[0].message.content);
      console.info(`[receipt] OCR ok con fallback ${OCR_MODEL_FALLBACK}`);
    } else {
      parsed = parsedFirst;
    }
  } catch (ocrErr) {
    console.error('[receipt] OCR error:', ocrErr.message);
    await prisma.receipt.update({
      where: { id: receipt.id },
      data:  { status: 'error' },
    }).catch(() => {});
    return error(res, 'Errore durante la lettura dello scontrino', 500);
  }

  // 3b. SANITIZE: l'OCR a volte restituisce la stringa "null"/"N/A" o date non valide.
  //     Senza questa pulizia il salvataggio crasha (es. new Date("Invalid Date")).
  parsed.storeName     = cleanStr(parsed.storeName);
  parsed.storeChain    = cleanStr(parsed.storeChain);
  parsed.storeAddress  = cleanStr(parsed.storeAddress);
  parsed.paymentMethod = cleanStr(parsed.paymentMethod);
  parsed.receiptDate   = cleanDate(parsed.receiptDate);

  // 4. Controllo duplicato: stessa data + stesso negozio + stesso totale + stesso n° prodotti
  //    Se esiste già uno scontrino identico, aggiorna i dati ma NON aggiungere punti.
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  let isDuplicate = false;

  if (parsed.receiptDate && (parsed.storeChain || parsed.storeName) && parsed.totalAmount) {
    const dateFrom = new Date(parsed.receiptDate);
    const dateTo   = new Date(parsed.receiptDate);
    dateTo.setDate(dateTo.getDate() + 1);

    const existing = await prisma.receipt.findFirst({
      where: {
        userId: req.userId,
        id:     { not: receipt.id },   // non sé stesso
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
      // Elimina il record "processing" appena creato, useremo quello esistente
      await prisma.receipt.delete({ where: { id: receipt.id } }).catch(() => {});
      receipt = existing; // punta al record esistente per il resto del flusso
    }
  }

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

  // 7. Assegna punti gamification — solo se NON è un duplicato
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
// ─── Articoli da NON mettere in dispensa (non sono cibo/scorte) ────────────────
function isNonPantryItem(name) {
  const n = name.toLowerCase();
  const blacklist = [
    'busta', 'buste', 'shopper', 'sacchetto', 'sacchetti', 'sacco', 'sacchi',
    'ecologic', 'bio sacc', 'borsa', 'borse', 'shoppers',
    'sporta', 'cassa', 'spesa di servizio', 'servizio',
  ];
  return blacklist.some(w => n.includes(w));
}

// ─── Categoria automatica per la dispensa (niente più "altro" a tappeto) ───────
// Usa STEM (radici) e non parole intere: "banan" copre banana/banane, "albicocc"
// copre albicocca/albicocche, ecc. Così plurali e nomi alterati dall'OCR matchano.
// L'ORDINE conta: le categorie con possibili collisioni (bevande, latticini, carne)
// sono prima di frutta_verdura per evitare es. "aranciata"→frutta o "uova"→altro.
function inferCategory(name) {
  const n = name.toLowerCase();
  const map = [
    ['bevande', ['acqua','vitasn','frizzant','succo','aranciat','limonat','coca-cola','coca cola',' cola',
      'pepsi','birra','vino','spumante','prosecco','tè ',' the ','thè','nescafe','caffe',
      'caffè','ginseng','bibita','energy','gatorade','redbull','gassosa','spremuta',
      'estathe','san benedetto','s.benedetto']],
    ['latticini', ['latte','parmalat','formagg','stracchin','mozzarell','bocconcin','yogurt',
      'yoga ','kefir','muller','müller','burro','panna','ricotta','grana','parmigian',
      'philadelphia','gorgonzola','mascarpone','provol','edamer','emment','fontina',
      'scamorz','uova','uovo']],
    ['carne_pesce', ['pollo','manzo','bovino','maiale','salsicc','hamburg','burger','wurstel',
      'prosciutt','salame','speck','bacon','citterio','mortadella','bresaola','saltimbocca',
      'tonno','salmone','merluzzo','pesce','gamber','filetto','arista','tacchino','fettine',
      'macinato','cotoletta','nugget']],
    ['frutta_verdura', ['mela','mele','banan','pomodor','datter','insalat','patata','patate',
      'cipoll','carota','carote','zucchin','zucca','melanzan','pesca','pesche','nettarin',
      'albicocc','ciliegi','susin','prugn','fragol','mirtill','lampon','uva','kiwi','ananas',
      'melon','angur','arance','arancia tar','limone','limoni','mandarin','clementin',
      'frutta','verdura','spinaci','funghi','champignon','lattuga','finocchi','peperon',
      'broccoli','sedano','rucol','cetriol','rape','bietol','radicchio','cavol','noci',
      'nocciole','mandorle']],
    ['pane_pasta', ['pane','pasta','spaghet','penne','fusill','rigaton','riso','farina','pizza',
      'piadina','pancarre','pancarré','panini','baguette','schiacciat','cracker','grissini',
      'cereali','fette biscottat','lariano','crostat']],
    ['dolci_snack', ['biscott','cioccolat','kinder','merendin','snack','caramell','gelato',
      'torta','nutella','pan di stelle','pandistelle','wafer','barrett','patatine','brioche',
      'cornett','ghiacciol']],
    ['surgelati', ['surgelat','freezer','bastoncini','minestrone surgelato','findus','frosta']],
    ['dispensa', ['olio','aceto','sale','zucchero','passata','pelati','legumi','fagioli',
      'lenticchie','ceci','conserve','sugo','maizena','spezie','dado','cannamela','origano',
      'miele','marmellat','confettura','crema spalmabile']],
    ['igiene_casa', ['carta igienica','c.igienica','detersivo','sapone','shampoo','dentifricio',
      'carta cucina','foxy','scottex','ammorbidente','candeggina','spugn','sgrassatore','det.']],
  ];
  for (const [cat, words] of map) {
    if (words.some(w => n.includes(w))) return cat;
  }
  return 'altro';
}

async function populatePantryFromReceipt(userId, items) {
  // 1. Aggrega gli item dello scontrino per nome normalizzato (lowercase)
  const byKey = new Map();
  for (const item of items) {
    const name = (item.name || item.rawName || '').trim();
    if (!name) continue;
    if (isNonPantryItem(name)) continue;   // salta buste, shopper, sacchetti, ecc.
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
        category: inferCategory(data.name),
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

// ─── Pulizia stringhe/date dall'OCR (difesa da "null"/"N/A"/date invalide) ─────
function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === 'null' || low === 'undefined' || low === 'n/a' || low === 'na' || low === '-') return null;
  return s;
}
function cleanDate(v) {
  const s = cleanStr(v);
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;       // data non valida → null, niente crash
  // scarta date assurde (prima del 2000 o oltre 1 anno nel futuro)
  const year = d.getFullYear();
  if (year < 2000 || year > new Date().getFullYear() + 1) return null;
  return d;
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
