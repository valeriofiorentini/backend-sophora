/**
 * validate(schema[, source]) — middleware di validazione zod.
 *
 * Valida req.body (o req.query/req.params) contro lo schema.
 * Se non valido risponde 400 con l'elenco dei campi errati.
 * Se valido, sostituisce req[source] con i dati parsati (tipi coercizzati:
 * "3.5" → 3.5, "true" → true), così i controller lavorano su dati puliti.
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      const details = result.error.issues
        .map(i => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return res.status(400).json({
        success: false,
        message: `Dati non validi — ${details}`,
        code: 'VALIDATION_ERROR',
      });
    }
    req[source] = result.data;
    next();
  };
}

module.exports = { validate };
