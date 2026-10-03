'use strict';

/**
 * Corregge i dati salvati come catena "Mercatò" che in realtà sono "In's
 * Mercato" (la vecchia normalizzazione catturava la parola "mercato").
 *
 * Senza argomenti mostra solo cosa cambierebbe. Per applicare:
 *   node scripts/fix-ins-mercato-chain.js --apply
 *
 * Scontrini e offerte si riconoscono dal nome negozio grezzo. Lo storico
 * prezzi non ha il nome negozio: viene rinominato solo se TUTTI gli scontrini
 * e le offerte "Mercatò" risultano In's Mercato (nessun Mercatò vero).
 */
const prisma = require('../src/config/database');
const { canonicalizeChain } = require('../src/utils/storeChain');

const OLD = 'Mercatò';
const NEW = "In's Mercato";
const apply = process.argv.includes('--apply');

const isIns = name => canonicalizeChain(name || '') === NEW;

async function main() {
  const receipts = await prisma.receipt.findMany({
    where: { storeChain: OLD },
    select: { id: true, storeName: true },
  });
  const promos = await prisma.promo.findMany({
    where: { storeChain: OLD },
    select: { id: true, storeName: true },
  });

  const receiptIds = receipts.filter(r => isIns(r.storeName)).map(r => r.id);
  const promoIds = promos.filter(p => isIns(p.storeName)).map(p => p.id);
  const genuineLeft = (receipts.length - receiptIds.length) + (promos.length - promoIds.length);
  const historyCount = await prisma.priceHistory.count({ where: { storeChain: OLD } });
  const renameHistory = genuineLeft === 0 && historyCount > 0;

  console.log(`Scontrini "${OLD}": ${receipts.length} — da correggere in "${NEW}": ${receiptIds.length}`);
  console.log(`Offerte "${OLD}":   ${promos.length} — da correggere in "${NEW}": ${promoIds.length}`);
  console.log(`Storico prezzi "${OLD}": ${historyCount} — ${renameHistory ? 'verrà rinominato' : `NON rinominato (restano ${genuineLeft} Mercatò veri o senza nome negozio)`}`);

  if (!apply) {
    console.log('\nProva: nessuna modifica. Rilancia con --apply per applicare.');
    return;
  }

  await prisma.$transaction([
    prisma.receipt.updateMany({ where: { id: { in: receiptIds } }, data: { storeChain: NEW } }),
    prisma.promo.updateMany({ where: { id: { in: promoIds } }, data: { storeChain: NEW } }),
    ...(renameHistory
      ? [prisma.priceHistory.updateMany({ where: { storeChain: OLD }, data: { storeChain: NEW } })]
      : []),
  ]);
  console.log('\nFatto.');
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
