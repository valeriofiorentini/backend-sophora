require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');

const userRoutes         = require('./routes/user.routes');
const storeRoutes        = require('./routes/store.routes');
const productRoutes      = require('./routes/product.routes');
const cartRoutes         = require('./routes/cart.routes');
const groupRoutes        = require('./routes/group.routes');
const scannedProductRoutes = require('./routes/scannedProduct.routes');
const feedRoutes         = require('./routes/feed.routes');
const favouriteRoutes    = require('./routes/favourite.routes');
const notificationRoutes = require('./routes/notification.routes');
const stripeRoutes       = require('./routes/stripe.routes');
const ocrRoutes          = require('./routes/ocr.routes');
const promoRoutes        = require('./routes/promo.routes');
const receiptRoutes      = require('./routes/receipt.routes');
const chatRoutes         = require('./routes/chat.routes');
const nutritionRoutes    = require('./routes/nutrition.routes');
const gamificationRoutes = require('./routes/gamification.routes');
const similarityRoutes   = require('./routes/similarity.routes');
const flyerRoutes        = require('./routes/flyer.routes');
const forecastRoutes     = require('./routes/forecast.routes');
const routingRoutes      = require('./routes/routing.routes');
const finetuningRoutes   = require('./routes/finetuning.routes');
const pantryRoutes       = require('./routes/pantry.routes');
const advisorRoutes      = require('./routes/advisor.routes');
const shoppingListRoutes = require('./routes/shoppingList.routes');

const { errorHandler }      = require('./middleware/errorHandler');
const { startScheduler }    = require('./services/scraper.service');
const { ensureCollections } = require('./services/qdrant.service');
const { triggerBatchForecast } = require('./services/ml.service');
const prisma = require('./config/database');

const app = express();

// Express dietro un reverse proxy (Railway/Render/Nginx): necessario per ottenere
// l'IP reale del client (rate limit) e per il corretto funzionamento di HTTPS.
app.set('trust proxy', 1);
app.disable('x-powered-by'); // non rivelare che giriamo su Express

// ─── Header di sicurezza ────────────────────────────────────────────────────────
// Equivalente minimale di helmet, senza dipendenze aggiuntive.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');          // no MIME sniffing
  res.setHeader('X-Frame-Options', 'DENY');                    // anti clickjacking
  res.setHeader('Referrer-Policy', 'no-referrer');             // non leakare URL
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  // HSTS: forza HTTPS per 180 giorni (efficace solo quando servito via HTTPS)
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// ─── CORS ─────────────────────────────────────────────────────────────────────
// In produzione, limitare alle origini note (set ALLOWED_ORIGINS nel .env)
// Es: ALLOWED_ORIGINS=https://shopora.com
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : true; // sviluppo: accetta tutto

app.use(cors({
  origin:      allowedOrigins,
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Body parsers ─────────────────────────────────────────────────────────────
// Stripe webhook usa raw body — deve stare PRIMA del parser JSON
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Healthcheck ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status:  'ok',
  region:  process.env.REGION ?? 'local',
  version: process.env.npm_package_version ?? '1.0.0',
}));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/user',           userRoutes);
app.use('/api/stores',         storeRoutes);
app.use('/api/products',       productRoutes);
app.use('/api/cart',           cartRoutes);
app.use('/api/group',          groupRoutes);
app.use('/api/scannedProduct', scannedProductRoutes);
app.use('/api/feeds',          feedRoutes);
app.use('/api/favourite',      favouriteRoutes);
app.use('/api/notification',   notificationRoutes);
app.use('/api/stripe',         stripeRoutes);
app.use('/api/ocr',            ocrRoutes);
app.use('/api/promos',         promoRoutes);
app.use('/api/receipts',       receiptRoutes);
app.use('/api/chat',           chatRoutes);
app.use('/api/nutrition',      nutritionRoutes);
app.use('/api/gamification',   gamificationRoutes);
app.use('/api/pantry',         pantryRoutes);
app.use('/api/similarity',     similarityRoutes);
app.use('/api/flyer',          flyerRoutes);
app.use('/api/forecast',       forecastRoutes);
app.use('/api/routing',        routingRoutes);
app.use('/api/finetuning',     finetuningRoutes);
app.use('/api/advisor',        advisorRoutes);
app.use('/api/shopping-list',  shoppingListRoutes);

// 404 per route non definite
app.use((_req, res) => res.status(404).json({ success: false, message: 'Endpoint non trovato' }));

// Error handler centralizzato (gestisce anche errori da asyncHandler)
app.use(errorHandler);

// ─── Avvio server ─────────────────────────────────────────────────────────────
const PORT   = parseInt(process.env.PORT, 10) || 3000;
const server = app.listen(PORT, () => {
  console.log(`✅ Shopora API avviato — porta ${PORT} [${process.env.NODE_ENV ?? 'development'}]`);

  if (process.env.NODE_ENV === 'production') {
    startScheduler();
  }

  // Batch forecast notturno — attivo anche in sviluppo se ML_SERVICE_URL è set
  if (process.env.ML_SERVICE_URL) {
    cron.schedule('0 2 * * *', () => {
      console.log('🔮 Batch forecast notturno avviato...');
      triggerBatchForecast().catch(err => console.warn('[cron] batch forecast error:', err.message));
    });
  }

  // Cleanup notturno: utenti registrati ma mai verificati (OTP non inserito entro 24h)
  // e OTP scaduti. Senza verifica l'account non è utilizzabile — eliminarlo permette
  // di ri-registrarsi con la stessa email.
  cron.schedule('30 3 * * *', async () => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    try {
      const deleted = await prisma.user.deleteMany({
        where: { isVerified: false, password: { not: null }, createdAt: { lt: cutoff } },
      });
      const expiredOtps = await prisma.otp.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (deleted.count || expiredOtps.count) {
        console.log(`🧹 Cleanup: ${deleted.count} utenti non verificati, ${expiredOtps.count} OTP scaduti`);
      }
    } catch (e) {
      console.warn('[cron] cleanup error:', e.message);
    }
  });

  // Qdrant init (graceful — non bloccante)
  ensureCollections()
    .then(() => console.log('✅ Qdrant collections pronte'))
    .catch(err => console.warn('⚠️  Qdrant non disponibile:', err.message));
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Gestisce SIGTERM (Railway/Docker stop) e SIGINT (Ctrl+C locale)
// Aspetta che le richieste in corso finiscano prima di chiudere.
async function shutdown(signal) {
  console.log(`\n📴 ${signal} ricevuto — avvio graceful shutdown...`);

  server.close(async () => {
    console.log('HTTP server chiuso.');
    try {
      await prisma.$disconnect();
      console.log('DB disconnesso.');
    } catch (e) {
      console.warn('Errore disconnessione DB:', e.message);
    }
    process.exit(0);
  });

  // Forza uscita dopo 10 secondi se il server non chiude
  setTimeout(() => {
    console.error('Shutdown forzato dopo timeout.');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Cattura errori async non gestiti — previene crash silenzioso in produzione
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  UnhandledPromiseRejection:', reason);
  // Non crashare — logga e prosegui (Railway rileva crash e riavvia)
});

process.on('uncaughtException', (err) => {
  console.error('🔥 UncaughtException:', err);
  shutdown('uncaughtException');
});

module.exports = app;
