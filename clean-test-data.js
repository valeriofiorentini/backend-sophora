/**
 * clean-test-data.js — Rimuove dati di test dal DB prima della produzione.
 * Elimina: utenti guest, utenti @test.com/@dealcart.test, utenti mai verificati.
 * Esegui con: node clean-test-data.js
 */
require('dotenv').config();
const prisma = require('./src/config/database');

async function run() {
  const before = await prisma.user.count();

  const guests = await prisma.user.deleteMany({
    where: { email: { startsWith: 'guest_' } },
  });
  const testUsers = await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { endsWith: '@test.com' } },
        { email: { endsWith: '@dealcart.test' } },
        { email: { endsWith: '@abc.com' } },
        { email: { contains: 'test_' } },
        { email: { contains: 'flowtest_' } },
        { email: { contains: 'otp_test' } },
      ],
    },
  });
  const unverified = await prisma.user.deleteMany({
    where: { isVerified: false },
  });

  const after = await prisma.user.count();
  console.log(`Utenti prima: ${before}`);
  console.log(`  - guest eliminati:        ${guests.count}`);
  console.log(`  - utenti test eliminati:  ${testUsers.count}`);
  console.log(`  - non verificati elim.:   ${unverified.count}`);
  console.log(`Utenti dopo: ${after}`);

  await prisma.$disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
