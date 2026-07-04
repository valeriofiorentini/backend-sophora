-- Product.price e discountedPrice: da Float a Decimal(10,2). Come per
-- ScannedProduct: il denaro non va in floating point. I controller (product,
-- cart, store) convertono il Decimal a Number al confine API tramite
-- serializeProduct(), quindi il client continua a ricevere numeri.
ALTER TABLE "Product"
  ALTER COLUMN "price" TYPE DECIMAL(10,2) USING ROUND("price"::numeric, 2);
ALTER TABLE "Product"
  ALTER COLUMN "discountedPrice" TYPE DECIMAL(10,2) USING ROUND("discountedPrice"::numeric, 2);
