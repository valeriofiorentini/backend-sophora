-- Indici mancanti su Feed: prima ogni query dei post community (lista ordinata
-- per createdAt, controlli di proprietà per userId) faceva un sequential scan.
CREATE INDEX IF NOT EXISTS "Feed_userId_idx" ON "Feed"("userId");
CREATE INDEX IF NOT EXISTS "Feed_createdAt_idx" ON "Feed"("createdAt");
