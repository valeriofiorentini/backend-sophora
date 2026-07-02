-- Enum per i campi con set di valori chiuso + indici geografici (bounding box)
-- + colonna sourceReceiptId (dedup dispensa alla riscansione scontrino).
-- NB: il DB era appena stato resettato (vuoto) quando questa migration è stata
-- scritta: i cast USING sono sicuri. Su un DB con dati, verificare prima che
-- tutti i valori esistenti rientrino negli enum.

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('pending', 'processing', 'processed', 'error');
CREATE TYPE "VoucherStatus" AS ENUM ('available', 'redeemed', 'used', 'expired');
CREATE TYPE "PantrySource"  AS ENUM ('receipt', 'scan', 'manual');
CREATE TYPE "ListItemSource" AS ENUM ('manual', 'scan', 'receipt');
CREATE TYPE "LevelTier"     AS ENUM ('bronze', 'silver', 'gold', 'platinum');
CREATE TYPE "FeedType"      AS ENUM ('review', 'discount');

-- Receipt.status → enum
ALTER TABLE "Receipt" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Receipt" ALTER COLUMN "status" TYPE "ReceiptStatus" USING ("status"::"ReceiptStatus");
ALTER TABLE "Receipt" ALTER COLUMN "status" SET DEFAULT 'pending';

-- Voucher.status → enum
ALTER TABLE "Voucher" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Voucher" ALTER COLUMN "status" TYPE "VoucherStatus" USING ("status"::"VoucherStatus");
ALTER TABLE "Voucher" ALTER COLUMN "status" SET DEFAULT 'available';

-- PantryItem.source → enum (nullable, nessun default)
ALTER TABLE "PantryItem" ALTER COLUMN "source" TYPE "PantrySource" USING ("source"::"PantrySource");

-- PantryItem.sourceReceiptId (mai migrato prima)
ALTER TABLE "PantryItem" ADD COLUMN IF NOT EXISTS "sourceReceiptId" TEXT;

-- GroupListItem.source → enum
ALTER TABLE "GroupListItem" ALTER COLUMN "source" DROP DEFAULT;
ALTER TABLE "GroupListItem" ALTER COLUMN "source" TYPE "ListItemSource" USING ("source"::"ListItemSource");
ALTER TABLE "GroupListItem" ALTER COLUMN "source" SET DEFAULT 'manual';

-- UserLevel.level → enum
ALTER TABLE "UserLevel" ALTER COLUMN "level" DROP DEFAULT;
ALTER TABLE "UserLevel" ALTER COLUMN "level" TYPE "LevelTier" USING ("level"::"LevelTier");
ALTER TABLE "UserLevel" ALTER COLUMN "level" SET DEFAULT 'bronze';

-- Feed.type → enum (nessun default)
ALTER TABLE "Feed" ALTER COLUMN "type" TYPE "FeedType" USING ("type"::"FeedType");

-- Indici geografici per le query bounding box
CREATE INDEX IF NOT EXISTS "Promo_latitude_longitude_idx" ON "Promo"("latitude", "longitude");
CREATE INDEX IF NOT EXISTS "Store_latitude_longitude_idx" ON "Store"("latitude", "longitude");
CREATE INDEX IF NOT EXISTS "User_latitude_longitude_idx"  ON "User"("latitude", "longitude");
