/**
 * advisor.controller.js — Basket Advisor + Nutri-Budgeting
 *
 * La feature centrale di Shopora: non "la cipolla costa 3 cent in meno",
 * ma "con la TUA spesa ricorrente, dove e come conviene".
 *
 * GET /api/advisor/basket — "Dove ti conviene fare la spesa"
 *   Estrae la spesa tipo dell'utente dagli scontrini (90gg), incrocia con i
 *   prezzi mediani per catena (PriceHistory, 365gg) e calcola il risparmio
 *   stimato per catena sul sottoinsieme di prodotti coperto.
 *
 * GET /api/advisor/health — "Com'è composta la tua spesa"
 *   Analizza la composizione nutrizionale della spesa (categorie keyword-based,
 *   zero costi AI), incrocia con NutritionProfile (dieta, allergeni) e produce
 *   punteggio + consigli deterministici.
 *
 * Entrambi degradano onestamente: se i dati sono pochi lo dicono (coverage),
 * non inventano numeri.
 */

const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { isPremium } = require('../utils/planLimits');

const BASKET_WINDOW_DAYS  = 90;   // finestra per la "spesa tipo" dell'utente
const PRICES_WINDOW_DAYS  = 365;  // finestra per le mediane di PriceHistory
const MIN_PURCHASES       = 2;    // un prodotto è "ricorrente" se comprato ≥2 volte
const MAX_BASKET_PRODUCTS = 50;   // limite prodotti analizzati (i top per spesa)

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Stessa normalizzazione usata da receipt.controller per popolare PriceHistory
function normalizeProductKey(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9àèéìòù\s]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Estrae la "spesa tipo" dell'utente dagli scontrini degli ultimi
 * BASKET_WINDOW_DAYS giorni.
 * @returns {Array<{productKey, name, purchases, medianPaid, totalSpent, avgQuantity}>}
 */
async function getUserBasket(userId) {
  const since = new Date(Date.now() - BASKET_WINDOW_DAYS * 86_400_000);

  const items = await prisma.receiptItem.findMany({
    where: {
      receipt: { userId, status: 'processed' },
      unitPrice: { gt: 0 },
      OR: [
        { receipt: { receiptDate: { gte: since } } },
        // scontrini senza data leggibile: usa la data di elaborazione
        { receipt: { receiptDate: null, processedAt: { gte: since } } },
      ],
    },
    select: {
      name: true, quantity: true, unitPrice: true, totalPrice: true,
      receipt: { select: { storeChain: true } },
    },
  });

  // Raggruppa per productKey
  const groups = new Map();
  for (const it of items) {
    const key = normalizeProductKey(it.name);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { productKey: key, name: it.name, prices: [], quantities: [], totalSpent: 0, chains: new Set() });
    }
    const g = groups.get(key);
    g.prices.push(Number(it.unitPrice));
    g.quantities.push(Number(it.quantity) || 1);
    g.totalSpent += Number(it.totalPrice) || 0;
    if (it.receipt.storeChain) g.chains.add(it.receipt.storeChain);
    // tieni il nome più lungo (di solito il più leggibile)
    if (it.name.length > g.name.length) g.name = it.name;
  }

  return [...groups.values()]
    .filter(g => g.prices.length >= MIN_PURCHASES)
    .map(g => ({
      productKey:  g.productKey,
      name:        g.name,
      purchases:   g.prices.length,
      medianPaid:  round2(median(g.prices)),
      totalSpent:  round2(g.totalSpent),
      avgQuantity: round2(g.quantities.reduce((a, b) => a + b, 0) / g.quantities.length),
      chains:      [...g.chains],
    }))
    .sort((a, b) => b.totalSpent - a.totalSpent)
    .slice(0, MAX_BASKET_PRODUCTS);
}

