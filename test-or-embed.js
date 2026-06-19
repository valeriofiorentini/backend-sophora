require('dotenv').config();

async function tryEmbed(baseURL, model) {
  const res = await fetch(`${baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: 'pasta barilla spaghetti' }),
  });
  const text = await res.text();
  console.log(`[${model}] status=${res.status}`);
  console.log(text.slice(0, 300));
  console.log('---');
}

(async () => {
  await tryEmbed('https://openrouter.ai/api/v1', 'openai/text-embedding-3-small');
  await tryEmbed('https://openrouter.ai/api/v1', 'text-embedding-3-small');
})();
