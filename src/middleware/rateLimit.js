const redis = require('../services/redis.service');
const { error } = require('../utils/response');

/**
 * Rate limit middleware factory.
 * @param {number} maxRequests - max requests allowed per window
 * @param {number} windowSeconds - window duration in seconds
 * @param {string} label - used in the key (e.g. 'chat', 'receipt_scan')
 */
function rateLimitMiddleware(maxRequests, windowSeconds, label) {
  return async (req, res, next) => {
    const userId = req.userId || req.ip;
    const key = `ratelimit:${label}:${userId}`;
    const { allowed, remaining, resetIn } = await redis.rateLimit(key, maxRequests, windowSeconds);

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', resetIn);

    if (!allowed) {
      return error(res, `Troppe richieste. Riprova tra ${resetIn} secondi.`, 429);
    }
    next();
  };
}

// Pre-built limiters for AI endpoints
const chatRateLimit = rateLimitMiddleware(20, 60, 'chat');       // 20 msg/min
const receiptRateLimit = rateLimitMiddleware(10, 60, 'receipt'); // 10 scan/min
const flyerRateLimit = rateLimitMiddleware(5, 60, 'flyer');      // 5 scan/min

module.exports = { rateLimitMiddleware, chatRateLimit, receiptRateLimit, flyerRateLimit };