// ─── GET /api/advisor/basket ──────────────────────────────────────────────────
async function getBasketAdvice(req, res) {
  const basket = await getUserBasket(req.userId);

  if (basket.length === 0) {
    return success(res, {
      basket: [],
      chains: [],
      message: 'Scansiona qualche scontrino per ricevere consigli sulla tua spesa. ' +
               `Servono almeno ${MIN_PURCHASES} acquisti dello stesso prodotto negli ultimi ${BASKET_WINDOW_DAYS} giorni.`,
    });
  }

  // Mediane di prezzo per catena sui productKey della spesa tipo
  const since = new Date(Date.now() - PRICES_WINDOW_DAYS * 86_400_000);
  const history = await prisma.priceHistory.findMany({
    where: {
      productKey: { in: basket.map(b => b.productKey) },
      observedAt: { gte: since },
    },
    select: { productKey: true, storeChain: true, price: true },
  });

  // chain → productKey → [prezzi]
  const byChain = new Map();
  for (const h of history) {
    if (!byChain.has(h.storeChain)) byChain.set(h.storeChain, new Map());
    const m = byChain.get(h.storeChain);
    if (!m.has(h.productKey)) m.set(h.productKey, []);
    m.get(h.productKey).push(Number(h.price));
  }

  // 1. Get processed receipts count in the last 90 days for Option B
  const receiptCount = await prisma.receipt.count({
    where: {
      userId: req.userId,
      status: 'processed',
      OR: [
        { receiptDate: { gte: new Date(Date.now() - BASKET_WINDOW_DAYS * 86_400_000) } },
        { receiptDate: null, processedAt: { gte: new Date(Date.now() - BASKET_WINDOW_DAYS * 86_400_000) } },
      ],
    },
  });
  const totalReceipts = receiptCount || 1;

  // Per ogni catena: risparmio stimato sul sottoinsieme coperto
  const chains = [];
  for (const [chainName, products] of byChain.entries()) {
    let savings90Days = 0;
    let comparableSpend90Days = 0;
    let savingsSingleTrip = 0;
    let comparableSpendSingleTrip = 0;
    const details = [];

    for (const b of basket) {
      const prices = products.get(b.productKey);
      if (!prices) continue;
      const chainMedian = median(prices);
      
      const diffSingle = (b.medianPaid - chainMedian) * b.avgQuantity;
      const diff90Days = diffSingle * b.purchases;
      
      savingsSingleTrip         += diffSingle;
      comparableSpendSingleTrip += b.medianPaid * b.avgQuantity;
      
      savings90Days             += diff90Days;
      comparableSpend90Days     += b.medianPaid * b.avgQuantity * b.purchases;
      
      details.push({
        name:        b.name,
        youPay:      b.medianPaid,
        chainPrice:  round2(chainMedian),
        savingTotal: round2(diff90Days),
      });
    }

    if (details.length === 0) continue;

    const savingPerTripAvg = savings90Days / totalReceipts;
    const comparableSpendPerTripAvg = comparableSpend90Days / totalReceipts;

    chains.push({
      chain:                      chainName,
      coveredProducts:            details.length,
      coveragePct:                Math.round((details.length / basket.length) * 100),
      estimatedSaving:            round2(savings90Days),
      comparableSpend:            round2(comparableSpend90Days),
      savingPerTrip:              round2(savingsSingleTrip),
      comparableSpendPerTrip:     round2(comparableSpendSingleTrip),
      savingPerTripAvg:           round2(savingPerTripAvg),
      comparableSpendPerTripAvg:  round2(comparableSpendPerTripAvg),
      // top 5 prodotti dove risparmi di più in questa catena
      topSavings:                 details.sort((a, b) => b.savingTotal - a.savingTotal).slice(0, 5),
    });
  }

  // Ordina per risparmio per spesa decrescente (Opzione A)
  chains.sort((a, b) => b.savingPerTrip - a.savingPerTrip);

  const best = chains.find(ch => ch.savingPerTrip > 0);
  const message = best
    ? `Facendo la spesa da ${best.chain} risparmieresti circa €${best.savingPerTrip.toFixed(2)} a spesa ` +
      `(circa €${best.estimatedSaving.toFixed(2)} totali negli ultimi ${BASKET_WINDOW_DAYS} giorni) ` +
      `sui ${best.coveredProducts} prodotti confrontabili della tua spesa tipo.`
    : 'Stai già facendo la spesa nelle catene più convenienti per i tuoi prodotti, ' +
      'oppure non ci sono ancora abbastanza dati di confronto.';

  return success(res, {
    windowDays:  BASKET_WINDOW_DAYS,
    basketSize:  basket.length,
    basket:      basket.map(({ chains: _c, ...b }) => b), // chains interno non serve al client
    chains,
    message,
  });
}

