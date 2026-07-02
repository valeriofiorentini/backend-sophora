/**
 * pantrySync.service — sincronizzazione dispensa dagli scontrini.
 * Estratto da receipt.controller (spostamento puro, nessun cambio di logica).
 */

const prisma = require('../config/database');
const { clampQuantity } = require('../utils/sanitize');

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
// Usa STEM (radici) e non parole intere: "banan" copre banana/banane, ecc.
// L'ORDINE conta: le categorie con possibili collisioni (bevande, latticini, carne)
// sono prima di frutta_verdura. Usato come fallback quando l'LLM non fornisce
// una categoria valida.
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

/**
 * Popola la dispensa con i prodotti estratti dallo scontrino.
 *
 * Versione batch: 1 findMany + 1 createMany + N update in un'unica transaction.
 * Dedup case-insensitive tra item dello scontrino e con la dispensa esistente.
 * sourceReceiptId evita il raddoppio quantità su riscansione dello stesso
 * scontrino: gli item già aggiunti da questo scan vengono saltati, quelli
 * mancanti (prima OCR incompleta) vengono aggiunti.
 */
async function populatePantryFromReceipt(userId, items, receiptId) {
  // 1. Aggrega gli item dello scontrino per nome normalizzato (lowercase)
  const byKey = new Map();
  for (const item of items) {
    const name = (item.name || item.rawName || '').trim();
    if (!name) continue;
    if (isNonPantryItem(name)) continue;
    const key = name.toLowerCase();
    const qty = clampQuantity(item.quantity);
    if (byKey.has(key)) {
      byKey.get(key).quantity += qty;
    } else {
      byKey.set(key, { name, quantity: qty, barcode: item.barcode ?? null, category: item.category ?? null });
    }
  }
  if (byKey.size === 0) return;

  // 2. Leggi dispensa esistente + quali item vengono già da questo scontrino
  const existing = await prisma.pantryItem.findMany({
    where:  { userId },
    select: { id: true, name: true, quantity: true, sourceReceiptId: true },
  });
  const existingByKey = new Map(existing.map(e => [e.name.trim().toLowerCase(), e]));

  const toCreate = [];
  const updates  = [];
  const now      = new Date();

  for (const [key, data] of byKey) {
    const match = existingByKey.get(key);

    if (match) {
      // Già in dispensa: se viene da questo stesso scontrino → skip (no raddoppio).
      // Se da altra fonte → aggiorna sourceReceiptId senza sommare la quantità.
      if (match.sourceReceiptId === receiptId) continue;
      updates.push(
        prisma.pantryItem.update({
          where: { id: match.id },
          data:  { sourceReceiptId: receiptId, inStock: true, updatedAt: now },
        }),
      );
    } else {
      toCreate.push({
        userId,
        name:           data.name,
        category:       VALID_CATEGORIES.has(data.category) ? data.category : inferCategory(data.name),
        quantity:       data.quantity,
        unit:           'pz',
        barcode:        data.barcode,
        inStock:        true,
        source:         'receipt',
        sourceReceiptId: receiptId ?? null,
      });
    }
  }

  const ops = [];
  if (toCreate.length > 0) {
    ops.push(prisma.pantryItem.createMany({ data: toCreate, skipDuplicates: true }));
  }
  ops.push(...updates);
  if (ops.length > 0) await prisma.$transaction(ops);
}

module.exports = { populatePantryFromReceipt, isNonPantryItem, inferCategory, VALID_CATEGORIES };
