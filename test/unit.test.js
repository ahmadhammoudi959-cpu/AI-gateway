import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser } from '../src/proxy/sse.js';
import { addMonths, nextBoundary, estimatePromptTokens, scrubSecrets, makeCipher, generateApiKey, sha256 } from '../src/util.js';
import { computeCost, usageFrom, effectiveLimit } from '../src/billing.js';
import { toAnthropicRequest, fromAnthropicMessage } from '../src/proxy/anthropic.js';
import { normalizeModelName } from '../src/catalog.js';

test('SSE parser handles CRLF split across chunks, comments and multi-line data', () => {
  const p = new SSEParser();
  const chunks = ['event: a\r', '\ndata: 1\r\n', 'data: 2\r\n\r', '\n: comment\n\ndata: {"x":', '1}\n\n'];
  const events = chunks.flatMap((c) => p.feed(Buffer.from(c)));
  assert.deepEqual(events, [
    { event: 'a', data: '1\n2' },
    { event: undefined, data: '{"x":1}' },
  ]);
  assert.deepEqual(p.flush(), []);
});

test('SSE parser decodes UTF-8 split inside a multi-byte character', () => {
  const p = new SSEParser();
  const bytes = Buffer.from('data: مرحبا\n\n');
  const events = [...p.feed(bytes.subarray(0, 7)), ...p.feed(bytes.subarray(7))];
  assert.deepEqual(events, [{ event: undefined, data: 'مرحبا' }]);
});

test('addMonths clamps to the end of month and nextBoundary keeps the anchor day', () => {
  assert.equal(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString(), '2026-02-28T10:00:00.000Z');
  const anchor = new Date('2026-01-31T10:00:00Z');
  const feb = nextBoundary(anchor, anchor);
  assert.equal(feb.toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(nextBoundary(anchor, feb).toISOString(), '2026-03-31T10:00:00.000Z');
  assert.equal(nextBoundary(anchor, new Date('2026-06-15T00:00:00Z')).toISOString(), '2026-06-30T10:00:00.000Z');
});

test('computeCost: cached, cache-write and long-context tiers', () => {
  const m = { input_price: 3, output_price: 15, cached_input_price: 0.3, cache_write_price: 3.75 };
  assert.equal(computeCost(m, { input: 2000, cached: 100, cacheWrite: 0, output: 300 }), 0.01053);
  const haiku = { input_price: 0.1, output_price: 0.5, cached_input_price: 0.01, long_context_threshold: 100000, long_input_price: 0.5, long_output_price: 2.5 };
  assert.equal(computeCost(haiku, { input: 50000, output: 1000 }), 0.0055);
  // above the threshold every token uses the higher tier
  assert.equal(computeCost(haiku, { input: 150000, output: 1000 }), 0.0775);
  // per-image pricing
  assert.equal(computeCost({ input_price: 0, output_price: 0, request_price: 0.04 }, { input: 0, output: 0 }, 3), 0.12);
  // provider-reported cost when no prices are configured (OpenRouter)
  assert.equal(computeCost({ input_price: 0, output_price: 0 }, { input: 10, output: 10, reportedCost: 0.0123 }), 0.0123);
});

test('usage normalization across providers', () => {
  assert.deepEqual(usageFrom.openai({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } }), {
    input: 800, cached: 200, cacheWrite: 0, output: 500,
  });
  // DeepSeek reports cache hits separately
  assert.equal(usageFrom.openai({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 }).cached, 60);
  // hidden reasoning tokens only visible in total_tokens (Gemini thinking)
  assert.equal(usageFrom.openai({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 40 }).output, 30);
  assert.deepEqual(usageFrom.anthropic({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }), {
    input: 5, cached: 3, cacheWrite: 2, output: 7,
  });
  assert.equal(usageFrom.openai(null), null);
});

test('effectiveLimit = override or plan limit + extra credit', () => {
  assert.equal(effectiveLimit({ plan_limit: 20, extra_credit_usd: 5 }), 25);
  assert.equal(effectiveLimit({ plan_limit: 20, limit_override_usd: 50, extra_credit_usd: 0 }), 50);
  assert.equal(effectiveLimit({ plan_limit: null, limit_override_usd: null, extra_credit_usd: 0 }), 0);
});

test('OpenAI → Anthropic request translation', () => {
  const out = toAnthropicRequest(
    {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: 'Weather?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Cairo"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '30°C' },
        { role: 'user', content: 'thanks' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      tool_choice: 'required',
      temperature: 1.7,
      top_p: 0.9,
      stop: 'END',
    },
    { upstream_model: 'claude-x', default_max_tokens: null },
  );
  assert.equal(out.system, 'You are helpful.');
  assert.equal(out.max_tokens, 16384);
  assert.equal(out.temperature, 1);
  assert.equal(out.top_p, undefined);
  assert.deepEqual(out.stop_sequences, ['END']);
  assert.deepEqual(out.tool_choice, { type: 'any' });
  assert.equal(out.tools[0].input_schema.properties.city.type, 'string');
  assert.equal(out.messages.length, 3);
  assert.deepEqual(out.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.deepEqual(out.messages[1].content, [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Cairo' } }]);
  // tool result and the following user text are merged into one user turn
  assert.deepEqual(out.messages[2].content, [
    { type: 'tool_result', tool_use_id: 'call_1', content: '30°C' },
    { type: 'text', text: 'thanks' },
  ]);
});

test('Anthropic → OpenAI response translation', () => {
  const out = fromAnthropicMessage(
    {
      id: 'msg_1',
      content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 },
    },
    'my-claude',
  );
  assert.equal(out.model, 'my-claude');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"a":1}');
  assert.deepEqual(out.usage, { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20, prompt_tokens_details: { cached_tokens: 4 } });
});

test('secrets are scrubbed from provider errors', () => {
  const msg = scrubSecrets('Incorrect API key provided: sk-proj-abcdefghijklmnop. org-ABCDEFGHIJKLMN key AIzaSyA1234567890123456789', ['custom-secret-value']);
  assert.ok(!msg.includes('abcdefghijklmnop'));
  assert.ok(!msg.includes('ABCDEFGHIJKLMN'));
  assert.ok(!msg.includes('AIzaSyA1234567890123456789'));
});

test('cipher round-trip, key format and model name normalization', () => {
  const c = makeCipher('secret');
  assert.equal(c.decrypt(c.encrypt('sk-ant-xyz')), 'sk-ant-xyz');
  assert.throws(() => makeCipher('other').decrypt(c.encrypt('x')));
  const k = generateApiKey();
  assert.match(k.key, /^sk-gw-[0-9A-Za-z]{40}$/);
  assert.equal(k.hash, sha256(k.key));
  assert.equal(normalizeModelName('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.equal(normalizeModelName('models/gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(normalizeModelName('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini');
});

test('prompt token estimate counts text, not base64 images', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(500000);
  const n = estimatePromptTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello world!' }, { type: 'image_url', image_url: { url: big } }] }] });
  assert.ok(n < 1100 && n >= 1000, `estimate was ${n}`);
});
