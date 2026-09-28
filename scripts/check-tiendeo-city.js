'use strict';

/**
 * Controllo di sola lettura: chiama Tiendeo per alcune città e conta quanti
 * volantini restituisce in totale e quanti sono supermercati — nessuna
 * scrittura sul DB, nessuna chiamata OCR. Serve a capire se la scarsità di
 * offerte a Napoli/Torino/Firenze dipende da Tiendeo (pochi risultati) o da
 * qualcos'altro più a valle nell'import.
 *
 * Uso: node scripts/check-tiendeo-city.js
 */
const { getFlyers, isSupermarketFlyer } = require('./import-flyer-prices');

const CITIES = ['roma', 'milano', 'napoli', 'torino', 'firenze', 'palermo', 'bari', 'bologna'];

async function main() {
  for (const city of CITIES) {
    try {
      const flyers = await getFlyers(city);
      const supermarkets = flyers.filter(f => isSupermarketFlyer(f?.retailerName));
      console.log(`${city.padEnd(10)} volantini totali: ${String(flyers.length).padEnd(4)} supermercati: ${supermarkets.length}`);
      if (supermarkets.length > 0) {
        const names = [...new Set(supermarkets.map(f => f?.retailerName))];
        console.log(`  → ${names.join(', ')}`);
      }
    } catch (e) {
      console.log(`${city.padEnd(10)} ERRORE: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
}

main();
