/**
 * Redis client wrapper.
 * Falls back gracefully to a no-op in-memory store if Redis is not configured.
 * Set REDIS_URL in .env to enable (e.g. redis://localhost:6379 or a Upstash URL).
 */

const Redis = require('ioredis');

let client = null;

// Simple in-memory fallback (single-process only)
const memStore = new Map();

function getClient() {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
    });

    client.on('error', err => {
      // Don't crash — just log
      if (!err.message.includes('ECONNREFUSED')) {
        console.warn('Redis error:', err.message);
      }
    });

    return client;
  } catch {
    return null;
  }
}

async function get(key) {
  const c = getClient();
  if (c) {
    try { return await c.get(key); } catch { /* fall through */ }
  }
  const entry = memStore.get(key);
  if (!entry) return null;
  if (entry.exp < Date.now()) { memStore.delete(key); return null; }
  return entry.val;
}

async function set(key, value, ttlSeconds = 3600) {
  const c = getClient();
  if (c) {
    try { await c.set(key, value, 'EX', ttlSeconds); return; } catch { /* fall through */ }
  }
  memStore.set(key, { val: value, exp: Date.now() + ttlSeconds * 1000 });
}

async function del(key) {
  const c = getClient();
  if (c) {
    try { await c.del(key); return; } catch { /* fall through */ }
  }
  memStore.delete(key);
}

/**
 * Simple rate limiter: returns { allowed, remaining, resetIn }
 * Key example: `ratelimit:chat:userId`
 */
async function rateLimit(key, maxRequests, windowSeconds) {
  const c = getClient();
  const now = Date.now();
  const windowKey = `${key}:${Math.floor(now / (windowSeconds * 1000))}`;

  if (c) {
    try {
      const count = await c.incr(windowKey);
      if (count === 1) await c.expire(windowKey, windowSeconds);
      return {
        allowed: count <= maxRequests,
        remaining: Math.max(0, maxRequests - count),
        resetIn: windowSeconds,
      };
    } catch { /* fall through to in-memory */ }
  }

  // In-memory fallback
  const entry = memStore.get(windowKey) || { count: 0, exp: now + windowSeconds * 1000 };
  entry.count++;
  memStore.set(windowKey, entry);
  return {
    allowed: entry.count <= maxRequests,
    remaining: Math.max(0, maxRequests - entry.count),
    resetIn: Math.ceil((entry.exp - now) / 1000),
  };
}

module.exports = { get, set, del, rateLimit };
