-- Blocco utenti nel feed community, richiesto insieme alla segnalazione
-- dalle policy Apple/Google sulle app con contenuti generati dagli utenti.
CREATE TABLE IF NOT EXISTS "BlockedUser" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedUser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BlockedUser_blockerId_blockedId_key" ON "BlockedUser"("blockerId", "blockedId");
CREATE INDEX IF NOT EXISTS "BlockedUser_blockerId_idx" ON "BlockedUser"("blockerId");

ALTER TABLE "BlockedUser" ADD CONSTRAINT "BlockedUser_blockerId_fkey"
    FOREIGN KEY ("blockerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlockedUser" ADD CONSTRAINT "BlockedUser_blockedId_fkey"
    FOREIGN KEY ("blockedId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
