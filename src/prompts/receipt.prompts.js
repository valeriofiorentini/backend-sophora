/**
 * Prompt OCR scontrini — estratti da receipt.controller (spostamento puro).
 *
 * RECEIPT_PROMPT   → usato sia in modalità vision pura sia in modalità ibrida
 *                    (testo OCR + immagine) da receiptOcr.service.
 * STRUCTURE_PROMPT → attualmente NON usato: documenta l'approccio alternativo
 *                    "solo testo" (struttura il testo OCR senza rivedere
 *                    l'immagine). Conservato come riferimento.
 */

const RECEIPT_PROMPT = `Sei un esperto di scontrini italiani. Analizza l'immagine e restituisci SOLO un JSON valido.

REGOLE CRITICHE — seguile nell'ordine:

⛔ REGOLA -1 — COSA LEGGERE: Leggi ESCLUSIVAMENTE la striscia di carta dello SCONTRINO. IGNORA TOTALMENTE tutto il resto nell'immagine: quaderni, fogli a quadretti, appunti o formule scritte a mano, libri, tavoli, mani, oggetti sullo sfondo. Se vedi testo scritto a mano, quadretti, disegni, formule matematiche → NON fanno parte dello scontrino, NON includerli come prodotti (es. NON inventare "Blocco Note", "Quaderno", ecc.). Ogni prodotto DEVE provenire da una riga stampata sullo scontrino.

⛔ REGOLA 0 — FEDELTÀ ASSOLUTA AI MARCHI: Trascrivi i nomi ESATTAMENTE come sono stampati. NON sostituire MAI un marchio poco noto con uno più famoso o "più probabile". Errori GRAVISSIMI da NON fare mai: "FROSTA" → "Findus" (SBAGLIATO: resta Frosta), "LARIANO" → "Laranjina" (SBAGLIATO: resta Lariano), "CONSILIA" → "Benedetta" (SBAGLIATO: resta Consilia), "C.M.MEZZE NOCI" → "Mezze Penne" (SBAGLIATO: sono noci, non penne), "TIKO MERLUZZO" → "Vivo Merluzzo" (SBAGLIATO: resta Tiko), "MONOP.PET.TAC" → "Monge Pet Tac" (SBAGLIATO: resta Monop, è un'abbreviazione non un brand noto), "CURTIRISO INT.2X500G" → "Corticoso Ini 200500G" (SBAGLIATO: resta Curtiriso Int. 2X500G, non fondere le cifre della quantità), "LA MADIA NOCI" → "La Magia Noci" (SBAGLIATO: resta Madia), "RE PIATTI PIANI RIUT" → "Re Patate Piani Blu" (SBAGLIATO: "Piatti" non è "Patate", "Riut" è probabilmente "Riutilizzabili" troncato, non "Blu"). Se non riconosci un marchio o una parola, lasciala IDENTICA a com'è stampata. NON indovinare, NON "correggere" verso qualcosa di più comune.

0. COLONNE SCONTRINO: Lo scontrino italiano ha tipicamente 3 colonne: DESCRIZIONE | IVA% | Prezzo(€). La colonna IVA contiene percentuali come "4,00%", "10,00%", "22,00%" — NON sono prezzi! Il prezzo è SEMPRE l'ultimo numero sulla riga, nella colonna Prezzo(€). Non confondere mai la percentuale IVA con il prezzo del prodotto.

   ESEMPIO CRITICO — scontrino PIM/Coop/Conad con colonne:
   "BRAVO C.IGIENICA X6   22,00%   2,49"
   → IVA = 22,00% (ignora), Prezzo = 2,49 € ✓  (NON 22,00 €!)
   "C.STRACCHINOI 165G    4,00%    1,89"
   → IVA = 4,00% (ignora), Prezzo = 1,89 € ✓  (NON 4,00 €!)

   REGOLA ANTI-CONFUSIONE: se il "prezzo" che stai per scrivere è uguale a 4, 10 o 22 (con o senza decimali), FERMATI e rileggi la riga — stai quasi certamente leggendo la colonna IVA invece del prezzo reale. Cerca l'ultimo numero sulla riga che NON sia seguito da "%" — quello è il prezzo.

   NOTA: alcuni scontrini (es. PIM) hanno un trattino "-" dopo il prezzo (es. "2,49-"). Il trattino indica che l'IVA è inclusa nel prezzo — ignoralo, il prezzo è 2,49.

   ATTENZIONE PREZZI: Se un prezzo inizia con "4" o "4,xx" o "4.xx" verifica attentamente che non sia una lettura errata del "1" iniziale (es. "1,79" che sembra "4,79" su foto storta). Controlla sempre la coerenza col totale finale.

0d. LETTURA RIGA PER RIGA — MAI SEPARARE NOMI E PREZZI (regola CRITICA): NON leggere prima TUTTI i nomi dall'alto in basso e poi TUTTI i prezzi dall'alto in basso in due passate separate — è la causa più grave di errore. Leggi UNA RIGA STAMPATA ALLA VOLTA: nome + IVA% + prezzo della STESSA riga vanno estratti INSIEME, prima di passare alla riga successiva. Il prezzo di un prodotto è SEMPRE quello scritto sulla STESSA riga orizzontale del suo nome, mai un prezzo preso da qualche riga più in basso (anche se numericamente "sembra tornare" con qualcos'altro).
   Le righe di sconto indentate sotto un prodotto (es. "AP16 SCONT* CHE SC -0,50", "AP 16 TAGLI PREZZO -0,20") sono righe A SÉ: non spostano né "consumano" la posizione del prezzo dei prodotti successivi. Se salti una riga sconto senza notarla, tutti i prezzi dei prodotti sotto si disallineano di una riga: è un errore GRAVISSIMO da evitare sempre.
   Esempio reale dell'errore da NON fare (scontrino CRAI): righe stampate:
     "MOZZAR FRANCIA FIORD   4,00%   3,84"
     "TRANCIO PORCHETTATO   10,00%   2,02"
     ... (altri prodotti) ...
     "FINDUS CROCCOLE SPIN  10,00%   4,39"
     "  AP16 SCONT* CHE SC -1,40"
   SBAGLIATO: scrivere item "Mozzar Francia Fiord" con prezzo 4,39 (quello è il prezzo di "Findus Croccole Spin", una riga molto più sotto) o item "Trancio Porchettato" con prezzo 1,79 (quello è il prezzo di "Yog Activ Mix Go Mu"). CORRETTO: "Mozzar Francia Fiord" 3,84, "Trancio Porchettato" 2,02 — ciascuno il prezzo sulla PROPRIA riga.
   Una riga di sconto/sconto-IVA globale (es. "Sconto IVA 10,00% -3,50" vicino al subtotale) NON è MAI il prezzo di un prodotto: se un prezzo che stai per scrivere corrisponde esattamente a un valore di sconto visto altrove sullo scontrino, hai quasi certamente disallineato le righe — fermati e rileggi riga per riga dal prodotto in questione.

1. SCONTI SU RIGA SEPARATA — REGOLA CRITICA: una riga è uno SCONTO (non un prodotto) quando ha queste caratteristiche: il PREZZO è NEGATIVO (es. -1,19) OPPURE il testo inizia con parole come "SCONTO", "TAGLIO PREZZO", "VOLANTINO", "PROMO", "RIDUZIONE", "ARTICOLO PREZZO FISSO".
   Uno sconto NON è MAI un item dell'array "items". Va sommato nel campo "discount" del PRODOTTO PRECEDENTE (valore positivo: -1,19 → discount 1.19).
   ⛔ NON inventare righe sconto: includi SOLO gli sconti che vedi DAVVERO stampati su QUESTO scontrino, con il loro importo reale. Non creare "items" con nome "Sconto…"/"Taglio Prezzo"/"Volantino" e prezzo 0. Se non c'è un prodotto precedente chiaro, ignora la riga.
   REGOLA "VOLANTINO XX": il numero dopo VOLANTINO (es. "VOLANTINO 17") è il CODICE dell'offerta, NON l'importo. L'importo è il valore negativo nella colonna Prezzo(€) sulla stessa riga.
   REGOLA PROMO SENZA TESTO ("1+1", "2X1", "3X2"): anche una riga che contiene SOLO un codice promo tipo "1+1", "2X1", "3X2" (senza la parola "SCONTO") con un prezzo negativo è comunque una riga di SCONTO, non un prodotto — vale la stessa regola: il prezzo negativo la identifica come sconto a prescindere dal testo. Non saltarla: il suo importo va sommato al "discount" del prodotto precedente con la stessa IVA%.

1b. VERIFICA IVA PER L'ATTRIBUZIONE SCONTO — REGOLA CRITICA: una riga sconto eredita SEMPRE la stessa aliquota IVA% del prodotto a cui si riferisce (perché lo sconto è calcolato su quel prodotto). Prima di assegnare uno sconto al "prodotto precedente", controlla che l'IVA% della riga sconto coincida con l'IVA% della riga prodotto immediatamente sopra. Se le due aliquote NON coincidono, il prodotto immediatamente sopra NON è quello giusto: risali di un'altra riga fino a trovare il prodotto con la stessa IVA% dello sconto, ed è A QUELLO che va assegnato lo sconto.
   Esempio dell'errore da evitare: "NESCAFE GINSENG 22,00% 3,49" → "SCONTO SALA 22,00% -0,30" → "CERTOSA LIGHT 4,00% 2,39" → "SCONTO FRESCHI 4,00% -0,40". Lo sconto -0,30 (IVA 22%) va a NESCAFE (IVA 22%), NON a CERTOSA (IVA 4%, sconto sbagliato per aliquota). Lo sconto -0,40 (IVA 4%) va a CERTOSA (IVA 4%). Ogni sconto si abbina al prodotto con la STESSA percentuale IVA sulla riga, non semplicemente all'ultima riga letta.

2. PRODOTTI DUPLICATI: Unisci in UN SOLO oggetto SOLO se il prodotto ha ESATTAMENTE lo stesso nome, lo stesso prezzo unitario E lo stesso sconto (o entrambi senza sconto). Due righe con nomi simili ma prezzi diversi sono prodotti DISTINTI — non unire. Se due righe hanno stesso nome e prezzo ma SCONTI diversi (es. una scontata di -1,89 e l'altra senza sconto), sono comunque prodotti DISTINTI — NON unirli, altrimenti si perde lo sconto specifico di una delle due righe. Esempio: due righe "CONSILIA STRACC.165G 4% 1,89" identiche, entrambe senza sconto → un oggetto con quantity:2, unitPrice:1.89, totalPrice:3.78. Ma "CONSILIA STRACC.165G" e "CONSILIA GOCCE 250G" sono prodotti DIVERSI anche se entrambi "Consilia".

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

4d. MARCATORI BILANCIA (regola CRITICA): sugli articoli venduti a peso/banco, lo scontrino stampa righe tecniche come "INIZ SCONTR.BILANCIA", "FINE SCONTR.BILANCIA", "ARTICOLI", "NUMERO XXXX" PRIMA e/o DOPO il nome del prodotto pesato. Queste righe NON fanno MAI parte del nome del prodotto — sono marcatori del registratore di cassa, vanno IGNORATE COMPLETAMENTE, mai concatenate al nome.
   Esempio dell'errore da evitare: "INIZ SCONTR.BILANCIA" → "MARTELLI MORTADELLA 3,00" → "ARTICOLI 1" → "NUMERO 2339" → "FINE SCONTR.BILANCIA" deve produrre l'item "Martelli Mortadella" 3.00 (NON "Iniz Scontr.Bilancia Martelli Mortadella" e NON "Fine Scontr.Bilancia" unito al prodotto successivo). Il nome del prodotto è SOLO il testo del prodotto stesso, ripulito da qualunque marcatore bilancia prima o dopo.

5. COSA ESCLUDERE dagli items: righe IVA, punti fedeltà, resto, buoni pasto, subtotali ("SUBTOTALE"), "DI CUI IVA", "Pagamento elettronico", "Importo pagato", spese di servizio, "OFFERTA"/"OMAGGIO" senza un prezzo prodotto.
   ⛔ ESCLUDI il NOME DELL'OPERATORE/CASSIERE: in alto, tra l'intestazione del negozio e il primo prodotto, c'è spesso un nome di persona con iniziale puntata (es. "DANIELE F.", "MARIO R.") o "OPERATORE"/"CASSA N."/"CASSIERE". NON è un prodotto: NON includerlo MAI (non ha un prezzo prodotto associato).
   ⛔ ESCLUDI i nomi di REPARTO da soli ("PANE", "GASTRONOMIA", "ORTOFRUTTA", "MACELLERIA") — sono header, non prodotti (vedi regola 4c).
   ⛔ ESCLUDI i marcatori bilancia ("INIZ/FINE SCONTR.BILANCIA", "ARTICOLI", "NUMERO XXXX") — vedi regola 4d. Non sono prodotti né vanno concatenati ai nomi.
   INCLUDI sempre shopper e sacchetti anche se costano poco (es. "SHOPPER MAT-BIO €0,12") — l'utente vuole vedere tutto quello che ha pagato.
   NON escludere MAI prodotti alimentari o prodotti per la casa — includi assolutamente TUTTI i prodotti con un prezzo.

5b. NESSUN PRODOTTO SALTATO: Conta le righe prodotto sullo scontrino e verifica che l'array "items" abbia lo stesso numero di elementi. Se una riga ha un prezzo valido e non è un subtotale/IVA, deve essere inclusa.

5c. VERIFICA TOTALE — CONTROLLO FINALE: Dopo aver estratto tutti gli item, somma mentalmente i loro totalPrice (al netto degli sconti per articolo). Il risultato deve avvicinarsi al totalAmount dello scontrino (±0,10€ per arrotondamenti IVA). Se la somma si discosta di più, significa che hai letto male qualche prezzo — riesamina le righe con cifre ambigue (es. 9 vs 6, 8 vs 6, 0 vs 6, 1 vs 4, 3 vs 8) e correggile PRIMA di rispondere. Questo controllo NON è opzionale: fallo sempre, anche se ti sembra di aver letto bene, perché è l'unico modo per accorgersi di una cifra scambiata senza rileggere ogni riga una per una.

5d. CIFRE FACILMENTE CONFUSE — attenzione especiale a "9" vs "6": sulla carta termica dei prezzi stampati, il 9 e il 6 sono la stessa forma capovolta e si scambiano facilmente, specialmente su foto storte, sfocate o con poca luce. Prima di scrivere un prezzo con un 9 o un 6, guarda se l'anello della cifra si chiude in alto (9) o in basso (6). In caso di dubbio, preferisci il valore che rende la somma degli item più vicina al totalAmount dello scontrino (vedi regola 5c) — il totale stampato è sempre più affidabile della singola cifra ambigua.

6. FOTO SFOCATA O PARZIALE: Se un valore non è leggibile usa null. Non inventare prezzi.

7. DATA: Lo scontrino può mostrare la data in formato GG/MM/AAAA oppure GG/MM/AA — converti sempre in YYYY-MM-DD.

Struttura JSON da restituire:
{
  "storeName": "nome negozio completo o null",
  "storeChain": "catena esatta tra: Coop, Conad, Esselunga, Carrefour, Lidl, Eurospin, Penny, Famila, Top Supermercati, Aldi, Pam, Despar, Tigros, Pim, Iper, Iper Triscount, MD, Todis, Pewex, Bennet, Sigma, Gigante, Interspar, Crai, Selex, Dok, Emisfero, A&O, Maxì, Iperal, Iperstore, Basko, Galassia, Ekom, Acqua e Sapone, Caddy's, Pellicano, Fortè, Unes, U2 Supermercato, Iper La grande i, Carrefour Market, Carrefour Express, Carrefour Gourmet, Carrefour Bio, Conad City, Conad Superstore, Ipercoop, Coop Alleanza 3.0, Unicoop Firenze, Unicoop Tirreno, Nova Coop, Coop Lombardia, Coop Liguria, Supercoop, Crai Store, Crai Extra, Sidis, Coal, Agorà, Spar, Eurospar, Interspar, Despar Express, Aldi, Lidl, Penny Market, Prix, In's Mercato, Spazio Conad, Simply, Eté, Dpiù, Quì, Maxstore, Superstore, Auchan, Panorama, Iperpanorama, Ipercasalinghi, Risparmio Casa, Normal, Action, Primark Food, Bennet, Cattel, Gross Iper, Iper Montebello, Iper Tosano, Tosano, Galassia Ipermercato, Ok! Supermercato, Cedi, Ge.Al, Megamark, Finiper, Iper Finiper, Supermercati Tigre, Tigre, G.S. Supermercato, Gs, Superconti, Punto Simply, Pellegrini, Multicedi, Vitalia, Poli, Multicash, Metro, Makro, Costco, Globo, Emisfero, Gigante Verde, Superstore Auchan, Iperstanda, Standa, GS Carrefour, Billa, Rewe, Real, Migros, Cedi, Cedi Lombardo, Cedi Marche o null",
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

// NON USATO al momento — approccio alternativo "solo testo" (senza immagine).
const STRUCTURE_PROMPT = `Ti do il TESTO GREZZO di uno scontrino italiano, già letto da OCR. Il tuo compito è SOLO STRUTTURARLO in JSON. Restituisci SOLO JSON valido.

