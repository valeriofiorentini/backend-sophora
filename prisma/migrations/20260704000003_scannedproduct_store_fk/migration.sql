-- ScannedProduct: separa storeName (testo libero) da storeId (FK verso Store).
-- Prima il nome negozio finiva per errore nella colonna storeId (il client non
-- manda un id), rendendo impossibile una FK. Qui: nuova colonna storeName,
-- si recupera il nome dai vecchi storeId non-UUID, si azzerano gli storeId non
-- validi, poi si aggiunge la FK (ora tutti gli storeId residui sono id validi).

ALTER TABLE "ScannedProduct" ADD COLUMN IF NOT EXISTS "storeName" TEXT;

-- Recupera in storeName i valori che erano nomi finiti in storeId
UPDATE "ScannedProduct" SET "storeName" = "storeId"
  WHERE "storeName" IS NULL
    AND "storeId" IS NOT NULL
    AND "storeId" NOT IN (SELECT "id" FROM "Store");

-- Azzera gli storeId che non sono id validi (erano nomi)
UPDATE "ScannedProduct" SET "storeId" = NULL
  WHERE "storeId" IS NOT NULL
    AND "storeId" NOT IN (SELECT "id" FROM "Store");

-- Ora la FK è soddisfacibile
ALTER TABLE "ScannedProduct"
  ADD CONSTRAINT "ScannedProduct_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL;
