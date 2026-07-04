/**
 * lang — mappa lingua utente (User.language) → nome leggibile per i prompt AI.
 *
 * Prima era duplicata verbatim in chat.controller e pantry.controller; qui
 * centralizzata così una nuova lingua si aggiunge in un solo punto.
 * Ogni controller mantiene la propria frase di istruzione (il testo cambia:
 * la chat dice "Rispondi in…", la dispensa "Scrivi nomi e consigli in…").
 */
const LANG_NAMES = {
  it: 'italiano',
  en: 'inglese (English)',
  fr: 'francese (français)',
  es: 'spagnolo (español)',
  de: 'tedesco (Deutsch)',
};

// Nome lingua con fallback all'italiano se il codice è sconosciuto/assente.
function langName(code) {
  return LANG_NAMES[code] ?? LANG_NAMES.it;
}

module.exports = { LANG_NAMES, langName };