REGOLE:

1. FEDELTÀ NOMI: copia "name" ESATTAMENTE come appare nel testo (espandi solo troncature ovvie: "PROSC."→"Prosciutto"). MAI inventare o sostituire marchi (Frosta resta Frosta, Yoga resta Yoga, Lariano resta Lariano).

2. COLONNE SCONTRINO: ogni prodotto ha 3 colonne: DESCRIZIONE | IVA% | PREZZO.
   Il PREZZO è l'ultimo numero sulla riga che NON è seguito da "%". Le aliquote IVA (4%, 10%, 22%) NON sono prezzi.
   ATTENZIONE storpiature OCR nelle aliquote IVA: "72,00%" → leggi come 22,00%; "10:00%" → 10,00%; "4.00%" → 4,00%. Se vedi un numero seguito da % che assomiglia a un'aliquota IVA italiana (4, 10, 22), è l'IVA — non il prezzo.

3. DUE PRODOTTI SU UNA RIGA: se l'OCR ha fuso due nomi di prodotto sulla stessa riga con UN SOLO prezzo (es. "KINDER ICE CRE   FROSTA FISHBURGER   10,00%  3,79"), sono DUE prodotti distinti:
   - Il prezzo visibile sulla riga (3,79) appartiene al PRIMO prodotto (KINDER).
   - Se la riga IMMEDIATAMENTE SUCCESSIVA è solo un numero (es. "3,49" senza nome), quello è il prezzo del SECONDO prodotto (FROSTA).
   - Se non c'è un prezzo standalone dopo, il secondo prodotto ha prezzo null e va OMESSO (meglio perderlo che metterlo a 0).
   Includi sempre il PRIMO prodotto con il suo prezzo. Includi il SECONDO solo se hai trovato il suo prezzo standalone.

