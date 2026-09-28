const OpenAI = require('openai');
const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { checkChatLimit } = require('../utils/planLimits');
const { getPlatform } = require('../utils/platform');
const { extractShoppingList } = require('../utils/shoppingList');
const { langName } = require('../utils/lang');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});

// claude-haiku-4-5 via OpenRouter, fallback a gpt-4o-mini se non disponibile
const CHAT_MODEL = process.env.OPENROUTER_API_KEY
  ? 'anthropic/claude-haiku-4-5'
  : 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Sei Shopora AI, un assistente italiano per la spesa intelligente.
Non hai un listino prezzi dei supermercati: conosci solo le offerte reali che ti vengono fornite qui sotto (se presenti).
NON dire mai che un supermercato è "da evitare" o "più caro" senza dati: se non hai dati, dillo e dai solo stime indicative chiaramente etichettate come tali. Mantieniti coerente con quanto detto nei messaggi precedenti della conversazione.
Il tuo scopo è aiutare l'utente a spendere meno e mangiare meglio.

Quando l'utente descrive un budget, esigenze di cucina o dieta, rispondi con:
1. Una lista della spesa dettagliata con quantità e prezzi stimati
2. Il supermercato più conveniente per quella lista
3. La stima del costo totale
4. Suggerimenti pratici per risparmiare

Se generi una lista spesa strutturata, incluila SEMPRE in questo formato tra tag speciali:
<shopping_list>{"items":[{"name":"...","quantity":1,"estimatedPrice":0.00,"unit":"pz/kg/l","category":"..."}],"estimatedTotal":0.00,"recommendedStore":"...","savingsVsAvg":0.00}</shopping_list>

Sii conciso e pratico. Non inventare prezzi precisi: per i prodotti in offerta usa i prezzi reali forniti, per gli altri usa stime ragionevoli indicate come tali.

FORMATTAZIONE: l'app NON sa disegnare tabelle Markdown (i simboli | e --- restano visibili come testo grezzo, illeggibili). Non usare MAI tabelle. Per elenchi di prodotti usa solo titoli (##), grassetto (**) ed elenchi puntati (- voce).`;

// Lingua di risposta: segue User.language (impostata dall'app).
// LANG_NAMES centralizzata in utils/lang (condivisa con pantry.controller).
function langInstruction(code) {
  return `\nRispondi SEMPRE in ${langName(code)}, indipendentemente dalla lingua del messaggio.`;
}

const SESSION_MAX = 50; // max sessioni per utente

const OFFERS_RADIUS_KM = 50;

// Prima: prendeva le ultime offerte attive in tutta Italia senza guardare
// dove si trova l'utente — l'AI consigliava negozi lontanissimi come se
// fossero sotto casa. Ora filtra entro OFFERS_RADIUS_KM dall'ultima
// posizione nota dell'utente (salvata da fcm-token/dashboard). Le offerte
// "nazionali" (senza coordinate, valide ovunque) restano sempre incluse.
async function getOffersContext(userLat, userLon) {
  try {
    const { haversineKm } = require('../services/geo.service');
    const promos = await prisma.promo.findMany({
      where: { validUntil: { gte: new Date() }, price: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: { storeChain: true, storeName: true, productName: true, price: true, originalPrice: true, validUntil: true, latitude: true, longitude: true },
    });
    const nearby = (userLat != null && userLon != null)
      ? promos.filter(p => p.latitude == null || p.longitude == null || haversineKm(userLat, userLon, p.latitude, p.longitude) <= OFFERS_RADIUS_KM)
      : promos.filter(p => p.latitude == null || p.longitude == null); // niente posizione nota: solo le offerte valide ovunque
    const selected = nearby.slice(0, 60);
    if (!selected.length) return '';
    const lines = selected.map(p => `- ${p.storeChain || p.storeName}: ${p.productName} €${p.price}${p.originalPrice ? ` (era €${p.originalPrice})` : ''} fino al ${p.validUntil.toISOString().slice(0, 10)}`);
    return `\nOfferte reali attualmente attive VICINO ALL'UTENTE (usa SOLO questi prezzi come dati certi, e SOLO se il negozio è realmente vicino a lui — non citare mai negozi di altre zone d'Italia):\n${lines.join('\n')}`;
  } catch (e) {
    return '';
  }
}

async function createSession(req, res) {
  // Previeni accumulo infinito di sessioni
  const count = await prisma.chatSession.count({ where: { userId: req.userId } });
  if (count >= SESSION_MAX) {
    return error(res, `Limite sessioni raggiunto (${SESSION_MAX}). Elimina alcune conversazioni prima di crearne di nuove.`, 400);
  }

  const title   = req.body.title?.slice(0, 120) || 'Nuova conversazione';
  const session = await prisma.chatSession.create({
    data: { userId: req.userId, title },
  });
  return success(res, { session }, 201);
}

async function getSessions(req, res) {
  const sessions = await prisma.chatSession.findMany({
    where: { userId: req.userId },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
  return success(res, { sessions });
}

async function getMessages(req, res) {
  const session = await prisma.chatSession.findUnique({
    where: { id: req.params.sessionId },
  });
  if (!session || session.userId !== req.userId) return error(res, 'Sessione non trovata', 404);

  const messages = await prisma.chatMessage.findMany({
    where: { sessionId: req.params.sessionId },
    orderBy: { createdAt: 'asc' },
  });
  return success(res, { messages });
}

const MESSAGE_MAX_LEN = 2000; // caratteri — limita costi OpenAI e DoS

async function sendMessage(req, res) {
  const { sessionId } = req.body;
  const message = req.body.message?.trim();

  if (!message) return error(res, 'Messaggio vuoto');
  if (message.length > MESSAGE_MAX_LEN) {
    return error(res, `Messaggio troppo lungo (massimo ${MESSAGE_MAX_LEN} caratteri)`);
  }

  // Controllo limite piano gratuito (15 messaggi/giorno)
  const chatLimit = await checkChatLimit(req.userId, getPlatform(req));
  if (!chatLimit.allowed) {
    return error(res,
      `Hai raggiunto il limite di ${chatLimit.limit} messaggi al giorno del piano gratuito. ` +
      `Passa a Shopora Premium per domande illimitate.`,
      403,
    );
  }

  // Verify session belongs to user
  let session;
  if (sessionId) {
    session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== req.userId) return error(res, 'Sessione non trovata', 404);
  } else {
    session = await prisma.chatSession.create({
      data: {
        userId: req.userId,
        title: message.slice(0, 60),
      },
    });
  }

  // Save user message
  await prisma.chatMessage.create({
    data: { sessionId: session.id, role: 'user', content: message },
  });

  // Load history (last 20 messages for context)
  // desc + reverse: prende gli ULTIMI 20, poi li rimette in ordine cronologico
  const history = (await prisma.chatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })).reverse();

  // Load user context (budget, diet profile, lingua, posizione)
  const userProfile = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { name: true, monthlyBudget: true, nutritionProfile: true, language: true, latitude: true, longitude: true },
  });

  let contextAddendum = langInstruction(userProfile?.language) + await getOffersContext(userProfile?.latitude, userProfile?.longitude);
  if (userProfile?.monthlyBudget) {
    contextAddendum += `\nBudget mensile dell'utente: €${userProfile.monthlyBudget}.`;
  }
  if (userProfile?.nutritionProfile?.dietType?.length > 0) {
    contextAddendum += `\nDieta dell'utente: ${userProfile.nutritionProfile.dietType.join(', ')}.`;
  }

  const anthropicMessages = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  // SSE streaming response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let fullResponse = '';

  try {
    const stream = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_tokens: 2048, // 1024 troncava le liste lunghe prima di chiudere <shopping_list>
      temperature: 0.3,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + contextAddendum },
        ...anthropicMessages,
      ],
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`);
      }
    }

    // Extract shopping list JSON if present
    const metadata = extractShoppingList(fullResponse);

    // Salva il messaggio assistant e aggiorna il timestamp sessione in
    // un'unica transazione: due scritture correlate, o entrambe o nessuna
    // (evita sessioni con updatedAt stantìo se un write fallisce a metà).
    const [assistantMsg] = await prisma.$transaction([
      prisma.chatMessage.create({
        data: { sessionId: session.id, role: 'assistant', content: fullResponse, metadata },
      }),
      prisma.chatSession.update({
        where: { id: session.id },
        data: { updatedAt: new Date() },
      }),
    ]);

    res.write(`data: ${JSON.stringify({ type: 'done', sessionId: session.id, messageId: assistantMsg.id, metadata })}\n\n`);
  } catch (err) {
    console.error('Claude API error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Errore AI' })}\n\n`);
  } finally {
    res.end();
  }
}

