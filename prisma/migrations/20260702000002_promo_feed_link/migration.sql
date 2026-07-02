-- Collega le Promo generate dai post community al Feed di origine,
-- così l'eliminazione del post rimuove anche l'offerta (niente orfane).
ALTER TABLE "Promo" ADD COLUMN IF NOT EXISTS "feedId" TEXT;
CREATE INDEX IF NOT EXISTS "Promo_feedId_idx" ON "Promo"("feedId");
