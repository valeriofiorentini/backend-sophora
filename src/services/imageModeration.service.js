'use strict';

/**
 * imageModeration.service.js
 *
 * Controllo automatico di sicurezza sulle immagini caricate dagli utenti
 * nel feed community, PRIMA che vengano pubblicate e diventino visibili
 * ad altri utenti. Usa lo stesso modello Vision già in uso per l'OCR
 * scontrini (GPT-4o via OpenRouter), chiedendogli semplicemente un
 * giudizio sì/no invece dell'estrazione testo.
 *
 * Fail-safe: se il controllo fallisce per un errore tecnico (timeout,
 * API down), l'immagine viene APPROVATA di default — meglio un contenuto
 * raro non controllato che bloccare la pubblicazione per un errore di rete.
 * La segnalazione manuale resta comunque disponibile come rete di sicurezza.
 */

const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey:  process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENROUTER_API_KEY ? 'https://openrouter.ai/api/v1' : undefined,
});
const MODEL = process.env.OPENROUTER_API_KEY ? 'openai/gpt-4o' : 'gpt-4o';

/**
 * @param {string} imageUrl URL pubblico dell'immagine da controllare
 * @returns {Promise<{safe: boolean, reason: string|null}>}
 */
async function checkImageSafety(imageUrl) {
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Questa immagine verrà pubblicata pubblicamente in un feed di offerte/sconti di un\'app di shopping. Contiene nudità, contenuti sessuali espliciti, violenza grafica reale, o materiale palesemente illegale? Rispondi SOLO con un JSON: {"unsafe": true|false, "reason": "breve motivo se unsafe, altrimenti null"}',
            },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    const text = completion.choices?.[0]?.message?.content?.trim() || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    if (parsed.unsafe === true) {
      return { safe: false, reason: parsed.reason || 'Contenuto inappropriato rilevato' };
    }
    return { safe: true, reason: null };
  } catch (err) {
    console.warn('[imageModeration] controllo fallito, approvo per default:', err.message);
    return { safe: true, reason: null };
  }
}

module.exports = { checkImageSafety };
