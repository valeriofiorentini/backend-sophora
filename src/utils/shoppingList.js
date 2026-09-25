'use strict';

/**
 * shoppingList.js
 *
 * L'assistente AI mette la lista della spesa in un blocco
 * <shopping_list>{...JSON...}</shopping_list> alla fine della risposta.
 * Se la risposta e' lunga (una lista "ricca" con molti prodotti) il modello
 * puo' fermarsi per il limite di token PRIMA di chiudere il tag: il JSON resta
 * a meta' e prima non veniva riconosciuto (nessuna scheda lista, blocco grezzo
 * visibile in chat). Qui si recupera cio' che e' completo.
 */

const OPEN = '<shopping_list>';
const CLOSE = '</shopping_list>';

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Da un JSON troncato a meta' recupera gli elementi COMPLETI dell'array "items". */
function salvageTruncated(raw) {
  const key = raw.indexOf('"items"');
  if (key < 0) return null;
  const arr = raw.indexOf('[', key);
  if (arr < 0) return null;

  const items = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = arr + 1; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        const item = tryParse(raw.slice(start, i + 1));
        if (item) items.push(item);
        start = -1;
      }
    } else if (c === ']' && depth === 0) {
      break;
    }
  }
  if (!items.length) return null;

  const total = items.reduce((s, it) => s + (Number(it.estimatedPrice) || 0), 0);
  return { items, estimatedTotal: Math.round(total * 100) / 100, truncated: true };
}

/**
 * @param {string} text risposta completa del modello
 * @returns {object|null} metadata della lista (con `items`) o null se assente/irrecuperabile
 */
function extractShoppingList(text) {
  if (typeof text !== 'string') return null;
  const open = text.indexOf(OPEN);
  if (open < 0) return null;

  const bodyStart = open + OPEN.length;
  const close = text.indexOf(CLOSE, bodyStart);
  const raw = close >= 0 ? text.slice(bodyStart, close) : text.slice(bodyStart);

  const parsed = tryParse(raw.trim());
  if (parsed && Array.isArray(parsed.items)) return parsed;
  return salvageTruncated(raw);
}

module.exports = { extractShoppingList };