async function deleteSession(req, res) {
  const session = await prisma.chatSession.findUnique({ where: { id: req.params.sessionId } });
  if (!session || session.userId !== req.userId) return error(res, 'Non trovata', 404);
  await prisma.chatSession.delete({ where: { id: req.params.sessionId } });
  return success(res, { message: 'Sessione eliminata' });
}

// Non-streaming version for React Native (fetch non supporta ReadableStream)
async function sendMessageSync(req, res) {
  const { message, sessionId: incomingSessionId } = req.body;
  if (!message?.trim()) return error(res, 'Messaggio obbligatorio');

  let session;
  if (incomingSessionId) {
    session = await prisma.chatSession.findUnique({ where: { id: incomingSessionId } });
    if (!session || session.userId !== req.userId) return error(res, 'Sessione non trovata', 404);
  } else {
    session = await prisma.chatSession.create({
      data: { userId: req.userId, title: message.slice(0, 60) },
    });
  }

  await prisma.chatMessage.create({ data: { sessionId: session.id, role: 'user', content: message } });

  const history = await prisma.chatMessage.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  const userProfile = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { name: true, monthlyBudget: true, nutritionProfile: true, language: true, latitude: true, longitude: true },
  });

  let contextAddendum = langInstruction(userProfile?.language) + await getOffersContext(userProfile?.latitude, userProfile?.longitude);
  if (userProfile?.monthlyBudget) contextAddendum += `\nBudget mensile: €${userProfile.monthlyBudget}.`;
  if (userProfile?.nutritionProfile?.dietType?.length > 0)
    contextAddendum += `\nDieta: ${userProfile.nutritionProfile.dietType.join(', ')}.`;

  const anthropicMessages = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
  }));

  try {
    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      max_tokens: 2048, // 1024 troncava le liste lunghe prima di chiudere <shopping_list>
      temperature: 0.3,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + contextAddendum },
        ...anthropicMessages,
      ],
    });

    const fullResponse = response.choices[0]?.message?.content || '';

    const metadata = extractShoppingList(fullResponse);

    const assistantMsg = await prisma.chatMessage.create({
      data: { sessionId: session.id, role: 'assistant', content: fullResponse, metadata },
    });

    await prisma.chatSession.update({ where: { id: session.id }, data: { updatedAt: new Date() } });

    return success(res, { text: fullResponse, sessionId: session.id, messageId: assistantMsg.id, metadata });
  } catch (err) {
    console.error('Claude API error:', err);
    return error(res, 'Errore AI', 500);
  }
}

module.exports = { createSession, getSessions, getMessages, sendMessage, sendMessageSync, deleteSession };
