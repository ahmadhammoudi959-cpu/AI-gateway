// A fake OpenAI + Anthropic + Telegram server used by the tests (no real API keys needed).
import http from 'node:http';

export const OPENAI_KEY = 'sk-real-openai-secret-1234567890';
export const ANTHROPIC_KEY = 'sk-ant-real-secret-0987654321';

const sse = (res, obj, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startMock() {
  const calls = { openai: [], anthropic: [], telegram: [] };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url;
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // ── Telegram ──
    if (url.startsWith('/telegram/')) {
      calls.telegram.push({ url, body });
      return json(200, { ok: true });
    }

    // ── OpenAI-compatible ──
    if (url.startsWith('/openai/')) {
      calls.openai.push({ url, body, headers: req.headers });
      if (req.headers.authorization !== `Bearer ${OPENAI_KEY}`) {
        return json(401, { error: { message: `Incorrect API key provided: ${req.headers.authorization}` } });
      }
      if (url === '/openai/v1/models') return json(200, { object: 'list', data: [{ id: 'gpt-test' }, { id: 'gpt-4o-mini-2024-07-18' }, { id: 'whisper-1' }] });
      if (url === '/openai/v1/embeddings') {
        return json(200, { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: body.model, usage: { prompt_tokens: 10, total_tokens: 10 } });
      }
      if (url === '/openai/v1/images/generations') {
        const n = body.n || 1;
        return json(200, { created: 1, data: Array.from({ length: n }, () => ({ b64_json: 'aGVsbG8=' })) });
      }
      if (url === '/openai/v1/responses') {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(res, { type: 'response.created', response: { id: 'resp_1' } }, 'response.created');
          sse(res, { type: 'response.output_text.delta', delta: 'Hello' }, 'response.output_text.delta');
          sse(res, { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 } } } }, 'response.completed');
          return res.end();
        }
        return json(200, { id: 'resp_1', object: 'response', model: body.model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }], usage: { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 0 } } });
      }
      if (url === '/openai/v1/chat/completions') {
        if (body.model === 'fail-500') return json(500, { error: { message: 'upstream exploded' } });
        if (body.model === 'missing-model') return json(404, { error: { message: 'The model does not exist' } });
        if (body.model === 'bad-request') return json(400, { error: { message: 'Invalid value for temperature' } });
        if (!body.stream) {
          return json(200, {
            id: 'chatcmpl-1',
            object: 'chat.completion',
            created: 1,
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from mock' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } },
          });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const withUsage = body.stream_options?.include_usage === true;
        const base = { id: 'chatcmpl-2', object: 'chat.completion.chunk', created: 1, model: body.model };
        const extra = withUsage ? { usage: null } : {};
        const pieces = body.model === 'slow' ? Array.from({ length: 40 }, () => 'word ') : ['Hel', 'lo'];
        sse(res, { ...base, ...extra, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        for (const p of pieces) {
          if (body.model === 'slow') await sleep(50);
          if (res.destroyed) return;
          sse(res, { ...base, ...extra, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
        }
        sse(res, { ...base, ...extra, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        if (withUsage) sse(res, { ...base, choices: [], usage: { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 } });
        sse(res, '[DONE]');
        return res.end();
      }
      return json(404, { error: { message: 'not found' } });
    }

    // ── Anthropic ──
    if (url.startsWith('/anthropic/')) {
      calls.anthropic.push({ url, body, headers: req.headers });
      if (req.headers['x-api-key'] !== ANTHROPIC_KEY) {
        return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      if (url.startsWith('/anthropic/v1/models')) {
        return json(200, { data: [{ type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }, { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' }], has_more: false });
      }
      if (url === '/anthropic/v1/messages/count_tokens') return json(200, { input_tokens: 42 });
      if (url === '/anthropic/v1/messages') {
        const wantsTool = Array.isArray(body.tools) && body.tools.length && body.messages.at(-1)?.role === 'user' &&
          !body.messages.at(-1).content.some?.((b) => b.type === 'tool_result');
        const content = wantsTool
          ? [{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'toolu_1', name: body.tools[0].name, input: { city: 'Cairo' } }]
          : [{ type: 'text', text: 'Hi from Claude' }];
        const stop = wantsTool ? 'tool_use' : 'end_turn';
        if (!body.stream) {
          return json(200, {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content,
            stop_reason: stop,
            stop_sequence: null,
            usage: { input_tokens: 2000, output_tokens: 300, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
          });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 2000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 } } }, 'message_start');
        sse(res, { type: 'ping' }, 'ping');
        sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
        sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: wantsTool ? 'Let me ' : 'Hi from ' } }, 'content_block_delta');
        sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: wantsTool ? 'check.' : 'Claude' } }, 'content_block_delta');
        sse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
        if (wantsTool) {
          sse(res, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: body.tools[0].name, input: {} } }, 'content_block_start');
          sse(res, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } }, 'content_block_delta');
          sse(res, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Cairo"}' } }, 'content_block_delta');
          sse(res, { type: 'content_block_stop', index: 1 }, 'content_block_stop');
        }
        sse(res, { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 250 } }, 'message_delta');
        sse(res, { type: 'message_stop' }, 'message_stop');
        return res.end();
      }
      return json(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    }
    json(404, { error: 'unknown mock route' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, calls, close: () => new Promise((r) => server.close(r)) };
}
