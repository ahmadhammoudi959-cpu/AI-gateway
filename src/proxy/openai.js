import { usageFrom } from '../billing.js';
import { scrubSecrets } from '../util.js';
import { SSEParser, startSSE, safeWrite, safeEnd } from './sse.js';
import {
  GatewayError,
  providerHeaders,
  providerUrl,
  upstreamFetch,
  upstreamError,
  upstreamErrorFromText,
  readJson,
} from './upstream.js';

const bytes = (s) => (typeof s === 'string' ? Buffer.byteLength(s) : 0);

function deltaBytes(choice) {
  const d = choice?.delta || choice?.message || {};
  let n = bytes(d.content) + bytes(d.reasoning_content) + bytes(d.reasoning) + bytes(d.refusal);
  for (const tc of d.tool_calls || []) n += bytes(tc?.function?.arguments) + bytes(tc?.function?.name);
  return n;
}

/** /v1/chat/completions on any OpenAI-compatible provider (OpenAI, Gemini, DeepSeek, OpenRouter, Groq…). */
export async function openaiChat({ model, body, res, signal, state }) {
  const p = model.provider;
  const stream = body.stream === true;
  const clientWantsUsage = stream && body.stream_options?.include_usage === true;
  const payload = { ...body, model: model.upstream_model };
  // OpenAI replaced max_tokens with max_completion_tokens (required by reasoning models, accepted by all).
  if (p.preset === 'openai' && payload.max_tokens != null && payload.max_completion_tokens == null) {
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }
  // Always ask for usage on streams — that is how we bill exactly.
  if (stream) payload.stream_options = { ...(body.stream_options || {}), include_usage: true };

  const url = providerUrl(p, 'chat/completions');
  const send = () =>
    upstreamFetch(url, { method: 'POST', headers: providerHeaders(p, { stream }), body: JSON.stringify(payload), signal });

  let r = await send();
  if (!r.ok && stream && r.status === 400) {
    const text = await r.text().catch(() => '');
    if (!/stream_options/i.test(text)) throw upstreamErrorFromText(r.status, text, r.headers, p);
    // Some self-hosted servers reject stream_options — retry once without it (usage will be estimated).
    if (body.stream_options) payload.stream_options = body.stream_options;
    else delete payload.stream_options;
    r = await send();
  }
  if (!r.ok) throw await upstreamError(r, p);

  if (!stream) {
    const json = await readJson(r);
    if (json && typeof json === 'object') {
      if (json.error && !json.choices) {
        throw new GatewayError(502, 'upstream_error', scrubSecrets(json.error?.message || 'Provider error', [p.apiKey]), {
          retryable: true,
        });
      }
      json.model = model.alias;
      state.usage = usageFrom.openai(json.usage);
      state.outBytes = (json.choices || []).reduce((n, c) => n + deltaBytes(c), 0);
    }
    state.started = true;
    if (!res.writableEnded && !res.destroyed) res.status(200).json(json);
    return state;
  }

  startSSE(res);
  state.started = true;
  const parser = new SSEParser();
  let usageRaw = null;

  const handle = (ev) => {
    if (ev.data == null) return;
    const data = ev.data.trim();
    if (!data || data === '[DONE]') return;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      safeWrite(res, `data: ${data}\n\n`);
      return;
    }
    if (obj.error) {
      const message = scrubSecrets(obj.error?.message || 'Provider stream error', [p.apiKey]);
      safeWrite(res, `data: ${JSON.stringify({ error: { ...obj.error, message } })}\n\n`);
      return;
    }
    if (obj.usage) usageRaw = obj.usage;
    else if (obj.x_groq?.usage) usageRaw = obj.x_groq.usage; // Groq reports stream usage here
    for (const c of obj.choices || []) state.outBytes += deltaBytes(c);
    if (obj.model) obj.model = model.alias;
    if (!clientWantsUsage) {
      // The client did not ask for the usage chunk — hide what we added for billing.
      if (obj.usage && (!obj.choices || obj.choices.length === 0)) return;
      delete obj.usage;
    }
    safeWrite(res, `data: ${JSON.stringify(obj)}\n\n`);
  };

  try {
    for await (const chunk of r.body) for (const ev of parser.feed(chunk)) handle(ev);
    for (const ev of parser.flush()) handle(ev);
  } catch (e) {
    if (signal?.aborted) state.aborted = true;
    else {
      state.interrupted = true;
      safeWrite(res, `data: ${JSON.stringify({ error: { message: 'The provider stream was interrupted.', type: 'api_error' } })}\n\n`);
    }
  }
  state.usage = usageFrom.openai(usageRaw);
  if (!state.aborted) {
    safeWrite(res, 'data: [DONE]\n\n');
    safeEnd(res);
  }
  return state;
}

/**
 * Pass-through for OpenAI-style endpoints whose body we do not need to translate
 * (/v1/responses, /v1/embeddings, /v1/images/generations). The response is relayed as-is,
 * only the usage is read for billing.
 */
export async function openaiPassthrough({ model, body, res, signal, state, path, usageKind }) {
  const p = model.provider;
  const payload = { ...body, model: model.upstream_model };
  const wantsStream = body.stream === true;
  const r = await upstreamFetch(providerUrl(p, path), {
    method: 'POST',
    headers: providerHeaders(p, { stream: wantsStream }),
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) throw await upstreamError(r, p);
  const ct = r.headers.get('content-type') || '';

  if (ct.includes('text/event-stream')) {
    startSSE(res);
    state.started = true;
    const parser = new SSEParser();
    const onEvent = (ev) => {
      if (!ev.data || ev.data === '[DONE]') return;
      let obj;
      try {
        obj = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (typeof obj.delta === 'string') state.outBytes += bytes(obj.delta);
      const u = obj.response?.usage || obj.usage;
      if (u) state.usage = usageFrom[usageKind](u);
    };
    try {
      for await (const chunk of r.body) {
        safeWrite(res, chunk);
        for (const ev of parser.feed(chunk)) onEvent(ev);
      }
      for (const ev of parser.flush()) onEvent(ev);
    } catch {
      if (signal?.aborted) state.aborted = true;
      else state.interrupted = true;
    }
    if (!state.aborted) safeEnd(res);
    return state;
  }

  const json = await readJson(r);
  if (json && typeof json === 'object') {
    if (json.model) json.model = model.alias;
    state.usage = usageFrom[usageKind](json.usage);
    if (usageKind === 'images' && !state.usage) {
      // Image models without token usage are billed per image (request_price × n).
      state.usage = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
    }
    if (usageKind === 'images') state.units = Math.max(1, Array.isArray(json.data) ? json.data.length : Number(body.n) || 1);
  }
  state.started = true;
  if (!res.writableEnded && !res.destroyed) res.status(r.status).json(json);
  return state;
}
