const OpenAI = require('openai');
const prisma = require('../config/database');
const { success, error } = require('../utils/response');
const { checkChatLimit } = require('../utils/planLimits');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});

// claude-haiku-4-5 via OpenRouter, fallback a gpt-4o-mini se non disponibile
const CHAT_MODEL = process.env.OPENROUTER_API_KEY
  ? 'anthropic/claude-haiku-4-5'
  : 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Sei Shopora AI, un assistente italiano per la spesa intelligente.
Conosci i prezzi medi approssimativi dei supermercati italiani (Lidl, Esselunga, Conad, Carrefour, Eurospin, Penny, Coop, Aldi, MD, Iper).
Il tuo scopo è aiutare l'utente a spendere meno e mangiare meglio.

Quando l'utente descrive un budget, esigenze di cucina o dieta, rispondi con:
1. Una lista della spesa dettagliata con quantità e prezzi stimati
2. Il supermercato più conveniente per quella lista
3. La stima del costo totale
4. Suggerimenti pratici per risparmiare

Se generi una lista spesa strutturata, incluila SEMPRE in questo formato tra tag speciali:
<shopping_list>{"items":[{"name":"...","quantity":1,"estimatedPrice":0.00,"unit":"pz/kg/l","category":"..."}],"estimatedTotal":0.00,"recommendedStore":"...","savingsVsAvg":0.00}</shopping_list>

Sii conciso e pratico. Non inventare prezzi precisi, usa stime ragionevoli.`;

// Lingua di risposta: segue User.language (impostata dall'app)
const LANG_NAMES = {
  it: 'italiano',
  en: 'inglese (English)',
  fr: 'francese (français)',
  es: 'spagnolo (español)',
  de: 'tedesco (Deutsch)',
};
function langInstruction(code) {
  const name = LANG_NAMES[code] ?? LANG_NAMES.it;
  return `\nRispondi SEMPRE in ${name}, indipendentemente dalla lingua del messaggio.`;
}

const SESSION_MAX = 50; // max sessioni per utente

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
  const chatLimit = await checkChatLimit(req.userId);
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

  // Load user context (budget, diet profile, lingua)
  const userProfile = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { name: true, monthlyBudget: true, nutritionProfile: true, language: true },
  });

  let contextAddendum = langInstruction(userProfile?.language);
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
      max_tokens: 1024,
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
    let metadata = null;
    const listMatch = fullResponse.match(/<shopping_list>([\s\S]*?)<\/shopping_list>/);
    if (listMatch) {
      try {
        metadata = JSON.parse(listMatch[1]);
      } catch {
        // ignore parse errors
      }
    }

    // Save assistant message
    const assistantMsg = await prisma.chatMessage.create({
      data: { sessionId: session.id, role: 'assistant', content: fullResponse, metadata },
    });

    // Update session timestamp
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { updatedAt: new Date() },
    });

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
    select: { name: true, monthlyBudget: true, nutritionProfile: true, language: true },
  });

  let contextAddendum = langInstruction(userProfile?.language);
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
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + contextAddendum },
        ...anthropicMessages,
      ],
    });

    const fullResponse = response.choices[0]?.message?.content || '';

    let metadata = null;
    const listMatch = fullResponse.match(/<shopping_list>([\s\S]*?)<\/shopping_list>/);
    if (listMatch) { try { metadata = JSON.parse(listMatch[1]); } catch {} }

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
