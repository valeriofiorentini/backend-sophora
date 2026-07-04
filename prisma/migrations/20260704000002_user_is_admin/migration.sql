-- Flag admin sull'utente: abilita il gating adminOnly lato DB (oltre alla
-- ADMIN_API_KEY statica). Default false = nessun utente è admin finché non
-- promosso esplicitamente (UPDATE "User" SET "isAdmin" = true WHERE email = ...).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT false;
