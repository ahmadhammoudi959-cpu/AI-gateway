import { usageFrom } from '../billing.js';
import { num, randomBase62, scrubSecrets } from '../util.js';
import { SSEParser, startSSE, safeWrite, safeEnd } from './sse.js';
import { GatewayError, providerHeaders, providerUrl, upstreamFetch, upstreamError, readJson } from './upstream.js';

const bytes = (s) => (typeof s === 'string' ? Buffer.byteLength(s) : 0);

// ───────────────────────── OpenAI chat request → Anthropic Messages request ─────────────────────────

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.type === 'input_text' ? p.text || '' : ''))
      .join('\n');
  }
  return '';
}

function dataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ''));
  return m ? { media_type: m[1], data: m[2] } : null;
}

function partToBlock(p) {
  if (p == null) return null;
  if (typeof p === 'string') return p.trim() ? { type: 'text', text: p } : null;
  switch (p.type) {
    case 'text':
    case 'input_text':
      return p.text && String(p.text).trim() ? { type: 'text', text: String(p.text) } : null;
    case 'image_url': {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      const d = dataUrl(url);
      if (d) return { type: 'image', source: { type: 'base64', media_type: d.media_type, data: d.data } };
      return url ? { type: 'image', source: { type: 'url', url } } : null;
    }
    case 'file': {
      const d = dataUrl(p.file?.file_data);
      if (d && d.media_type === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.data } };
      }
      return null;
    }
    default:
      return null;
  }
}

function toBlocks(content) {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (Array.isArray(content)) return content.map(partToBlock).filter(Boolean);
  return [];
}

function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  try {
    const v = JSON.parse(args || '{}');
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return { raw: String(args) };
  }
}

export function toAnthropicRequest(body, model) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  for (const msg of body.messages || []) {
    const role = msg?.role;
    if (role === 'system' || role === 'developer') {
      const t = textOf(msg.content);
      if (t.trim()) system.push(t);
    } else if (role === 'user') {
      push('user', toBlocks(msg.content));
    } else if (role === 'assistant') {
      const blocks = [];
      const t = textOf(msg.content);
      if (t.trim()) blocks.push({ type: 'text', text: t });
      for (const tc of msg.tool_calls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: parseArgs(tc.function?.arguments) });
      }
      if (msg.function_call) {
        blocks.push({ type: 'tool_use', id: 'call_' + randomBase62(12), name: msg.function_call.name, input: parseArgs(msg.function_call.arguments) });
      }
      push('assistant', blocks);
    } else if (role === 'tool' || role === 'function') {
      const content = typeof msg.content === 'string' ? msg.content : toBlocks(msg.content);
      const block = { type: 'tool_result', tool_use_id: msg.tool_call_id || msg.name };
      if (content.length) block.content = content;
      push('user', [block]);
    }
  }

  // A final assistant turn is a prefill and may not end with whitespace.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    const lb = last.content[last.content.length - 1];
    if (lb?.type === 'text') lb.text = lb.text.replace(/\s+$/, '');
  }

  const fmt = body.response_format;
  if (fmt?.type === 'json_object' || fmt?.type === 'json_schema') {
    const schema = fmt.json_schema?.schema ? `\nJSON schema:\n${JSON.stringify(fmt.json_schema.schema)}` : '';
    system.push(`Respond only with a valid JSON object, without markdown fences or extra text.${schema}`);
  }

  // Anthropic requires max_tokens; OpenAI clients often omit it.
  const defaultMax = num(model.default_max_tokens) > 0 ? num(model.default_max_tokens) : 16384;
  const requestedMax = body.max_completion_tokens ?? body.max_tokens;
  const out = {
    model: model.upstream_model,
    messages,
    max_tokens: requestedMax != null ? Math.max(1, Math.floor(num(requestedMax, defaultMax))) : defaultMax,
  };
  if (system.length) out.system = system.join('\n\n');
  if (body.temperature != null) out.temperature = Math.min(1, Math.max(0, num(body.temperature, 1)));
  else if (body.top_p != null) out.top_p = num(body.top_p); // newer Claude models accept only one of the two
  if (body.top_k != null) out.top_k = num(body.top_k);
  const stops = (Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : []).filter((s) => typeof s === 'string' && s.trim());
  if (stops.length) out.stop_sequences = stops;
  if (body.stream === true) out.stream = true;
  if (typeof body.user === 'string' && body.user) out.metadata = { user_id: body.user.slice(0, 256) };
  if (body.thinking && typeof body.thinking === 'object') out.thinking = body.thinking;

  const fnTools = (body.tools || [])
    .filter((t) => t && (t.type === 'function' || t.function))
    .map((t) => t.function || t)
    .concat(body.functions || []);
  if (fnTools.length) {
    out.tools = fnTools.map((f) => ({
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      input_schema: f.parameters && typeof f.parameters === 'object' ? f.parameters : { type: 'object', properties: {} },
    }));
    const tc = body.tool_choice ?? body.function_call;
    let choice;
    if (tc === 'required') choice = { type: 'any' };
    else if (tc === 'none') choice = { type: 'none' };
    else if (tc && typeof tc === 'object' && (tc.function?.name || tc.name)) choice = { type: 'tool', name: tc.function?.name || tc.name };
    else if (tc === 'auto') choice = { type: 'auto' };
    if (body.parallel_tool_calls === false && choice?.type !== 'none') {
      choice = { ...(choice || { type: 'auto' }), disable_parallel_tool_use: true };
    }
    if (choice) out.tool_choice = choice;
  }
  return out;
}

