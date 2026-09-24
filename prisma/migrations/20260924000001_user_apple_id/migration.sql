-- Accedi con Apple (App Store guideline 4.8): ID Apple stabile dell'utente
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "appleId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_appleId_key" ON "User"("appleId");
