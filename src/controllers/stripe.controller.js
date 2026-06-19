'use strict';

/**
 * stripe.controller.js
 *
 * Usa il Payment Link già configurato su Stripe Dashboard.
 * Flusso:
 *  1. App chiama GET /api/stripe/checkout-url
 *  2. Backend restituisce l'URL del Payment Link con userId come client_reference_id
 *  3. App apre l'URL nel browser (Linking.openURL)
 *  4. Utente paga su Stripe
 *  5. Stripe chiama POST /api/stripe/webhook con checkout.session.completed
 *  6. Backend aggiorna isSubscribed = true
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const prisma  = require('../config/database');
const { success, error } = require('../utils/response');

// URL del Payment Link (senza parametri) — da .env
const PAYMENT_LINK_URL = process.env.STRIPE_PAYMENT_LINK_URL;

// ─── GET /api/stripe/checkout-url ────────────────────────────────────────────
// Restituisce l'URL da aprire nel browser per il pagamento
async function getCheckoutUrl(req, res) {
  if (!PAYMENT_LINK_URL) {
    return error(res, 'Pagamento non configurato', 503);
  }

  const user = await prisma.user.findUnique({
    where:  { id: req.userId },
    select: { email: true, isSubscribed: true },
  });

  if (!user) return error(res, 'Utente non trovato', 404);

  if (user.isSubscribed) {
    return error(res, 'Hai già un abbonamento attivo', 400);
  }

  // Aggiunge email pre-compilata e userId come riferimento per il webhook
  const url = new URL(PAYMENT_LINK_URL);
  if (user.email) url.searchParams.set('prefilled_email', user.email);
  url.searchParams.set('client_reference_id', req.userId);

  return success(res, { url: url.toString() });
}

// ─── POST /api/stripe/webhook ─────────────────────────────────────────────────
// Stripe chiama questo endpoint dopo ogni evento di pagamento
async function handleWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('[stripe] webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.info(`[stripe] evento: ${event.type}`);

  try {
    switch (event.type) {
      // Pagamento completato tramite Payment Link o Checkout Session
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.client_reference_id;
        if (!userId) break;

        await prisma.$transaction([
          prisma.user.update({
            where: { id: userId },
            data:  { isSubscribed: true },
          }),
          prisma.subscription.upsert({
            where:  { userId },
            update: {
              stripeCustomerId: session.customer ?? null,
              status:           'active',
              currentPeriodEnd: session.expires_at
                ? new Date(session.expires_at * 1000)
                : null,
            },
            create: {
              userId,
              stripeCustomerId: session.customer ?? null,
              status:           'active',
            },
          }),
        ]);
        console.info(`[stripe] utente ${userId} → premium attivo`);
        break;
      }

      // Pagamento ricorrente riuscito (subscription mensile/annuale)
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;

        const sub = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId: invoice.subscription },
        });
        if (!sub) break;

        await prisma.$transaction([
          prisma.subscription.update({
            where: { id: sub.id },
            data: {
              status:          'active',
              currentPeriodEnd: invoice.period_end
                ? new Date(invoice.period_end * 1000)
                : undefined,
            },
          }),
          prisma.user.update({
            where: { id: sub.userId },
            data:  { isSubscribed: true },
          }),
        ]);
        break;
      }

      // Abbonamento cancellato o scaduto
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused': {
        const subscription = event.data.object;
        const sub = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId: subscription.id },
        });
        if (!sub) break;

        await prisma.$transaction([
          prisma.subscription.update({
            where: { id: sub.id },
            data:  { status: 'canceled' },
          }),
          prisma.user.update({
            where: { id: sub.userId },
            data:  { isSubscribed: false },
          }),
        ]);
        console.info(`[stripe] utente ${sub.userId} → abbonamento cancellato`);
        break;
      }

      // Pagamento fallito
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const sub = await prisma.subscription.findFirst({
          where: { stripeSubscriptionId: invoice.subscription },
        });
        if (sub) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data:  { status: 'past_due' },
          });
        }
        break;
      }

      default:
        // Ignora eventi non gestiti
        break;
    }
  } catch (err) {
    console.error(`[stripe] errore gestione evento ${event.type}:`, err.message);
    // Non ritornare errore a Stripe — altrimenti riprova all'infinito
  }

  res.json({ received: true });
}

// ─── GET /api/stripe/status ───────────────────────────────────────────────────
async function getSubscriptionStatus(req, res) {
  const [user, sub] = await Promise.all([
    prisma.user.findUnique({
      where:  { id: req.userId },
      select: { isSubscribed: true },
    }),
    prisma.subscription.findUnique({ where: { userId: req.userId } }),
  ]);

  return success(res, {
    isSubscribed: user?.isSubscribed ?? false,
    subscription: sub ? {
      status:          sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
    } : null,
  });
}

// ─── POST /api/stripe/cancel ──────────────────────────────────────────────────
async function cancelSubscription(req, res) {
  const sub = await prisma.subscription.findUnique({ where: { userId: req.userId } });

  if (!sub?.stripeSubscriptionId) {
    return error(res, 'Nessun abbonamento attivo da cancellare', 404);
  }

  await stripe.subscriptions.cancel(sub.stripeSubscriptionId);

  await prisma.$transaction([
    prisma.subscription.update({
      where: { userId: req.userId },
      data:  { status: 'canceled' },
    }),
    prisma.user.update({
      where: { id: req.userId },
      data:  { isSubscribed: false },
    }),
  ]);

  return success(res, { message: 'Abbonamento cancellato' });
}

module.exports = { getCheckoutUrl, handleWebhook, getSubscriptionStatus, cancelSubscription };
