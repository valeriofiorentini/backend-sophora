-- Chi ha DAVVERO pagato una voce, esplicito e scelto dall'utente — prima si
-- deduceva solo da addedByUserId (chi scansiona/aggiunge), impedendo di dire
-- "l'ho scansionato io ma ha pagato Fiore".
ALTER TABLE "GroupListItem" ADD COLUMN IF NOT EXISTS "paidByMemberId" TEXT;
