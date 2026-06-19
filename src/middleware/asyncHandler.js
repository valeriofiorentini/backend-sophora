/**
 * asyncHandler — wrappa le route handler async di Express 4.
 *
 * Express 4 NON gestisce automaticamente le promise rejected delle route async:
 * un'eccezione non catturata in un handler async causa un UnhandledPromiseRejection
 * che NON viene intercettato dall'errorHandler middleware.
 *
 * Uso:
 *   router.get('/path', asyncHandler(myAsyncFn));
 *
 * Con questo wrapper qualsiasi errore viene passato a next(err)
 * → gestito dal middleware errorHandler centralizzato.
 */
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