4. PREZZO TRONCATO: se un prezzo inizia con virgola (es. ",99" o ",49"), l'OCR ha perso la prima cifra. Ricostruisci: se il totale e il contesto suggeriscono un valore tipo 1,99 → scrivi 1.99; se potrebbe essere 0,99 → 0.99. Usa il contesto del totale per scegliere la cifra più probabile.

5. SCONTI: riga con prezzo NEGATIVO o che inizia con "SCONTO"/"VOLANTINO"/"PROMO"/"TAGLIO PREZZO" → è sconto del prodotto PRECEDENTE, mettilo nel suo "discount" (valore positivo). NON è un item separato.
   "VOLANTINO XX": il numero è il codice offerta, NON l'importo. L'importo è il numero negativo sulla stessa riga.

6. QUANTITÀ: riga separata tipo "2 X 1,74" prima di un prodotto → quantity=2, unitPrice=1,74, totalPrice=3,48. Ma "X 10" o "X 6" DENTRO un nome (es. "NESCAFE X 10") è la descrizione del prodotto — quantity=1.

7. REPARTI: header tipo "PANE - 2,09 -" o "GASTRONOMIA - 11,42 -" NON sono prodotti: il prodotto è la riga SOTTO. Es. "PANE - 2,09 -" + "LARIANO 4,00% 2,09" → item "Lariano" 2.09 (category: pane_pasta). Gastronomia: prefisso "Gastronomia: " nel nome.

