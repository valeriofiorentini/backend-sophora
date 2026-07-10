/**
 * recategorize-pantry.js — ricategorizza una tantum i PantryItem esistenti
 * con category "altro" (o null), usando l'inferCategory aggiornato (che ora
 * riconosce anche cibo per animali/stoviglie monouso come "non_alimentare").
 *
 * inferCategory viene applicato SOLO al momento della scansione scontrino:
 * i prodotti già in dispensa da prima di un aggiornamento della mappa
 * categorie restano bloccati sulla categoria vecchia finché non si rilancia
 * questo script.
 *
 * Uso: node scripts/recategorize-pantry.js
 */
require('dotenv').config();
const prisma = require('../src/config/database');
const { inferCategory } = require('../src/services/pantrySync.service');

async function main() {
  const items = await prisma.pantryItem.findMany({
    where: { OR: [{ category: 'altro' }, { category: null }] },
    select: { id: true, name: true, category: true },
  });

  console.log(`[recat] ${items.length} prodotti da ricontrollare`);

  let changed = 0;
  for (const item of items) {
    const newCat = inferCategory(item.name);
    if (newCat !== 'altro' && newCat !== item.category) {
      await prisma.pantryItem.update({ where: { id: item.id }, data: { category: newCat } });
      changed++;
      console.log(`[recat] "${item.name}": ${item.category ?? 'null'} → ${newCat}`);
    }
  }

  console.log(`[recat] Fatto. ${changed}/${items.length} ricategorizzati.`);
}

main()
  .catch(e => { console.error('Errore:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
