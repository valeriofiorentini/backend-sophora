/**
 * errorHandler — middleware centralizzato Express.
 *
 * Cattura:
 *  - errori lanciati con throw new Error() o next(err)
 *  - promise rejected passate via asyncHandler → next(err)
 *
 * In produzione NON espone lo stack trace al client.
 */
function errorHandler(err, req, res, _next) {
  // Determina HTTP status
  const statusCode = (typeof err.statusCode === 'number' && err.statusCode >= 100)
    ? err.statusCode
    : err.status ?? 500;

  // Log strutturato server-side
  const isProd = process.env.NODE_ENV === 'production';
  console.error({
    level:    'error',
    method:   req.method,
    url:      req.originalUrl,
    status:   statusCode,
    message:  err.message,
    // stack solo in sviluppo — mai in produzione
    ...(isProd ? {} : { stack: err.stack }),
  });

  // Risposta al client
  res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 && isProd
      ? 'Errore interno del server'   // non esporre dettagli in produzione
      : err.message ?? 'Errore interno del server',
    // Includi codice errore se presente (es. 'INVALID_TOKEN')
    ...(err.code ? { code: err.code } : {}),
  });
}

module.exports = { errorHandler };
