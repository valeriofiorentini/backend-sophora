/**
 * Prompt AI della dispensa — estratti da pantry.controller (spostamento puro).
 *
 * PANTRY_SCAN_PROMPT   → scansione foto dispensa (vision).
 * buildRecipesPrompt   → suggerimento ricette da quello che c'è.
 * buildShoppingPrompt  → lista spesa per un obiettivo.
 *
 * L'istruzione di lingua usa langName (utils/lang), condivisa con chat/pantry.
 */
const { langName } = require('../utils/lang');

function pantryLangInstruction(code) {
  return `Scrivi nomi, istruzioni e consigli SEMPRE in ${langName(code)}.`;
}

const PANTRY_SCAN_PROMPT = `Sei un esperto di alimentazione italiana. Analizza l'immagine (frigo, credenza o dispensa) e restituisci SOLO un JSON valido.

Identifica TUTTI i prodotti alimentari visibili, anche parzialmente.

Per ogni prodotto stima:
- nome in italiano chiaro e completo (es. "Latte intero", "Mozzarella fiordilatte", "Pasta penne rigate")
- categoria tra le seguenti (scegli quella più adatta):
  • latticini → latte, yogurt, formaggio, mozzarella, burro, panna, ricotta, uova
  • verdure → ortaggi freschi o in busta, insalata, pomodori, zucchine, carote
  • frutta → frutta fresca o in busta
  • carne → carne fresca, salumi, prosciutto, wurstel, mortadella, pollo crudo
  • pesce → pesce fresco, tonno in scatola, salmone, acciughe, merluzzo
  • pasta → pasta secca, pasta fresca, riso, gnocchi, cous cous, cereali da cucina
  • pane → pane, panini, grissini, crackers, fette biscottate, piadine, focaccia
  • condimenti → olio, aceto, sale, zucchero, salse, ketchup, maionese, pesto, sughi, spezie
  • scatolame → conserve, legumi in scatola, pelati, passata, tonno in scatola, cibo in lattina
  • bevande → acqua, succhi, bibite, birra, vino, caffè, tè, latte UHT
  • dolci → biscotti, merendine, cioccolato, caramelle, gelato, torte, crostate, snack dolci
  • surgelati → qualsiasi prodotto congelato: pizza surgelata, pizza farcita, supplì, arancini, crocchette, cotolette, sofficini, verdure surgelate, minestre surgelate, piatti pronti surgelati, gelati, ghiaccioli
  • altro → solo se non rientra in nessuna delle categorie sopra
- quantità approssimativa visibile (numero)
- unità di misura: kg | g | l | ml | pz | conf
- scadenza se leggibile sulle confezioni: "YYYY-MM-DD" oppure null
- note opzionali (es. "aperto", "quasi finito", "confezione integra")

Struttura JSON:
{
  "items": [
    {
      "name": "nome prodotto",
      "category": "categoria",
      "quantity": 1,
      "unit": "pz",
      "expiresAt": null,
      "notes": null
    }
  ],
  "summary": "Breve descrizione di cosa c'è in dispensa in 1 frase"
}

Se l'immagine non mostra cibo o è illeggibile, restituisci {"items": [], "summary": "Nessun prodotto identificato"}.`;

// Ricette da quello che c'è in dispensa.
function buildRecipesPrompt({ pantryList, people, mealType, dietContext, langCode }) {
  return `Sei un cuoco italiano esperto. L'utente ha questi prodotti in dispensa:

${pantryList}

Contesto: ${people} persone, ${mealType}${dietContext ? `, ${dietContext}` : ''}.

Suggerisci 3 ricette REALISTICHE usando PRINCIPALMENTE i prodotti disponibili (puoi assumere che abbia sale, olio, pepe e spezie base).

Per ogni ricetta indica:
- nome piatto
- tempo di preparazione in minuti
- difficoltà: facile | media | difficile
- ingredienti dalla dispensa usati (con quantità)
- ingredienti mancanti da comprare (lista concisa)
- istruzioni in 3-5 step sintetici
- stima calorie per porzione

Dai priorità ai prodotti con scadenza più vicina.
${pantryLangInstruction(langCode)}

Rispondi SOLO in JSON:
{
  "recipes": [
    {
      "name": "Nome piatto",
      "time_minutes": 20,
      "difficulty": "facile",
      "ingredients_available": ["item1 (100g)", "item2 (2 pz)"],
      "ingredients_missing": ["item mancante 1"],
      "steps": ["Step 1...", "Step 2..."],
      "calories_per_serving": 450,
      "tip": "Consiglio dello chef"
    }
  ]
}`;
}

// Lista spesa per raggiungere un obiettivo, escludendo ciò che è già in dispensa.
function buildShoppingPrompt({ goal, pantryList, dietContext, langCode }) {
  return `Sei un esperto nutrizionista e pianificatore della spesa italiano.

Obiettivo dell'utente: "${goal}"
Prodotti già in dispensa: ${pantryList}
${dietContext}

Genera una lista della spesa OTTIMALE per raggiungere l'obiettivo, escludendo ciò che è già in dispensa.

Raggruppa per reparto supermercato. Per ogni prodotto indica:
- nome preciso come appare in supermercato
- quantità consigliata
- perché è utile (brevissimo)

${pantryLangInstruction(langCode)}

Rispondi SOLO in JSON:
{
  "summary": "In 1 frase cosa compra e perché",
  "estimated_cost": 55.00,
  "sections": [
    {
      "label": "🥩 Carne e pesce",
      "items": [
        { "name": "Petto di pollo", "quantity": "500g", "why": "proteine principali" }
      ]
    }
  ]
}`;
}

module.exports = { PANTRY_SCAN_PROMPT, buildRecipesPrompt, buildShoppingPrompt };