// ─── Categorie nutrizionali (keyword-based, italiano) ────────────────────────
// Deterministico e gratis: niente chiamate AI. Le keyword coprono i nomi
// espansi dall'OCR (che già normalizza le abbreviazioni in italiano leggibile).
const HEALTH_CATEGORIES = [
  { id: 'verdura',        label: 'Verdura',                healthy: true,  keywords: ['zucchin', 'carot', 'pomodor', 'insalat', 'lattug', 'spinaci', 'broccol', 'cavol', 'zucca', 'melanzan', 'peperon', 'cipoll', 'aglio', 'finocchi', 'sedano', 'asparag', 'carciof', 'funghi', 'champignon', 'rucola', 'verdur', 'bietol', 'catalogna', 'agretti', 'barbabietol', 'porro', 'cetriol', 'radicchi'] },
  { id: 'frutta',         label: 'Frutta',                 healthy: true,  keywords: ['mela', 'mele ', 'banan', 'aranc', 'clementin', 'mandarin', 'pera', 'pere ', 'pesca', 'pesche', 'albicocc', 'fragol', 'uva', 'kiwi', 'anana', 'limon', 'melone', 'anguria', 'frutti di bosco', 'mirtill', 'lampon', 'avocado', 'cachi', 'fichi', 'prugn', 'ciliegi', 'pompelm', 'frutta'] },
  { id: 'proteine',       label: 'Carne, pesce e uova',    healthy: true,  keywords: ['pollo', 'tacchin', 'manzo', 'bovino', 'suino', 'maiale', 'vitell', 'hamburger', 'salmone', 'tonno', 'merluzz', 'branzino', 'orata', 'acciugh', 'alici', 'pesce', 'gamber', 'uova', 'uovo', 'albume', 'bresaola', 'prosciutto crudo', 'fesa ', 'arrosto', 'polpett', 'biancostato', 'cappone', 'trita'] },
  { id: 'latticini',      label: 'Latticini e formaggi',   healthy: null,  keywords: ['latte', 'yogurt', 'formagg', 'mozzarell', 'parmigian', 'grana', 'pecorino', 'ricotta', 'burro', 'panna', 'stracchino', 'scamorza', 'provola', 'mascarpone', 'gorgonzola', 'bocconcin', 'kefir'] },
  { id: 'cereali',        label: 'Pane, pasta e cereali',  healthy: null,  keywords: ['pane', 'pasta', 'spaghetti', 'penne', 'fusilli', 'riso ', 'riso,', 'farina', 'pancarr', 'baguette', 'piadin', 'tagliatelle', 'fettuccine', 'casarecce', 'cereali', 'avena', 'orzo', 'farro', 'couscous', 'gnocchi', 'sfoglia', 'crackers', 'grissin', 'fette biscottate', 'brezel', 'polenta', 'lenticchie', 'ceci', 'fagiol', 'legumi'] },
  { id: 'dolci_snack',    label: 'Dolci e snack',          healthy: false, keywords: ['biscott', 'cioccolat', 'merendin', 'snack', 'patatine', 'pringles', 'caramell', 'torta', 'gelato', 'brioche', 'croissant', 'crema spalmabile', 'nutella', 'wafer', 'crostata', 'budino', 'marmellata', 'miele', 'zucchero', 'dolce', 'frollini', 'pan di stelle'] },
  { id: 'bevande_zucch',  label: 'Bevande zuccherate',     healthy: false, keywords: ['cola', 'aranciata', 'gassata', 'energy', 'succo', 'the freddo', 'tè freddo', 'ginger', 'tonica', 'spuma', 'chinotto'] },
  { id: 'alcolici',       label: 'Alcolici',               healthy: false, keywords: ['birra', 'vino', 'prosecco', 'spumante', 'amaro', 'liquore', 'gin ', 'vodka', 'whisky', 'rum '] },
  { id: 'surgelati_pronti', label: 'Surgelati e piatti pronti', healthy: false, keywords: ['surgelat', 'bastoncini', 'cordon bleu', 'sofficini', 'pizza surg', 'piatto pronto', 'anelli di cipolla', 'patatine fritte surg', 'nuggets'] },
  { id: 'salumi',         label: 'Salumi e insaccati',     healthy: false, keywords: ['salame', 'mortadella', 'wurstel', 'würstel', 'pancetta', 'speck', 'salsiccia', 'coppa', 'sottilissime', 'petali', 'affettat', 'cotto'] },
  { id: 'condimenti',     label: 'Condimenti e dispensa',  healthy: null,  keywords: ['olio', 'aceto', 'sale', 'pepe', 'spezie', 'pesto', 'sugo', 'passata', 'maionese', 'ketchup', 'senape', 'dado', 'brodo', 'capperi', 'olive', 'alloro', 'basilico', 'origano', 'rosmarino'] },
  { id: 'acqua_bevande',  label: 'Acqua e bevande sane',   healthy: true,  keywords: ['acqua', 'caffè', 'caffe', 'tè ', 'the ', 'camomilla', 'tisana', 'bevanda avena', 'bevanda riso', 'bevanda mandorla', 'bevanda soia'] },
];

