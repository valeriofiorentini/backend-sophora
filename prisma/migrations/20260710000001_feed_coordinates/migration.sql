-- Aggiunge coordinate al post community (Feed): servono per il filtro
-- "vicino a me / entro X km / città" che prima non poteva funzionare perché
-- le coordinate arrivavano dal client (location: GeoJSON Point) ma venivano
-- solo stringificate dentro storeLocation invece di essere salvate come numeri.
ALTER TABLE "Feed" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "Feed" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS "Feed_latitude_longitude_idx" ON "Feed"("latitude", "longitude");
