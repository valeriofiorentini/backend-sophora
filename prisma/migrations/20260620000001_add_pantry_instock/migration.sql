-- AlterTable: add inStock column to PantryItem if it doesn't exist
ALTER TABLE PantryItem ADD COLUMN IF NOT EXISTS inStock BOOLEAN NOT NULL DEFAULT true;