// Profilo macro tipico per categoria (% delle calorie da carboidrati/proteine/
// grassi). Valori indicativi da composizione media della categoria — servono
// per la STIMA della ripartizione macro pesata sulla spesa, non per grammi reali.
const MACRO_PROFILES = {
  verdura:          { carbs: 60, protein: 25, fat: 15 },
  frutta:           { carbs: 90, protein: 5,  fat: 5  },
  proteine:         { carbs: 5,  protein: 50, fat: 45 },
  latticini:        { carbs: 20, protein: 25, fat: 55 },
  cereali:          { carbs: 75, protein: 12, fat: 13 },
  dolci_snack:      { carbs: 55, protein: 5,  fat: 40 },
  bevande_zucch:    { carbs: 100, protein: 0, fat: 0  },
  alcolici:         { carbs: 100, protein: 0, fat: 0  }, // calorie da alcol assimilate ai carb
  surgelati_pronti: { carbs: 45, protein: 15, fat: 40 },
  salumi:           { carbs: 5,  protein: 35, fat: 60 },
  condimenti:       { carbs: 15, protein: 5,  fat: 80 },
  altro:            { carbs: 50, protein: 20, fat: 30 },
  // acqua_bevande: escluso — calorie trascurabili
};

// Keyword non alimentari: escluse dall'analisi salute
const NON_FOOD_KEYWORDS = ['carta igienica', 'detersiv', 'sapone', 'shampoo', 'bagnoschiuma', 'balsamo', 'dentifricio', 'spazzolino', 'assorbent', 'pannolin', 'shopper', 'sacchett', 'tovagliol', 'fazzolett', 'piatti di', 'bicchieri di', 'alluminio', 'pellicola', 'candeggina', 'ammorbident', 'sgrassator', 'durex', 'settebello', 'deodorante', 'rasoio', 'lamette', 'cotone', 'salvy', 'struc'];

function categorizeItem(name) {
  const n = ` ${name.toLowerCase()} `;
  if (NON_FOOD_KEYWORDS.some(k => n.includes(k))) return 'non_food';
  for (const cat of HEALTH_CATEGORIES) {
    if (cat.keywords.some(k => n.includes(k))) return cat.id;
  }
  return 'altro';
}

