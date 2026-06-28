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
const axios   = require('axios');
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
// Scelta: gpt-4o come primario. Testato sul campo (key di produzione):
//   - openai/gpt-4o          → ~900ms, JSON sempre pulito, vision forte ✓
//   - google/gemini-2.5-pro  → ~4s, è un "thinking model": brucia token nel
//                              ragionamento, lento e a volte tronca il JSON ✗
//   - google/gemini-2.5-flash→ veloce ma sempre thinking, meno prevedibile
// Il problema originale era gpt-4o-MINI (debole), non gpt-4o. gpt-4o risolve
// accuratezza ed è affidabile. Override via env: OCR_MODEL / OCR_MODEL_FALLBACK.
const ON_OPENROUTER      = !!process.env.OPENROUTER_API_KEY;
// Primario: Claude Sonnet 4 — il più FEDELE nell'OCR (gpt-4o tendeva a "indovinare"
// i marchi: FROSTA→Findus/Ringo, LARIANO→Laranjina). Claude trascrive quello che vede.
// Fallback: gpt-4o (modello diverso, secondo parere). Override via env OCR_MODEL.
const OCR_MODEL_ACCURATE = process.env.OCR_MODEL
  || (ON_OPENROUTER ? 'anthropic/claude-sonnet-4' : 'gpt-4o');   // primario (massima fedeltà)
const OCR_MODEL_FALLBACK = process.env.OCR_MODEL_FALLBACK
  || (ON_OPENROUTER ? 'openai/gpt-4o' : 'gpt-4o');               // secondo parere su modello diverso
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
    // 8000 token: uno scontrino con ~90 prodotti sta dentro senza troncare il JSON.
    // Con 4000 gli scontrini lunghi (60+ righe) venivano tagliati a metà → output corrotto.
    max_tokens: 8000,
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

⛔ REGOLA -1 — COSA LEGGERE: Leggi ESCLUSIVAMENTE la striscia di carta dello SCONTRINO. IGNORA TOTALMENTE tutto il resto nell'immagine: quaderni, fogli a quadretti, appunti o formule scritte a mano, libri, tavoli, mani, oggetti sullo sfondo. Se vedi testo scritto a mano, quadretti, disegni, formule matematiche → NON fanno parte dello scontrino, NON includerli come prodotti (es. NON inventare "Blocco Note", "Quaderno", ecc.). Ogni prodotto DEVE provenire da una riga stampata sullo scontrino.

⛔ REGOLA 0 — FEDELTÀ ASSOLUTA AI MARCHI: Trascrivi i nomi ESATTAMENTE come sono stampati. NON sostituire MAI un marchio poco noto con uno più famoso o "più probabile". Errori GRAVISSIMI da NON fare mai: "FROSTA" → "Findus" (SBAGLIATO: resta Frosta), "LARIANO" → "Laranjina" (SBAGLIATO: resta Lariano), "CONSILIA" → "Benedetta" (SBAGLIATO: resta Consilia), "C.M.MEZZE NOCI" → "Mezze Penne" (SBAGLIATO: sono noci, non penne). Se non riconosci un marchio o una parola, lasciala IDENTICA a com'è stampata. NON indovinare, NON "correggere" verso qualcosa di più comune.

0. COLONNE SCONTRINO: Lo scontrino italiano ha tipicamente 3 colonne: DESCRIZIONE | IVA% | Prezzo(€). La colonna IVA contiene percentuali come "4,00%", "10,00%", "22,00%" — NON sono prezzi! Il prezzo è SEMPRE l'ultimo numero sulla riga, nella colonna Prezzo(€). Non confondere mai la percentuale IVA con il prezzo del prodotto.

   ESEMPIO CRITICO — scontrino PIM/Coop/Conad con colonne:
   "BRAVO C.IGIENICA X6   22,00%   2,49"
   → IVA = 22,00% (ignora), Prezzo = 2,49 € ✓  (NON 22,00 €!)
   "C.STRACCHINOI 165G    4,00%    1,89"
   → IVA = 4,00% (ignora), Prezzo = 1,89 € ✓  (NON 4,00 €!)

   REGOLA ANTI-CONFUSIONE: se il "prezzo" che stai per scrivere è uguale a 4, 10 o 22 (con o senza decimali), FERMATI e rileggi la riga — stai quasi certamente leggendo la colonna IVA invece del prezzo reale. Cerca l'ultimo numero sulla riga che NON sia seguito da "%" — quello è il prezzo.

   NOTA: alcuni scontrini (es. PIM) hanno un trattino "-" dopo il prezzo (es. "2,49-"). Il trattino indica che l'IVA è inclusa nel prezzo — ignoralo, il prezzo è 2,49.

   ATTENZIONE PREZZI: Se un prezzo inizia con "4" o "4,xx" o "4.xx" verifica attentamente che non sia una lettura errata del "1" iniziale (es. "1,79" che sembra "4,79" su foto storta). Controlla sempre la coerenza col totale finale.

