const OpenAI = require('openai');

// OpenRouter supporta /embeddings (verificato): stessa chiave e crediti dell'OCR.
// Fallback su OPENAI_API_KEY diretta se OpenRouter non è configurato.
const useOpenRouter = !!process.env.OPENROUTER_API_KEY;
const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: useOpenRouter ? 'https://openrouter.ai/api/v1' : undefined,
});

// Su OpenRouter i modelli OpenAI hanno il prefisso 'openai/'
const EMBED_MODEL = useOpenRouter ? 'openai/text-embedding-3-small' : 'text-embedding-3-small';

// Simple in-process cache: text → vector  (TTL: 1h)
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Embed a single text string.
 * Uses text-embedding-3-small: 1536 dims, ~$0.00002 / 1k tokens.
 */
async function embed(text) {
  const key = text.slice(0, 200);
  const cached = cache.get(key);
  if (cached && cached.exp > Date.now()) return cached.vec;

  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text.slice(0, 8000),
  });
  const vec = res.data[0].embedding;
  cache.set(key, { vec, exp: Date.now() + CACHE_TTL_MS });
  return vec;
}

/**
 * Embed multiple texts in a single API call (cheaper).
 */
async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts.map(t => t.slice(0, 8000)),
  });
  return res.data.map(d => d.embedding);
}

/**
 * Build a product embedding input string from name + category + brand.
 */
function productEmbedInput({ name, category, brand }) {
  return [name, category, brand].filter(Boolean).join(' | ').toLowerCase();
}

module.exports = { embed, embedBatch, productEmbedInput };
