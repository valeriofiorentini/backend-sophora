-- ScannedProduct.price: da Float (double) a Decimal(10,2). Il denaro non va
-- mai in floating point (deriva tipo 28.129999...). USING ROUND(...) converte
-- i valori esistenti arrotondandoli a 2 decimali. Il backend converte il
-- Decimal a Number al confine API, quindi il client continua a ricevere numeri.
ALTER TABLE "ScannedProduct"
  ALTER COLUMN "price" TYPE DECIMAL(10,2) USING ROUND("price"::numeric, 2);
