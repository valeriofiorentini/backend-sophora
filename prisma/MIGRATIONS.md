# Regole migration — leggere PRIMA di toccare il database

Il 2 luglio 2026 il DB di produzione è stato **resettato con perdita totale dei
dati** perché due migration erano state modificate dopo essere state applicate
("drift"). Queste regole esistono perché non succeda mai più.

## Le 3 regole

1. **MAI modificare un file dentro `prisma/migrations/` già committato.**
   Prisma calcola un checksum di ogni migration applicata: se il file cambia,
   il DB va in drift e l'unica via d'uscita è il reset.
   Serve correggere qualcosa? → nuova migration.

2. **Ogni modifica a `schema.prisma` = una nuova migration.**
   In locale (serve un DB di sviluppo raggiungibile):
   ```bash
   npx prisma migrate dev --name descrizione_breve
   ```
   Senza DB locale: modifica lo schema, genera l'SQL con
   ```bash
   npx prisma migrate diff \
     --from-schema-datamodel /percorso/schema-vecchio.prisma \
     --to-schema-datamodel   prisma/schema.prisma --script
   ```
   e crea a mano la cartella `prisma/migrations/AAAAMMGGHHMMSS_nome/migration.sql`.

3. **In produzione SOLO `migrate deploy`, mai `migrate dev`.**
   ```bash
   ssh root@167.233.96.153
   cd ~/workspace/sophora/backend-sophora
   git pull
   npx prisma migrate deploy   # applica solo le migration mancanti, non resetta MAI
   npx prisma generate
   pm2 restart shopora
   ```
   `migrate dev` in produzione può proporre il reset del DB (è successo!).
   `migrate deploy` no: applica e basta, o fallisce in modo sicuro.

## Note sugli enum (migration 20260702000001)

`Receipt.status`, `Voucher.status`, `PantryItem.source`, `GroupListItem.source`,
`UserLevel.level`, `Feed.type` sono enum PostgreSQL: un valore fuori lista viene
rifiutato dal DB. Per aggiungere un valore a un enum serve una migration:
```sql
ALTER TYPE "ReceiptStatus" ADD VALUE 'nuovo_valore';
```

Restano `String` di proposito (valori aperti o dettati da terzi):
`Subscription.status` (Stripe), `Voucher.type`, `Promo.source`,
`PriceHistory.source`, `FineTuningJob.status` (OpenAI).