1. SCONTI SU RIGA SEPARATA — REGOLA CRITICA: una riga è uno SCONTO (non un prodotto) quando ha queste caratteristiche: il PREZZO è NEGATIVO (es. -1,19) OPPURE il testo inizia con parole come "SCONTO", "TAGLIO PREZZO", "VOLANTINO", "PROMO", "RIDUZIONE", "ARTICOLO PREZZO FISSO".
   Uno sconto NON è MAI un item dell'array "items". Va sommato nel campo "discount" del PRODOTTO PRECEDENTE (valore positivo: -1,19 → discount 1.19).
   ⛔ NON inventare righe sconto: includi SOLO gli sconti che vedi DAVVERO stampati su QUESTO scontrino, con il loro importo reale. Non creare "items" con nome "Sconto…"/"Taglio Prezzo"/"Volantino" e prezzo 0. Se non c'è un prodotto precedente chiaro, ignora la riga.
   REGOLA "VOLANTINO XX": il numero dopo VOLANTINO (es. "VOLANTINO 17") è il CODICE dell'offerta, NON l'importo. L'importo è il valore negativo nella colonna Prezzo(€) sulla stessa riga.

2. PRODOTTI DUPLICATI: Unisci in UN SOLO oggetto SOLO se il prodotto ha ESATTAMENTE lo stesso nome E lo stesso prezzo unitario. Due righe con nomi simili ma prezzi diversi sono prodotti DISTINTI — non unire. Esempio: due righe "CONSILIA STRACC.165G 4% 1,89" identiche → un oggetto con quantity:2, unitPrice:1.89, totalPrice:3.78. Ma "CONSILIA STRACC.165G" e "CONSILIA GOCCE 250G" sono prodotti DIVERSI anche se entrambi "Consilia".

3. TOTALE REALE: Il campo "totalAmount" deve essere il totale EFFETTIVAMENTE PAGATO, cioè il SUBTOTALE meno tutti gli sconti post-subtotale (es. "Sconto 10% AH", "SCONTO SOCI", "SCONTO X%"). Se lo scontrino mostra: SUBTOTALE 16,45 → Sconto 10% AH -1,65 → allora totalAmount = 14,80. NON usare il SUBTOTALE come totalAmount se ci sono sconti aggiuntivi dopo.
   Il campo "totalDiscount" include la somma di TUTTI gli sconti (per articolo + globali). Se lo scontrino mostra una riga "RISPARMIATO", "HAI RISPARMIATO", "TOTALE SCONTO" o simile con un importo (es. "-1,19"), usa quel valore come "totalDiscount" (positivo: 1.19). È la fonte più affidabile del risparmio totale — usala quando presente.

3b. NOME NEGOZIO: Leggi l'insegna/brand ESATTAMENTE come è stampato sullo scontrino (es. "IPER TRISCOUNT", "Conad", "Esselunga") — non inventare o correggere l'ortografia. Se è presente anche una ragione sociale generica (es. "SGM Supermercati Srl", "XYZ Srl", "ABC SpA"), combinale: "IPER TRISCOUNT - SGM Supermercati Srl". Se lo scontrino ha SOLO la ragione sociale senza un'insegna riconoscibile, usa solo quella. Priorità: insegna brand > ragione sociale.

4. NOMI PRODOTTI — TRASCRIZIONE FEDELE: il "name" è quello che LEGGI stampato, lettera per lettera. NON è una traduzione né un'interpretazione.
   - NON sostituire un marchio con uno più noto (FROSTA resta Frosta, mai Findus/Ringo; YOGA resta Yoga, mai Yoca; CONSILIA resta Consilia; LARIANO resta Lariano).
   - NON tradurre, NON cambiare plurali/singolari, NON "correggere" parole già chiare (BANANE resta "Banane", non "Bananes"/"Banana").
   - Espandi un'abbreviazione SOLO se è una troncatura ovvia e sicura (es. "PROSC." → "Prosciutto", "C.IGIENICA" → "Carta Igienica"). In tutti gli altri casi, se non sei sicuro, scrivi il testo COSÌ COM'È sullo scontrino: meglio un nome troncato ma vero che un nome inventato.
   - Metti in "rawName" il testo grezzo esatto della riga, sempre.

