/**
 * canonicalizeChain — normalizza il nome catena in una forma canonica.
 *
 * storeChain è testo libero estratto dall'OCR/volantini: la stessa insegna
 * arriva con maiuscole/spazi/varianti diverse (es. "IPER COOP", "Ipercoop",
 * "EXTRACOOP") e finisce come catene distinte → offerte duplicate in
 * "Offerte vicino a te" e statistiche frammentate. Qui si riconducono le
 * varianti note a una forma unica; le catene non mappate vengono solo
 * ripulite (trim + spazi singoli), preservando il nome com'è.
 */

// Alias → forma canonica. Ogni regex viene testata sul nome grezzo (case-insensitive).
// L'ordine conta: la prima che matcha vince.
const ALIASES = [
  [/\b(iper\s*coop|extra\s*coop|super\s*coop|ipercoop|extracoop|supercoop)\b/i, 'Ipercoop'],
  [/\bcoop\b/i,                     'Coop'],
  [/\bconad\b/i,                    'Conad'],
  [/\bcarrefour\b/i,                'Carrefour'],
  [/\besselunga\b/i,                'Esselunga'],
  [/\beurospin\b/i,                 'Eurospin'],
  [/\blidl\b/i,                     'Lidl'],
  [/\b(penny\s*market|penny)\b/i,   'Penny'],
  [/\bfamila\b/i,                   'Famila'],
  [/\b(pam|panorama)\b/i,           'Pam'],
  [/\bdespar\b/i,                   'Despar'],
  [/\btigros\b/i,                   'Tigros'],
  [/\btodis\b/i,                    'Todis'],
  [/\bbennet\b/i,                   'Bennet'],
  [/\b(md\s*discount|\bmd\b)\b/i,   'MD'],
  [/\bpim\b/i,                      'Pim'],
  [/\bcrai\b/i,                     'Crai'],
  [/\baldi\b/i,                     'Aldi'],
  [/\bsigma\b/i,                    'Sigma'],
  [/\bal[iì]\s*(super|per)?\b/i,    'Alì'],
  [/\btigre\b/i,                    'Tigre'],
  [/\bemisfero\b/i,                 'Emisfero'],
  [/\btosano\b/i,                   'Tosano'],
  [/\brossetto\b/i,                 'Rossetto'],
  [/\bmercat[oò]\b/i,               'Mercatò'],
  [/\biper\s*triscount\b/i,         'Ipertriscount'],
];

function canonicalizeChain(raw) {
  if (raw == null) return raw;
  const trimmed = String(raw).replace(/\s+/g, ' ').trim();
  if (!trimmed) return trimmed;
  for (const [re, canonical] of ALIASES) {
    if (re.test(trimmed)) return canonical;
  }
  return trimmed; // catena non mappata: solo ripulita
}

module.exports = { canonicalizeChain };