// ───────────────────────── Anthropic response → OpenAI chat completion ─────────────────────────

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', pause_turn: 'stop', refusal: 'content_filter' };
const finishReason = (r) => FINISH[r] || (r ? 'stop' : null);

function openaiUsage(u) {
  const prompt = num(u?.input_tokens) + num(u?.cache_creation_input_tokens) + num(u?.cache_read_input_tokens);
  const completion = num(u?.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: num(u?.cache_read_input_tokens) },
  };
}

export function fromAnthropicMessage(msg, alias) {
  let text = '';
  const toolCalls = [];
  for (const b of msg.content || []) {
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'tool_use') {
      toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    }
  }
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : ''), refusal: null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: 'chatcmpl-' + (msg.id || randomBase62(24)),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: alias,
    choices: [{ index: 0, message, finish_reason: finishReason(msg.stop_reason), logprobs: null }],
    usage: openaiUsage(msg.usage),
  };
}

/** /v1/chat/completions served by Claude: translate request and response (incl. streaming + tools). */
export async function anthropicChat({ model, body, res, signal, state }) {
  const p = model.provider;
  const stream = body.stream === true;
  const clientWantsUsage = stream && body.stream_options?.include_usage === true;
  const payload = toAnthropicRequest(body, model);
  if (!payload.messages.length) {
    throw new GatewayError(400, 'invalid_messages', 'At least one user message with content is required.');
  }
  const r = await upstreamFetch(providerUrl(p, 'v1/messages'), {
    method: 'POST',
    headers: providerHeaders(p, { stream }),
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) throw await upstreamError(r, p);

  if (!stream) {
    const msg = await readJson(r);
    if (msg?.type === 'error') {
      throw new GatewayError(502, 'upstream_error', scrubSecrets(msg.error?.message || 'Provider error', [p.apiKey]), { retryable: true });
    }
    const out = fromAnthropicMessage(msg, model.alias);
    state.usage = usageFrom.anthropic(msg.usage);
    state.outBytes = bytes(out.choices[0].message.content || '');
    state.started = true;
    if (!res.writableEnded && !res.destroyed) res.status(200).json(out);
    return state;
  }

  startSSE(res);
  state.started = true;
  const id = 'chatcmpl-' + randomBase62(24);
  const created = Math.floor(Date.now() / 1000);
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let haveUsage = false;
  let stopReason = null;
  let finished = false;
  const toolIndex = new Map();
  let tools = 0;
  const chunk = (delta, finish = null) =>
    safeWrite(
      res,
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model.alias, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] })}\n\n`,
    );
  const mergeUsage = (u) => {
    if (!u) return;
    haveUsage = true;
    for (const k of Object.keys(usage)) if (u[k] != null) usage[k] = num(u[k]);
  };
  const parser = new SSEParser();
  const handle = (ev) => {
    if (!ev.data) return;
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (d.type) {
      case 'message_start':
        mergeUsage(d.message?.usage);
        chunk({ role: 'assistant', content: '' });
        break;
      case 'content_block_start': {
        const cb = d.content_block || {};
        if (cb.type === 'tool_use') {
          const idx = tools++;
          toolIndex.set(d.index, idx);
          chunk({ tool_calls: [{ index: idx, id: cb.id, type: 'function', function: { name: cb.name, arguments: '' } }] });
        } else if (cb.type === 'text' && cb.text) {
          state.outBytes += bytes(cb.text);
          chunk({ content: cb.text });
        }
        break;
      }
      case 'content_block_delta': {
        const dl = d.delta || {};
        if (dl.type === 'text_delta') {
          state.outBytes += bytes(dl.text);
          chunk({ content: dl.text });
        } else if (dl.type === 'input_json_delta') {
          state.outBytes += bytes(dl.partial_json);
          chunk({ tool_calls: [{ index: toolIndex.get(d.index) ?? 0, function: { arguments: dl.partial_json } }] });
        } else if (dl.type === 'thinking_delta') {
          state.outBytes += bytes(dl.thinking);
        }
        break;
      }
      case 'message_delta':
        if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
        mergeUsage(d.usage);
        break;
      case 'message_stop':
        finished = true;
        break;
      case 'error': {
        const message = scrubSecrets(d.error?.message || 'Provider stream error', [p.apiKey]);
        safeWrite(res, `data: ${JSON.stringify({ error: { message, type: d.error?.type || 'api_error' } })}\n\n`);
        finished = true;
        state.interrupted = true;
        break;
      }
      default:
        break;
    }
  };
  try {
    for await (const c of r.body) for (const ev of parser.feed(c)) handle(ev);
    for (const ev of parser.flush()) handle(ev);
  } catch {
    if (signal?.aborted) state.aborted = true;
    else state.interrupted = true;
  }
  state.usage = haveUsage ? usageFrom.anthropic(usage) : null;
  if (!finished && !state.aborted) state.interrupted = true;
  if (!state.aborted) {
    chunk({}, finishReason(stopReason) || 'stop');
    if (clientWantsUsage && haveUsage) {
      safeWrite(res, `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model.alias, choices: [], usage: openaiUsage(usage) })}\n\n`);
    }
    safeWrite(res, 'data: [DONE]\n\n');
    safeEnd(res);
  }
  return state;
}

// ───────────────────────── Native /v1/messages (Anthropic SDK apps) ─────────────────────────

/**
 * Relays an Anthropic-format request unchanged (apps that use the official Anthropic SDK only
 * swap ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL). Usage is read from the response / stream events.
 */
export async function anthropicNative({ model, body, req, res, signal, state, path = 'v1/messages', bill = true }) {
  const p = model.provider;
  const stream = body.stream === true;
  const payload = { ...body, model: model.upstream_model };
  const r = await upstreamFetch(providerUrl(p, path), {
    method: 'POST',
    headers: providerHeaders(p, {
      stream,
      anthropicVersion: req.get('anthropic-version'),
      anthropicBeta: req.get('anthropic-beta'),
    }),
    body: JSON.stringify(payload),
    signal,
  });
  if (!r.ok) throw await upstreamError(r, p);
  const ct = r.headers.get('content-type') || 'application/json';

  if (ct.includes('text/event-stream')) {
    startSSE(res);
    state.started = true;
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    let haveUsage = false;
    const merge = (u) => {
      if (!u) return;
      haveUsage = true;
      for (const k of Object.keys(usage)) if (u[k] != null) usage[k] = num(u[k]);
    };
    const parser = new SSEParser();
    const onEvent = (ev) => {
      if (!ev.data) return;
      let d;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (d.type === 'message_start') merge(d.message?.usage);
      else if (d.type === 'message_delta') merge(d.usage);
      else if (d.type === 'content_block_delta') {
        state.outBytes += bytes(d.delta?.text) + bytes(d.delta?.partial_json) + bytes(d.delta?.thinking);
      }
    };
    try {
      for await (const c of r.body) {
        safeWrite(res, c);
        for (const ev of parser.feed(c)) onEvent(ev);
      }
      for (const ev of parser.flush()) onEvent(ev);
    } catch {
      if (signal?.aborted) state.aborted = true;
      else state.interrupted = true;
    }
    state.usage = haveUsage ? usageFrom.anthropic(usage) : null;
    if (!state.aborted) safeEnd(res);
    return state;
  }

  const text = await r.text();
  if (bill) {
    try {
      const msg = JSON.parse(text);
      state.usage = usageFrom.anthropic(msg.usage);
      for (const b of msg.content || []) state.outBytes += bytes(b.text);
    } catch {
      throw new GatewayError(502, 'upstream_bad_response', 'The AI provider returned an invalid response.', { retryable: true });
    }
  }
  state.started = true;
  if (!res.writableEnded && !res.destroyed) res.status(r.status).type(ct).send(text);
  return state;
}