4b. SEZIONE GASTRONOMIA: Se lo scontrino ha una sezione marcata "GASTRONOMIA" con un prezzo separato (es. "GASTRONOMIA - 7,99 -"), questa è una categoria speciale: i prodotti elencati sotto sono venduti al banco gastronomia. Includi il prodotto con il prefisso "Gastronomia:" nel nome.
   ATTENZIONE — possono esserci PIÙ sezioni "GASTRONOMIA - X,XX -" CONSECUTIVE, ognuna con il proprio header di prezzo e il proprio prodotto. Sono articoli DISTINTI: includili TUTTI, uno per ogni header. Esempio reale:
     "GASTRONOMIA - 7,99 -" → "POLLO ARROSTO 7,99"      → item "Gastronomia: Pollo Arrosto" 7.99
     "GASTRONOMIA - 2,99 -" → "PATATE ARROSTO 2,99"     → item "Gastronomia: Patate Arrosto" 2.99
     "GASTRONOMIA - 2,79 -" → "CIPOLLINE BORETTANE 2,79"→ item "Gastronomia: Cipolline Borettane" 2.79
   NON saltare quella in mezzo: ogni header "GASTRONOMIA - X,XX -" corrisponde a un prodotto da includere.
   Esempi nomi gastronomia: POLLO ARR → "Gastronomia: Pollo Arrosto", PATATE ARR / PATTATE ARR / PAT.ARROSTO → "Gastronomia: Patate Arrosto" (NON "Pattate"), LASAGNE → "Gastronomia: Lasagne", ARISTA → "Gastronomia: Arista", CIPOLLINE BORETTANE → "Gastronomia: Cipolline Borettane".

4c. ALTRI REPARTI (regola CRITICA): la stessa logica vale per QUALSIASI header di reparto con prezzo separato, es. "PANE - 2,09 -", "ORTOFRUTTA - X,XX -", "MACELLERIA - X,XX -", "SALUMERIA - X,XX -". L'header è il REPARTO, NON un prodotto: il prodotto VERO è la riga SOTTO l'header.
   Esempio: "PANE - 2,09 -" seguito da "LARIANO ... 2,09" → l'item è "Lariano" 2.09 (NON "Pane"!). Non mettere MAI il nome del reparto da solo ("Pane", "Ortofrutta", "Gastronomia") come prodotto.

5. COSA ESCLUDERE dagli items: righe IVA, punti fedeltà, resto, buoni pasto, subtotali ("SUBTOTALE"), "DI CUI IVA", "Pagamento elettronico", "Importo pagato", spese di servizio, "OFFERTA"/"OMAGGIO" senza un prezzo prodotto.
   ⛔ ESCLUDI il NOME DELL'OPERATORE/CASSIERE: in alto, tra l'intestazione del negozio e il primo prodotto, c'è spesso un nome di persona con iniziale puntata (es. "DANIELE F.", "MARIO R.") o "OPERATORE"/"CASSA N."/"CASSIERE". NON è un prodotto: NON includerlo MAI (non ha un prezzo prodotto associato).
   ⛔ ESCLUDI i nomi di REPARTO da soli ("PANE", "GASTRONOMIA", "ORTOFRUTTA", "MACELLERIA") — sono header, non prodotti (vedi regola 4c).
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
      "name": "ESATTAMENTE come stampato (solo troncature ovvie espanse, mai marchi sostituiti)",
      "rawName": "testo grezzo esatto della riga",
      "barcode": "codice EAN se presente o null",
      "quantity": 1,
      "unitPrice": 0.00,
      "totalPrice": 0.00,
      "discount": 0.00,
      "discountPercent": null,
      "category": "una tra: frutta_verdura, carne_pesce, latticini, pane_pasta, bevande, dolci_snack, surgelati, dispensa, igiene_casa, altro"
    }
  ],
  "totalAmount": 0.00,
  "totalDiscount": 0.00,
  "paymentMethod": "contanti/carta/buono pasto/misto o null"
}`;

// ─── OCR dedicato (OCR.space) → testo esatto → LLM struttura ──────────────────
// Gli LLM vision "indovinano" sui nomi (Frosta→Findus). Un OCR vero legge i
// caratteri ESATTI. Poi l'LLM struttura SOLO il testo (non l'immagine) → niente
// allucinazioni. Chiave gratuita: registrala su https://ocr.space/ocrapi e
// mettila in OCRSPACE_API_KEY (fallback 'helloworld' per i test).
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

// Prompt che STRUTTURA il testo OCR (già accurato) — non legge immagini.
const STRUCTURE_PROMPT = `Ti do il TESTO GREZZO di uno scontrino italiano, già letto da un OCR affidabile. Il tuo compito è SOLO STRUTTURARLO in JSON. Restituisci SOLO JSON valido.

