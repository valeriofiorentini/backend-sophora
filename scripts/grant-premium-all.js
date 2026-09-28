'use strict';

/**
 * Attiva Premium (isSubscribed = true) per tutti gli utenti già registrati.
 * Non tocca chi si registra dopo l'esecuzione.
 *
 * Uso, sul server:
 *   node scripts/grant-premium-all.js            → solo conta, non modifica nulla
 *   node scripts/grant-premium-all.js --confirm  → applica davvero
 */
const prisma = require('../src/config/database');

async function main() {
  const confirm = process.argv.includes('--confirm');

  const total = await prisma.user.count();
  const alreadyPremium = await prisma.user.count({ where: { isSubscribed: true } });
  const toUpdate = total - alreadyPremium;

  console.log(`Utenti totali: ${total}`);
  console.log(`Già Premium:   ${alreadyPremium}`);
  console.log(`Da attivare:   ${toUpdate}`);

  if (!confirm) {
    console.log('\nAnteprima soltanto. Rilancia con --confirm per applicare davvero.');
    return;
  }

  const result = await prisma.user.updateMany({
    where: { isSubscribed: false },
    data: { isSubscribed: true },
  });
  console.log(`\n✅ Attivato Premium per ${result.count} utenti.`);
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
