-- Permette di dividere una voce della lista condivisa tra PIÙ partecipanti
-- scelti (es. carta igienica tra 3 coinquilini su 5), non solo un singolo
-- membro o tutto il gruppo.
ALTER TABLE "GroupListItem" ADD COLUMN IF NOT EXISTS "splitMemberIds" TEXT[] NOT NULL DEFAULT '{}';