REGOLE:
1. NON cambiare i nomi: copia "name" ESATTAMENTE come appare nel testo (al massimo espandi una troncatura ovvia, es. "PROSC."→"Prosciutto"). MAI inventare o sostituire marchi (Frosta resta Frosta, Yoga resta Yoga).
2. Ogni riga prodotto è: DESCRIZIONE … IVA% … PREZZO. Il PREZZO è l'ULTIMO numero della riga (es. 3,79). La % IVA (4,00% / 10,00% / 22,00%) NON è un prezzo.
3. SCONTI: una riga con prezzo NEGATIVO (es. -1,50) o che inizia con "SCONTO"/"VOLANTINO"/"PROMO"/"TAGLIO PREZZO" è uno sconto del prodotto PRECEDENTE → mettilo nel suo "discount" (valore positivo). NON è un item separato.
4. REPARTI: header come "PANE - 2,09 -" o "GASTRONOMIA - 11,42 -" NON sono prodotti: il prodotto è la riga SOTTO (es. dopo "PANE - 2,09 -" c'è "LARIANO 2,09" → item "Lariano" 2.09). Per la gastronomia usa prefisso "Gastronomia: ".
5. ESCLUDI: nome operatore/cassiere (es. "DANIELE F."), numero documento, "SUBTOTALE", "TOTALE COMPLESSIVO", "DI CUI IVA", "OFFERTA", "Pagamento", "Importo pagato", righe IVA da sole.
6. "totalAmount" = TOTALE COMPLESSIVO effettivamente pagato. "totalDiscount" = somma di tutti gli sconti.
7. Includi TUTTI i prodotti con un prezzo (anche buste/sacchetti). Non saltarne nessuno.
8. CATEGORIA — per ogni prodotto aggiungi "category" scegliendo ESATTAMENTE una di queste 10 (servono per la dispensa): frutta_verdura, carne_pesce, latticini, pane_pasta, bevande, dolci_snack, surgelati, dispensa, igiene_casa, altro.
   Esempi: Banane/Rucola/Cetrioli/Albicocche→frutta_verdura; Prosciutto/Mortadella/Bacon/Saltimbocca/Tonno→carne_pesce; Parmalat/Yogurt/Stracchino/Edamer/Uova/Müller→latticini; Lariano/Pane/Crostata→pane_pasta; Yoga Succo/Acqua/Nescafe/The→bevande; Kinder→dolci_snack; Frosta Fishburger/surgelati→surgelati; Olio/Sale/Pomodoro/Conserve→dispensa; Detersivo/Carta igienica→igiene_casa. Se davvero incerto: altro.
9. Se un dato manca, usa null. Stessa identica struttura JSON del formato qui sotto.

Struttura JSON: {"storeName":"…","storeChain":"… o null","storeAddress":"… o null","receiptDate":"YYYY-MM-DD o null","items":[{"name":"…","rawName":"riga grezza","quantity":1,"unitPrice":0.00,"totalPrice":0.00,"discount":0.00,"category":"una delle 10"}],"totalAmount":0.00,"totalDiscount":0.00,"paymentMethod":"… o null"}`;

// Pipeline completa: OCR.space → struttura con LLM. Ritorna il JSON parsato, o
// null se OCR.space non è disponibile (così il chiamante usa il vision OCR).
async function tryOcrSpacePipeline(imageBase64) {
  let text;
  try {
    text = await ocrSpaceText(imageBase64);
  } catch (e) {
    console.warn('[receipt] OCR.space non disponibile:', e.message);
    return null;
  }
  if (!text || text.replace(/\s/g, '').length < 40) {
    console.warn('[receipt] OCR.space testo troppo corto → fallback vision');
    return null;
  }
  console.info(`[receipt] OCR.space OK (${text.length} char) → struttura con LLM`);
  const messages = [{ role: 'user', content: `${STRUCTURE_PROMPT}\n\nTESTO SCONTRINO:\n"""\n${text}\n"""` }];
  try {
    let resp;
    try {
      resp = await callOcrApi(OCR_MODEL_ACCURATE, messages);
    } catch {
      resp = await callOcrApi(OCR_MODEL_FALLBACK, messages);
    }
    return parseOcrJson(resp.choices[0].message.content);
  } catch (e) {
    console.warn('[receipt] strutturazione OCR.space fallita → fallback vision:', e.message);
    return null;
  }
}

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
    // ── PASSO 1: OCR dedicato (OCR.space) legge il testo ESATTO → LLM struttura.
    //    È il metodo affidabile: l'LLM non vede l'immagine, quindi non inventa nomi.
    parsed = await tryOcrSpacePipeline(imageBase64);

    // ── PASSO 2: se OCR.space non è disponibile, fallback al vision OCR (come prima).
    if (!parsed) {
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

    // Validazione somma item vs totalAmount: se discrepanza >5% o JSON malformato → fallback modello diverso.
    // Confronta la somma NETTA (totalPrice - sconto per riga) col totale netto:
    // prima confrontava il lordo col netto → falsi fallback sugli scontrini scontati
    // e mascherava gli item davvero saltati.
    const needsFallback = !parsedFirst || (() => {
      const items = Array.isArray(parsedFirst.items) ? parsedFirst.items : [];
      const sumItems = items.reduce((acc, i) =>
        acc + (parseFloat(i.totalPrice) || 0) - (parseFloat(i.discount) || 0), 0);
      const total = parseFloat(parsedFirst.totalAmount) || 0;
      if (total <= 0 || items.length === 0) return false;
      const diff = Math.abs(sumItems - total) / total;
      if (diff > 0.05) {
        console.warn(`[receipt] somma netta item (${sumItems.toFixed(2)}) ≠ total (${total.toFixed(2)}) diff=${(diff*100).toFixed(1)}% → fallback ${OCR_MODEL_FALLBACK}`);
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
          { role: 'user', content: 'La somma dei prezzi degli item non corrisponde al totalAmount. Probabilmente hai SALTATO una o più righe prodotto (controlla in particolare le sezioni "GASTRONOMIA - X,XX -" consecutive: ognuna è un prodotto distinto) oppure hai letto male un prezzo nella colonna PREZZO(€). Rileggi TUTTE le righe, includi ogni prodotto saltato, e restituisci il JSON corretto e completo.' },
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
    } // fine fallback vision OCR (if !parsed)
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

  // 3c. SANITIZE ITEMS: il modello a volte produce FINTE righe "sconto" come se
  //     fossero prodotti (es. "Sconto Soci", "Taglio Prezzo", "Volantino" con prezzo 0)
  //     — a volte rigurgita persino gli esempi dal prompt. Gli sconti veri sono già
  //     nel campo discount dei prodotti reali: queste pseudo-righe vanno rimosse.
  const DISCOUNT_LABEL = /^\s*(scont|taglio?\s*prezz|articolo\s*prezzo\s*fisso|volantin|promo\b|offert|riduzion|buono\s*sconto)/i;
  const items = (Array.isArray(parsed.items) ? parsed.items : []).filter(it => {
    const name = (it?.name || it?.rawName || '').trim();
    if (!name) return false;                         // niente nome → scarta
    const price = parseFloat(it?.totalPrice);
    // È una riga-sconto se il nome è un'etichetta di sconto E non ha un prezzo
    // prodotto valido (>0). I prodotti veri hanno sempre un prezzo positivo.
    if (DISCOUNT_LABEL.test(name) && (!Number.isFinite(price) || price <= 0)) return false;
    return true;
  });
  parsed.items = items;

  // 4. Controllo duplicato: stessa data + stesso negozio + stesso totale + stesso n° prodotti
  //    Se esiste già uno scontrino identico, aggiorna i dati ma NON aggiungere punti.
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

// Categorie valide per la dispensa (devono combaciare col frontend pantryScanner)
const VALID_CATEGORIES = new Set([
  'frutta_verdura', 'carne_pesce', 'latticini', 'pane_pasta', 'bevande',
  'dolci_snack', 'surgelati', 'dispensa', 'igiene_casa', 'altro',
]);

// ─── Categoria automatica per la dispensa (niente più "altro" a tappeto) ───────
// Usa STEM (radici) e non parole intere: "banan" copre banana/banane, "albicocc"
// copre albicocca/albicocche, ecc. Così plurali e nomi alterati dall'OCR matchano.
// L'ORDINE conta: le categorie con possibili collisioni (bevande, latticini, carne)
// sono prima di frutta_verdura per evitare es. "aranciata"→frutta o "uova"→altro.
// (Usato come fallback quando l'LLM non fornisce una categoria valida.)
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
      byKey.set(key, { name, quantity: qty, barcode: item.barcode ?? null, category: item.category ?? null });
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
        // categoria dall'LLM se valida, altrimenti dedotta dal nome (keyword)
        category: VALID_CATEGORIES.has(data.category) ? data.category : inferCategory(data.name),
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