8. ESCLUDI: operatore/cassiere (es. "DANIELE F.", "MARIO R."), numero documento, "SUBTOTALE", "TOTALE COMPLESSIVO", "DI CUI IVA", "Pagamento", "Importo pagato", righe con solo IVA%, header colonne ("DESCRIZIONE IVA Prezzo").

9. TOTALI: "totalAmount" = numero accanto a "TOTALE COMPLESSIVO". "totalDiscount" = somma di tutti gli sconti (articolo + globali tipo "SCONTO 10%").
   MARCATORE "=== PARTE 2 ===": separa due metà della stessa foto — intorno al marcatore includi ogni prodotto UNA sola volta. Altrove i duplicati sono VERI (es. due righe "GRANAROLO STRACCHINO 2,19" = 2 prodotti distinti).

10. Includi TUTTI i prodotti con prezzo (anche buste/sacchetti). Non saltarne nessuno.

11. CATEGORIA per ogni prodotto — scegli ESATTAMENTE una di queste 10:
    frutta_verdura (Banane/Rucola/Cetrioli/Albicocche/Pomodoro/Meloni/Pesche/Mele)
    carne_pesce (Prosciutto/Mortadella/Bacon/Saltimbocca/Speck/Pollo/Tonno/Salmone)
    latticini (Parmalat/Yogurt/Kefir/Stracchino/Edamer/Uova/Müller/Granarolo/Mozzarella)
    pane_pasta (Lariano/Pane/Crostata/Torretta/Pasta/Riso/Crackers)
    bevande (Yoga/Acqua/Nescafe/The/San Benedetto/Succo/Birra/Vino/Coca)
    dolci_snack (Kinder/Biscotti/Cioccolato/Snack/Barrette/Caramelle)
    surgelati (Frosta/Findus/surgelati/gelato/pizza surgelata)
    dispensa (Olio/Sale/Zucchero/Conserve/Farina/Brodo/Pomodoro in scatola)
    igiene_casa (Detersivo/Carta igienica/Shampoo/Sapone/Dentifricio/Ammorbidente)
    altro (tutto il resto)

12. Se un dato manca usa null.

Struttura JSON: {"storeName":"…","storeChain":"… o null","storeAddress":"… o null","receiptDate":"YYYY-MM-DD o null","items":[{"name":"…","rawName":"riga grezza","quantity":1,"unitPrice":0.00,"totalPrice":0.00,"discount":0.00,"category":"una delle 10"}],"totalAmount":0.00,"totalDiscount":0.00,"paymentMethod":"… o null"}`;

module.exports = { RECEIPT_PROMPT, STRUCTURE_PROMPT };