// ─── GET /api/advisor/health ──────────────────────────────────────────────────
async function getHealthAdvice(req, res) {
  const since = new Date(Date.now() - BASKET_WINDOW_DAYS * 86_400_000);

  const [items, profile] = await Promise.all([
    prisma.receiptItem.findMany({
      where: {
        receipt: { userId: req.userId, status: 'processed' },
        totalPrice: { gt: 0 },
        OR: [
          { receipt: { receiptDate: { gte: since } } },
          { receipt: { receiptDate: null, processedAt: { gte: since } } },
        ],
      },
      select: { name: true, totalPrice: true },
    }),
    prisma.nutritionProfile.findUnique({ where: { userId: req.userId } }),
  ]);

  if (items.length === 0) {
    return success(res, {
      composition: [],
      healthScore: null,
      advice: ['Scansiona qualche scontrino per ricevere l\'analisi nutrizionale della tua spesa.'],
    });
  }

  // Composizione: % di spesa per categoria (solo alimentari)
  const spendByCat = new Map();
  let foodSpend = 0;
  let nonFoodSpend = 0;

  for (const it of items) {
    const cat = categorizeItem(it.name);
    const amount = Number(it.totalPrice);
    if (cat === 'non_food') { nonFoodSpend += amount; continue; }
    foodSpend += amount;
    spendByCat.set(cat, (spendByCat.get(cat) || 0) + amount);
  }

  if (foodSpend === 0) {
    return success(res, {
      composition: [],
      healthScore: null,
      advice: ['Nei tuoi scontrini non ho trovato prodotti alimentari da analizzare.'],
    });
  }

  const catById = Object.fromEntries(HEALTH_CATEGORIES.map(c => [c.id, c]));
  const composition = [...spendByCat.entries()]
    .map(([id, spend]) => ({
      category: id,
      label:    catById[id]?.label ?? 'Altro',
      spend:    round2(spend),
      pct:      Math.round((spend / foodSpend) * 100),
      healthy:  catById[id]?.healthy ?? null,
    }))
    .sort((a, b) => b.spend - a.spend);

  // Indicatori chiave
  const pctOf = id => composition.find(c => c.category === id)?.pct ?? 0;
  const freshPct     = pctOf('verdura') + pctOf('frutta');                       // target ≥ 25%
  const proteinPct   = pctOf('proteine');                                        // target 15-30%
  const junkPct      = pctOf('dolci_snack') + pctOf('bevande_zucch')
                     + pctOf('surgelati_pronti');                                // target ≤ 15%
  const alcoholPct   = pctOf('alcolici');                                        // target ≤ 5%
  const processedMeatPct = pctOf('salumi');                                      // target ≤ 5%

  // Health score 0-100: parte da 100 e penalizza gli scostamenti dai target
  let score = 100;
  if (freshPct < 25)         score -= Math.min(30, (25 - freshPct) * 1.2);
  if (junkPct > 15)          score -= Math.min(30, (junkPct - 15) * 1.5);
  if (alcoholPct > 5)        score -= Math.min(15, (alcoholPct - 5) * 2);
  if (processedMeatPct > 5)  score -= Math.min(15, (processedMeatPct - 5) * 1.5);
  if (proteinPct < 10)       score -= 10;
  score = Math.max(0, Math.round(score));

  // Consigli deterministici basati sugli scostamenti
  const advice = [];
  if (freshPct < 25) {
    advice.push(`Frutta e verdura sono solo il ${freshPct}% della tua spesa alimentare (consigliato: almeno 25%). Prova ad aggiungere 2-3 prodotti freschi a ogni spesa.`);
  } else {
    advice.push(`Ottimo: frutta e verdura sono il ${freshPct}% della tua spesa alimentare. 👏`);
  }
  if (junkPct > 15) {
    advice.push(`Dolci, snack, bibite zuccherate e piatti pronti pesano il ${junkPct}% (consigliato: sotto il 15%). È anche la voce dove si risparmia di più tagliando.`);
  }
  if (alcoholPct > 5) {
    advice.push(`Gli alcolici sono il ${alcoholPct}% della spesa alimentare.`);
  }
  if (processedMeatPct > 5) {
    advice.push(`I salumi pesano il ${processedMeatPct}%: sostituirne una parte con carne fresca o legumi migliora il profilo nutrizionale e spesso costa meno.`);
  }
  if (proteinPct < 10) {
    advice.push(`Le fonti proteiche fresche (carne, pesce, uova) sono solo il ${proteinPct}%: valuta se integrare, anche con i legumi che costano poco.`);
  }

  // Incrocio col profilo nutrizionale dell'utente
  const profileFlags = [];
  if (profile?.dietType?.length) {
    const diet = profile.dietType.map(d => d.toLowerCase());
    if ((diet.includes('vegan') || diet.includes('vegano')) && (proteinPct > 0 || pctOf('latticini') > 0 || processedMeatPct > 0)) {
      profileFlags.push('Il tuo profilo è vegano ma negli scontrini compaiono prodotti animali.');
    } else if ((diet.includes('vegetarian') || diet.includes('vegetariano')) && (proteinPct > 0 || processedMeatPct > 0)) {
      const meatItems = items.filter(i => ['proteine', 'salumi'].includes(categorizeItem(i.name)) && !/uova|uovo|albume/.test(i.name.toLowerCase()));
      if (meatItems.length > 0) {
        profileFlags.push(`Il tuo profilo è vegetariano ma negli scontrini compaiono ${meatItems.length} prodotti a base di carne o pesce.`);
      }
    }
  }
  if (profile?.allergens?.length) {
    for (const allergen of profile.allergens) {
      const a = allergen.toLowerCase();
      const hits = items.filter(i => i.name.toLowerCase().includes(a));
      if (hits.length > 0) {
        profileFlags.push(`⚠️ Allergene "${allergen}" trovato in ${hits.length} prodotti acquistati (es. "${hits[0].name}").`);
      }
    }
  }

  // ── Stima ripartizione macro settimanale ────────────────────────────────
  // Pesa il profilo macro di ogni categoria per la sua quota di spesa.
  // È una STIMA indicativa (la spesa non equivale ai grammi consumati), ma
  // mostra in modo affidabile gli sbilanciamenti (es. "troppe calorie da
  // zuccheri"). Per grammi precisi servirebbe il barcode di ogni prodotto.
  let macroBase = 0;
  const macroAcc = { carbs: 0, protein: 0, fat: 0 };
  for (const [catId, spend] of spendByCat.entries()) {
    const profile = MACRO_PROFILES[catId];
    if (!profile) continue; // acqua_bevande: escluso
    macroBase        += spend;
    macroAcc.carbs   += spend * profile.carbs;
    macroAcc.protein += spend * profile.protein;
    macroAcc.fat     += spend * profile.fat;
  }
  const macroEstimate = macroBase > 0 ? {
    carbsPct:   Math.round(macroAcc.carbs   / macroBase),
    proteinPct: Math.round(macroAcc.protein / macroBase),
    fatPct:     Math.round(macroAcc.fat     / macroBase),
    // quota di calorie da fonti ad alto zucchero (dolci + bibite + alcol)
    sugarSourcesPct: Math.round(((spendByCat.get('dolci_snack') || 0)
                               + (spendByCat.get('bevande_zucch') || 0)
                               + (spendByCat.get('alcolici') || 0)) / macroBase * 100),
    method: 'spend_weighted',
    note:   'Stima basata sulla composizione della spesa, non su grammature reali. ' +
            'Indica gli sbilanciamenti, non i grammi esatti.',
  } : null;

  // Consigli macro
  if (macroEstimate) {
    if (macroEstimate.proteinPct < 15) {
      advice.push(`Stima macro: solo ~${macroEstimate.proteinPct}% delle calorie della tua spesa viene da proteine (consigliato: 15-25%).`);
    }
    if (macroEstimate.sugarSourcesPct > 20) {
      advice.push(`~${macroEstimate.sugarSourcesPct}% delle calorie stimata viene da fonti zuccherine o alcoliche.`);
    }
  }

  // Vista settimanale: spesa alimentare media a settimana nella finestra
  const weeks = Math.max(1, Math.round(BASKET_WINDOW_DAYS / 7));
  const weekly = {
    weeks,
    avgFoodSpendPerWeek: round2(foodSpend / weeks),
    avgItemsPerWeek:     Math.round(items.length / weeks),
  };

  return success(res, {
    windowDays:    BASKET_WINDOW_DAYS,
    itemsAnalyzed: items.length,
    foodSpend:     round2(foodSpend),
    nonFoodSpend:  round2(nonFoodSpend),
    healthScore:   score,
    composition,
    indicators: {
      freshPct, proteinPct, junkPct, alcoholPct, processedMeatPct,
    },
    weekly,
    macroEstimate,
    advice,
    profileFlags,
  });
}

