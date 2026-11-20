import { models } from './models.js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const reply = (data, status = 200, extraHeaders = {}) =>
  Response.json(data, {status, headers:{...headers,...extraHeaders}});

function retryDelay(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const ms = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : null;
}

async function providerFailure(response, model) {
  const data = await response.json().catch(() => ({}));
  const detail = [data?.error?.code, data?.error?.type, data?.error?.message,
    data?.code, data?.message, typeof data?.error === 'string' ? data.error : ''].join(' ').toLowerCase();
  const status = response.status;
  const delay = retryDelay(response);
  if (status === 402 || /insufficient.?quota|insufficient.?balance|quota.?exhaust|credit.?balance|free.{0,25}allowance.{0,20}exhaust/.test(detail))
    return {status:402, message:`APINEX has insufficient allowance for ${model.name} on this account. Check the account’s model allowance.`};
  if (status === 429)
    return {status, delay, retryable:delay !== null && delay <= 4,
      message:delay ? `APINEX rate-limited ${model.name}. Try again in ${delay} seconds.` : `APINEX rate-limited ${model.name}. Wait before retrying.`};
  if (status === 404 || /model.{0,20}(not found|not exist|disabled|not available)|model_not_found/.test(detail))
    return {status:503, message:`APINEX reports that ${model.name} is unavailable for this request.`};
  if (status === 401 || status === 403)
    return {status:502, message:`APINEX denied this account access to ${model.name}.`};
  if (/context.length|context window|too many tokens/.test(detail))
    return {status:400, message:`This conversation exceeds the context limit for ${model.name}. Try a shorter conversation.`};
  if ([500,502,503,504].includes(status))
    return {status:503, delay, retryable:delay === null || delay <= 4, message:`APINEX could not serve ${model.name} right now. Please try later.`};
  return {status:502, message:`APINEX rejected the request to ${model.name} (provider HTTP ${status}).`};
}

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
  // A truncated conversation must still begin with the user's turn.
  if (recent[0]?.role === 'assistant') recent.shift();
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
  } : {model:model.id, messages};
  try {
    const deadline = AbortSignal.timeout(115000);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch('https://api.apinex.bond/v1/' + path, {
        method:'POST',
        headers:{'Authorization':'Bearer ' + key, 'Content-Type':'application/json'},
        redirect:'error',
        body:JSON.stringify(payload),
        signal:deadline,
      });
      if (!response.ok) {
        const failure = await providerFailure(response,model);
        if (attempt === 0 && failure.retryable && !deadline.aborted) {
          await new Promise(resolve => setTimeout(resolve,(failure.delay ?? 1) * 1000));
          continue;
        }
        return reply({error:failure.message},failure.status,
          failure.delay ? {'Retry-After':String(failure.delay)} : {});
      }
      const data = await response.json();
      if (model.decision) {
        const p = data?.answers?.answer?.noul;
        if (typeof p === 'number' && p >= 0 && p <= 1)
          return reply({model:model.id, text:'Estimated probability of yes: ' + (p * 100).toFixed(1) + '%.'});
      } else {
        const content = data?.choices?.[0]?.message?.content;
        const text = Array.isArray(content)
          ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('')
          : content;
        if (typeof text === 'string' && text.trim()) return reply({model:model.id,text});
      }
      return reply({error:'The selected model returned no usable answer.'},502);
    }
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError')
      return reply({error:`${model.name} took too long to respond. Try a shorter question or retry later.`},504);
    return reply({error:'Could not reach APINEX. Please try again later.'},502);
  }
}
