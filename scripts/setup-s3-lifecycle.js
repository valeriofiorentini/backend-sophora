/**
 * setup-s3-lifecycle.js
 *
 * Script one-shot per configurare la lifecycle policy S3 sul bucket EasyMarket.
 * Esegui UNA VOLTA dopo il deploy iniziale:
 *
 *   node backend/scripts/setup-s3-lifecycle.js
 *
 * Cosa fa:
 *  - receipts/*   → eliminazione automatica dopo 30 giorni (GDPR art. 5(1)(e))
 *  - flyers/*     → eliminazione automatica dopo 90 giorni
 *
 * Richiede le variabili d'ambiente:
 *   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const { S3Client, PutBucketLifecycleConfigurationCommand, GetBucketLifecycleConfigurationCommand } = require('@aws-sdk/client-s3');

const BUCKET = process.env.AWS_S3_BUCKET;
if (!BUCKET) {
  console.error('❌  AWS_S3_BUCKET non impostato in .env');
  process.exit(1);
}

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'eu-west-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const lifecycleConfig = {
  Rules: [
    {
      ID:     'gdpr-receipts-delete-30d',
      Status: 'Enabled',
      Filter: { Prefix: 'receipts/' },
      Expiration: { Days: 30 },               // GDPR: scontrini → 30gg
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
    {
      ID:     'gdpr-flyers-delete-90d',
      Status: 'Enabled',
      Filter: { Prefix: 'flyers/' },
      Expiration: { Days: 90 },               // volantini → 90gg
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
  ],
};

async function main() {
  // 1. Leggi configurazione attuale (se presente)
  try {
    const existing = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }));
    console.log('ℹ️  Lifecycle attuale:', JSON.stringify(existing.Rules?.map(r => r.ID), null, 2));
  } catch (e) {
    if (e.name !== 'NoSuchLifecycleConfiguration') throw e;
    console.log('ℹ️  Nessuna lifecycle configurata — ne creo una nuova.');
  }

  // 2. Applica nuova configurazione
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket:                  BUCKET,
    LifecycleConfiguration:  lifecycleConfig,
  }));

  console.log(`✅  Lifecycle applicata al bucket "${BUCKET}":
  - receipts/*  → auto-delete dopo 30 giorni (GDPR)
  - flyers/*    → auto-delete dopo 90 giorni
  - Multipart incompleti → eliminati dopo 1 giorno`);
}

main().catch(err => {
  console.error('❌  Errore:', err.message);
  process.exit(1);
});
