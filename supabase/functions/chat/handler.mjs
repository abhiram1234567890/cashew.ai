import { models } from './models.js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const reply = (data, status = 200) => Response.json(data, {status, headers});
function isMessage(value) {
  return value && (value.role === 'user' || value.role === 'assistant') &&
    typeof value.content === 'string' && value.content.length > 0;
}

export async function handleChat(req, apiKey) {
  if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers});
  if (req.method !== 'POST') return reply({error: 'Use POST.'}, 405);
  let body;
  try { body = await req.json(); } catch { return reply({error:'Invalid request.'}, 400); }
  const model = models.find(m => m.id === (body?.model ?? models[0].id));
  if (!model) return reply({error:'Select a model from the list.'}, 400);
  if (!Array.isArray(body?.messages)) return reply({error:'Include a question.'}, 400);
  const recent = body.messages.slice(-30);
  if (!recent.length || !recent.every(isMessage) || recent.at(-1).role !== 'user')
    return reply({error:'Include a question.'}, 400);
  const messages = recent.map(m => ({role:m.role, content:m.content.slice(0,60000)}));
  const key = apiKey?.trim();
  if (!key) return reply({error:'The site owner needs to configure APINEX_API_KEY before models can answer.'}, 503);

  const path = model.decision ? 'decisions' : 'chat/completions';
  const payload = model.decision ? {
    model:model.id,
    state:messages,
    questions:{answer:{type:'noul', instructions:messages[messages.length - 1].content}},
  } : {model:model.id, messages, temperature:0.2};
  try {
    const response = await fetch('https://api.apinex.bond/v1/' + path, {
      method:'POST',
      headers:{'Authorization':'Bearer ' + key, 'Content-Type':'application/json'},
      redirect:'error',
      body:JSON.stringify(payload),
      signal:AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      if (response.status === 429) return reply({error:'The provider rate limit was reached. Please try again later.'},429);
      if ([401,403].includes(response.status)) return reply({error:'APINEX denied access. Check the server key and model access.'},502);
      return reply({error:'APINEX could not answer with the selected model.'},502);
    }
    const data = await response.json();
    if (model.decision) {
      const p = data?.answers?.answer?.noul;
      if (typeof p === 'number' && p >= 0 && p <= 1)
        return reply({model:model.id, text:'Estimated probability of yes: ' + (p * 100).toFixed(1) + '%.'});
    } else {
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return reply({model:model.id,text});
    }
    return reply({error:'The selected model returned no usable answer.'},502);
  } catch {
    return reply({error:'Could not complete the request to APINEX. Please try again.'},502);
  }
}