/**
 * GET /api/advisor/associations
 *
 * Association Rules (co-occurrence) sui receipt item di TUTTI gli utenti:
 * "chi compra X compra anche Y spesso" → suggerisce prodotti che l'utente
 * non acquista ma che compaiono frequentemente sugli stessi scontrini dei
 * prodotti che già compra.
 *
 * Confidence = co-occurrences(X,Y) / receipts_containing(X)
 * Soglie minime: confidence ≥ 0.30 e count ≥ 2 per evitare falsi positivi
 * con pochi dati.
 */
async function getAssociations(req, res) {
  if (!await isPremium(req.userId)) {
    return error(res, 'I suggerimenti "cosa stai dimenticando" sono una funzione Premium. Abbonati a Shopora Premium.', 403);
  }

  const userId = req.userId;
  const since  = new Date(Date.now() - BASKET_WINDOW_DAYS * 24 * 3600 * 1000);

  // 1. Prodotti ricorrenti dell'utente — usa name normalizzato come chiave
  const userItems = await prisma.receiptItem.findMany({
    where: { receipt: { userId, receiptDate: { gte: since } } },
    select: { name: true },
  });

  const userKeys = [...new Set(
    userItems.map(i => i.name?.toLowerCase().trim()).filter(Boolean),
  )];

  if (!userKeys.length) {
    return success(res, {
      associations: [],
      message: 'Scansiona qualche scontrino per ricevere suggerimenti personalizzati.',
    });
  }

  // 2. Scontrini che contengono prodotti dell'utente
  const seedRows = await prisma.receiptItem.findMany({
    where: { name: { in: userKeys.map(k => k), mode: 'insensitive' } },
    select: { receiptId: true, name: true },
  });

  const seedToReceipts = {};
  for (const { receiptId, name } of seedRows) {
    const key = name.toLowerCase().trim();
    if (!seedToReceipts[key]) seedToReceipts[key] = new Set();
    seedToReceipts[key].add(receiptId);
  }

  const receiptIds = [...new Set(seedRows.map(r => r.receiptId))];
  if (!receiptIds.length) {
    return success(res, { associations: [], message: 'Dati insufficienti per generare suggerimenti.' });
  }

  // 3. Prodotti co-presenti su quegli scontrini
  const coRows = await prisma.receiptItem.findMany({
    where: { receiptId: { in: receiptIds } },
    select: { receiptId: true, name: true },
  });

  const pairCount  = {};
  const targetName = {};

  for (const { receiptId, name } of coRows) {
    const target = name.toLowerCase().trim();
    if (userKeys.includes(target)) continue;
    targetName[target] = name;
    for (const [seed, receipts] of Object.entries(seedToReceipts)) {
      if (receipts.has(receiptId)) {
        const key = `${seed}||${target}`;
        pairCount[key] = (pairCount[key] || 0) + 1;
      }
    }
  }

  const best = {};
  for (const [key, count] of Object.entries(pairCount)) {
    const [seed, target] = key.split('||');
    const confidence = count / seedToReceipts[seed].size;
    if (!best[target] || confidence > best[target].confidence) {
      best[target] = { target, name: targetName[target], confidence, count, seed };
    }
  }

  const associations = Object.values(best)
    .filter(a => a.confidence >= 0.3 && a.count >= 2)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 12)
    .map(a => ({
      productKey:    a.target,
      name:          a.name,
      confidence:    Math.round(a.confidence * 100),
      count:         a.count,
      becauseYouBuy: a.seed,
    }));

  return success(res, {
    associations,
    userProductCount: userKeys.length,
    message: associations.length
      ? `${associations.length} prodotti che potresti aggiungere alla tua spesa`
      : 'Ancora troppo pochi scontrini in comune con altri utenti per generare suggerimenti.',
  });
}

module.exports = { getBasketAdvice, getHealthAdvice, getAssociations };
