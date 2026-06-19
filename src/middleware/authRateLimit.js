/**
 * authRateLimit — rate limiting per IP sugli endpoint di autenticazione.
 *
 * Usa Redis se disponibile, altrimenti in-memory (stesso pattern redis.service).
 * Più restrittivo del rateLimitMiddleware generico perché basato su IP
 * (non su userId — l'utente non è ancora autenticato).
 *
 * Limiti applicati:
 *  - login:            5 tentativi / 15 minuti   (bruteforce password)
 *  - signup:           10 tentativi / ora         (spam account)
 *  - forgot-password:  5 tentativi / ora          (email bombing)
 *  - verify-otp:       5 tentativi / 10 minuti    (OTP bruteforce)
 *  - change-password:  5 tentativi / 15 minuti
 *  - guest-login:      10 tentativi / ora          (account flooding)
 */

const redis      = require('../services/redis.service');
const { error }  = require('../utils/response');

function ipRateLimit(maxRequests, windowSeconds, label) {
  return async (req, res, next) => {
    // Usa X-Forwarded-For se dietro proxy/Railway, altrimenti IP diretto
    const ip  = (req.headers['x-forwarded-for'] ?? req.ip ?? 'unknown')
                  .split(',')[0].trim();
    const key = `authlimit:${label}:${ip}`;

    const { allowed, remaining, resetIn } = await redis.rateLimit(key, maxRequests, windowSeconds);

    res.setHeader('X-RateLimit-Limit',     maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset',     resetIn);

    if (!allowed) {
      const minutes = Math.ceil(resetIn / 60);
      return error(
        res,
        `Troppi tentativi. Riprova tra ${minutes > 1 ? `${minutes} minuti` : `${resetIn} secondi`}.`,
        429,
      );
    }
    next();
  };
}

module.exports = {
  loginLimit:          ipRateLimit(5,  15 * 60, 'login'),
  signupLimit:         ipRateLimit(10,  60 * 60, 'signup'),
  forgotPasswordLimit: ipRateLimit(5,   60 * 60, 'forgot'),
  verifyOtpLimit:      ipRateLimit(5,  10 * 60, 'otp'),
  changePasswordLimit: ipRateLimit(5,  15 * 60, 'change_pwd'),
  guestLoginLimit:     ipRateLimit(10,  60 * 60, 'guest'),
};
