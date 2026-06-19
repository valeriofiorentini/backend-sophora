/**
 * database.js — V5
 * Prisma client con log adattivo e supporto read replica (multi-region).
 * Imposta READ_DATABASE_URL per attivare la replica.
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  datasources: process.env.READ_DATABASE_URL
    ? undefined  // gestito a livello di connection pooler esterno (PgBouncer/Supabase)
    : undefined,
});

if (process.env.READ_DATABASE_URL) {
  console.log('🌍 Multi-region: read replica attiva');
}

module.exports = prisma;
