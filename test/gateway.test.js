// End-to-end tests: real gateway + embedded database + mock OpenAI/Anthropic/Telegram servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, OPENAI_KEY, ANTHROPIC_KEY } from './mock-upstream.js';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp, bootstrapAdmin } from '../src/app.js';

const ADMIN = { email: 'owner@test.local', password: 'test-password-123' };
const silent = { info() {}, warn() {}, error() {} };
let mock, server, base, deps, cookie;
const ctx = {};

async function api(method, path, body) {
  const r = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}

function gw(path, key, body, headers = {}, signal) {
  const auth = headers['x-api-key'] ? {} : { authorization: `Bearer ${key}` };
  return fetch(`${base}/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...auth, ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
}

async function readSSE(r) {
  const text = await r.text();
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.split('\n');
      return {
        event: lines.find((l) => l.startsWith('event: '))?.slice(7),
        data: lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'),
      };
    });
}

const q = async (sql, params) => (await deps.db.query(sql, params)).rows;
const sysRow = async (id) => (await q('SELECT * FROM systems WHERE id = $1', [id]))[0];
const lastLog = async (id) => (await q('SELECT * FROM usage_logs WHERE system_id = $1 ORDER BY id DESC LIMIT 1', [id]))[0];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
async function waitFor(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for condition');
}
async function newSystem(extra) {
  const r = await api('POST', '/systems', { name: `App ${Math.random().toString(36).slice(2, 7)}`, plan_id: ctx.plan.id, ...extra });
  return { id: r.system.id, key: r.api_key };
}

before(async () => {
  mock = await startMock();
  const cfg = loadConfig({
    DATA_DIR: 'memory://',
    ENCRYPTION_KEY: 'test-encryption-key',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_EMAIL: ADMIN.email,
    ADMIN_PASSWORD: ADMIN.password,
    QUIET: '1',
    TELEGRAM_API_BASE: `${mock.base}/telegram`,
  });
  const db = await openDb(cfg, silent);
  await bootstrapAdmin({ cfg, db, log: silent });
  const created = await createApp({ cfg, db });
  deps = created.deps;
  server = created.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const op = await api('POST', '/providers', { preset: 'custom', name: 'Mock OpenAI', base_url: `${mock.base}/openai/v1`, api_key: OPENAI_KEY });
  ctx.openaiProvider = op;
  const ap = await api('POST', '/providers', { preset: 'anthropic', name: 'Mock Anthropic', base_url: `${mock.base}/anthropic`, api_key: ANTHROPIC_KEY });
  ctx.anthropicProvider = ap;
  const bad = await api('POST', '/providers', { preset: 'custom', name: 'Wrong key', base_url: `${mock.base}/openai/v1`, api_key: 'sk-wrong-key-abcdefghijkl' });

  const model = async (m) => (await api('POST', '/models', m)).model;
  const priced = { input_price: 1, output_price: 2, cached_input_price: 0.5 };
  ctx.gpt = await model({ alias: 'gpt-test', provider_id: op.provider.id, upstream_model: 'gpt-test', ...priced });
  await model({ alias: 'slow', provider_id: op.provider.id, upstream_model: 'slow', ...priced });
  await model({ alias: 'bad-request', provider_id: op.provider.id, upstream_model: 'bad-request', ...priced });
  await model({ alias: 'with-fallback', provider_id: op.provider.id, upstream_model: 'fail-500', fallback_model_id: ctx.gpt.id, ...priced });
  await model({ alias: 'auth-test', provider_id: bad.provider.id, upstream_model: 'gpt-test', ...priced });
  ctx.claude = await model({
    alias: 'claude-test', provider_id: ap.provider.id, upstream_model: 'claude-sonnet-5-5',
    input_price: 3, output_price: 15, cached_input_price: 0.3, cache_write_price: 3.75,
  });
  await model({ alias: 'embed-test', kind: 'embedding', provider_id: op.provider.id, upstream_model: 'text-embedding-3-small', input_price: 0.02 });
  await model({ alias: 'image-test', kind: 'image', provider_id: op.provider.id, upstream_model: 'gpt-image', request_price: 0.04 });

  ctx.plan = (await api('POST', '/plans', { name: 'Pro', price_usd: 30, monthly_limit_usd: 20 })).plan;
  const s = await api('POST', '/systems', {
    name: 'Star Style',
    plan_id: ctx.plan.id,
    payment: { amount_usd: 30, method: 'تحويل' },
  });
  ctx.sys = { id: s.system.id, key: s.api_key };
});

after(async () => {
  server?.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await deps.db.close();
  await mock.close();
});

test('setup: provider test lists upstream models and matches reference prices', () => {
  assert.equal(ctx.openaiProvider.test.ok, true);
  const imp = ctx.openaiProvider.import;
  const mini = imp.find((m) => m.id === 'gpt-4o-mini-2024-07-18');
  assert.equal(mini.preset.input_price, 0.15);
  assert.equal(imp.find((m) => m.id === 'whisper-1').supported, false);
  assert.ok(ctx.anthropicProvider.import.find((m) => m.id === 'claude-haiku-4-5-20251001').preset);
  assert.match(ctx.sys.key, /^sk-gw-/);
});

test('rejects missing, invalid and revoked keys', async () => {
  assert.equal((await gw('/models')).status, 401);
  assert.equal((await gw('/models', 'sk-gw-nope')).status, 401);
  const s = await newSystem();
  const { keys } = await api('GET', `/systems/${s.id}`);
  await api('DELETE', `/systems/${s.id}/keys/${keys[0].id}`);
  const r = await gw('/chat/completions', s.key, { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 401);
  const fresh = await api('POST', `/systems/${s.id}/keys`, { name: 'prod' });
  assert.equal((await gw('/models', fresh.api_key)).status, 200);
});

test('OpenAI-compatible chat: our provider key upstream, exact billing', async () => {
  const before = Number((await sysRow(ctx.sys.id)).period_spend_usd);
  const r = await gw('/chat/completions', ctx.sys.key, { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 });
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('x-request-id'));
  const j = await r.json();
  assert.equal(j.choices[0].message.content, 'Hello from mock');
  assert.equal(j.model, 'gpt-test');
  const call = mock.calls.openai.at(-1);
  assert.equal(call.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(call.body.max_tokens, 50); // only the "openai" preset is rewritten to max_completion_tokens
  const log = await lastLog(ctx.sys.id);
  assert.equal(log.status, 200);
  assert.deepEqual([log.input_tokens, log.cached_tokens, log.output_tokens], [800, 200, 500]);
  assert.ok(near(log.cost_usd, 0.0019));
  assert.equal(log.estimated, false);
  const after = Number((await sysRow(ctx.sys.id)).period_spend_usd);
  assert.ok(near(after - before, 0.0019, 1e-7));
});

test('streaming: usage chunk injected for billing but hidden from the client', async () => {
  const r = await gw('/chat/completions', ctx.sys.key, { model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = await readSSE(r);
  assert.equal(events.at(-1).data, '[DONE]');
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data));
  assert.ok(chunks.every((c) => !('usage' in c)));
  assert.equal(chunks.map((c) => c.choices[0]?.delta?.content || '').join(''), 'Hello');
  assert.equal(mock.calls.openai.at(-1).body.stream_options.include_usage, true);
  const log = await lastLog(ctx.sys.id);
  assert.deepEqual([log.input_tokens, log.output_tokens, log.estimated, log.stream], [40, 2, false, true]);

  const r2 = await gw('/chat/completions', ctx.sys.key, {
    model: 'gpt-test', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }],
  });
  const chunks2 = (await readSSE(r2)).slice(0, -1).map((e) => JSON.parse(e.data));
  const usageChunk = chunks2.find((c) => c.usage);
  assert.equal(usageChunk.usage.total_tokens, 42);
  assert.deepEqual(usageChunk.choices, []);
});

test('Claude through /v1/chat/completions: request + response translation', async () => {
  const r = await gw('/chat/completions', ctx.sys.key, {
    model: 'claude-test',
    temperature: 1.5,
    messages: [
      { role: 'system', content: 'Answer in Arabic.' },
      { role: 'user', content: 'مرحبا' },
    ],
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.choices[0].message.content, 'Hi from Claude');
  assert.equal(j.choices[0].finish_reason, 'stop');
  assert.equal(j.usage.prompt_tokens, 2100);
  const up = mock.calls.anthropic.at(-1);
  assert.equal(up.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(up.body.model, 'claude-sonnet-5-5');
  assert.equal(up.body.system, 'Answer in Arabic.');
  assert.equal(up.body.max_tokens, 16384);
  assert.equal(up.body.temperature, 1);
  const log = await lastLog(ctx.sys.id);
  assert.ok(near(log.cost_usd, 0.01053));
});

test('Claude streaming with tool calls is converted to OpenAI chunks', async () => {
  const r = await gw('/chat/completions', ctx.sys.key, {
    model: 'claude-test',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'Weather in Cairo?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
  });
  const events = await readSSE(r);
  assert.equal(events.at(-1).data, '[DONE]');
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  const text = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
  assert.equal(text, 'Let me check.');
  const toolDeltas = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls || []);
  assert.equal(toolDeltas[0].id, 'toolu_9');
  assert.equal(toolDeltas[0].function.name, 'get_weather');
  assert.equal(toolDeltas.map((t) => t.function.arguments || '').join(''), '{"city":"Cairo"}');
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
  const usage = chunks.find((c) => c.usage)?.usage;
  assert.equal(usage.prompt_tokens, 2500);
  assert.equal(usage.completion_tokens, 250);
  const log = await lastLog(ctx.sys.id);
  assert.deepEqual([log.input_tokens, log.cache_write_tokens, log.output_tokens], [2000, 500, 250]);
  assert.ok(near(log.cost_usd, 0.011625));
});

test('native /v1/messages: Anthropic SDK apps keep their model name and format', async () => {
  const headers = { 'x-api-key': ctx.sys.key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'test-beta' };
  // The app asks for the real Claude model id; the gateway maps it to the configured model.
  const r = await gw('/messages', null, { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, headers);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.id, 'msg_1');
  assert.equal(j.content[0].text, 'Hi from Claude');
  const up = mock.calls.anthropic.at(-1);
  assert.equal(up.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(up.headers['anthropic-beta'], 'test-beta');
  let log = await lastLog(ctx.sys.id);
  assert.equal(log.endpoint, 'messages');
  assert.ok(near(log.cost_usd, 0.01053));

  const rs = await gw('/messages', null, { model: 'claude-test', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }, headers);
  const events = await readSSE(rs);
  assert.deepEqual(events.map((e) => e.event).slice(0, 2), ['message_start', 'ping']);
  assert.equal(events.at(-1).event, 'message_stop');
  log = await lastLog(ctx.sys.id);
  assert.deepEqual([log.input_tokens, log.cache_write_tokens, log.output_tokens, log.estimated], [2000, 500, 250, false]);

  const ct = await gw('/messages/count_tokens', null, { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }, headers);
  assert.deepEqual(await ct.json(), { input_tokens: 42 });

  const nf = await gw('/messages', null, { model: 'nope', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }, headers);
  assert.equal(nf.status, 404);
  const err = await nf.json();
  assert.equal(err.type, 'error');
  assert.equal(err.error.type, 'not_found_error');

  const wrong = await gw('/messages', null, { model: 'gpt-test', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }, headers);
  assert.equal(wrong.status, 400);
});

test('embeddings, image generation (per image) and Responses API are billed', async () => {
  const e = await gw('/embeddings', ctx.sys.key, { model: 'embed-test', input: 'hello' });
  assert.equal(e.status, 200);
  assert.equal((await e.json()).model, 'embed-test');
  assert.equal((await lastLog(ctx.sys.id)).input_tokens, 10);

  const img = await gw('/images/generations', ctx.sys.key, { model: 'image-test', prompt: 'a cat', n: 2 });
  assert.equal(img.status, 200);
  assert.ok(near((await lastLog(ctx.sys.id)).cost_usd, 0.08));

  const resp = await gw('/responses', ctx.sys.key, { model: 'gpt-test', input: 'hello' });
  assert.equal(resp.status, 200);
  assert.deepEqual([(await lastLog(ctx.sys.id)).input_tokens, (await lastLog(ctx.sys.id)).output_tokens], [100, 50]);

  const rs = await gw('/responses', ctx.sys.key, { model: 'gpt-test', input: 'hello', stream: true });
  const events = await readSSE(rs);
  assert.equal(events.at(-1).event, 'response.completed');
  assert.equal((await lastLog(ctx.sys.id)).output_tokens, 50);

  const wrongKind = await gw('/embeddings', ctx.sys.key, { model: 'gpt-test', input: 'x' });
  assert.equal(wrongKind.status, 400);
});

test('fallback model is used when the provider fails', async () => {
  const r = await gw('/chat/completions', ctx.sys.key, { model: 'with-fallback', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  const log = await lastLog(ctx.sys.id);
  assert.equal(log.model_alias, 'gpt-test');
  assert.match(log.note, /fallback: with-fallback → gpt-test/);
});

test('client errors pass through without billing', async () => {
  const r = await gw('/chat/completions', ctx.sys.key, { model: 'bad-request', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /Invalid value for temperature/);
  const log = await lastLog(ctx.sys.id);
  assert.equal(log.status, 400);
  assert.equal(Number(log.cost_usd), 0);
  const bad = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.sys.key}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'invalid_json');
});

test('provider auth failures are sanitized and the admin is alerted', async () => {
  await api('PUT', '/settings', { telegram_bot_token: '123:abc', telegram_chat_id: '42' });
  const r = await gw('/chat/completions', ctx.sys.key, { model: 'auth-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.ok(!text.includes('sk-wrong-key'), 'provider key leaked to the client');
  assert.match(JSON.parse(text).error.code, /upstream_auth_error/);
  await waitFor(() => mock.calls.telegram.find((c) => c.body.text.includes('رفض مفتاح API')));
  assert.ok(mock.calls.telegram.every((c) => c.url === '/telegram/bot123:abc/sendMessage' && c.body.chat_id === '42'));
});

test('monthly limit: warning + stop alerts, 402 when exhausted, top-up re-enables', async () => {
  const s = await newSystem({ plan_id: null, limit_override_usd: 0.005 });
  const ask = () => gw('/chat/completions', s.key, { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await ask()).status, 200); // 0.0019
  assert.equal((await ask()).status, 200); // 0.0038 → 76%
  assert.equal((await ask()).status, 200); // 0.0057 → over the limit
  const blocked = await ask();
  assert.equal(blocked.status, 402);
  const err = await blocked.json();
  assert.equal(err.error.code, 'budget_exceeded');
  assert.equal(err.error.type, 'insufficient_quota');
  const sys = await sysRow(s.id);
  assert.equal(sys.alert_level, 100);
  const refusal = await lastLog(s.id);
  assert.equal(refusal.status, 402);
  const sysName = (await api('GET', `/systems/${s.id}`)).system.name;
  await waitFor(() => mock.calls.telegram.find((c) => c.body.text.includes(sysName) && c.body.text.includes('⛔')));

  await api('POST', `/systems/${s.id}/topup`, { credit_usd: 0.01, amount_usd: 2, method: 'cash' });
  assert.equal((await ask()).status, 200);
  const { payments } = await api('GET', `/systems/${s.id}`);
  assert.equal(payments[0].kind, 'topup');
});

test('suspend, expiry, renewal and automatic monthly roll-over', async () => {
  const s = await newSystem();
  const ask = () => gw('/chat/completions', s.key, { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  await api('PATCH', `/systems/${s.id}`, { status: 'suspended' });
  const sus = await ask();
  assert.equal(sus.status, 403);
  assert.equal((await sus.json()).error.code, 'system_suspended');
  await api('PATCH', `/systems/${s.id}`, { status: 'active' });

  await q(`UPDATE systems SET auto_renew = false, period_end = now() - interval '1 hour' WHERE id = $1`, [s.id]);
  const exp = await ask();
  assert.equal(exp.status, 402);
  assert.equal((await exp.json()).error.code, 'subscription_expired');
  await api('POST', `/systems/${s.id}/renew`, { amount_usd: 30, method: 'cash' });
  assert.equal((await ask()).status, 200);

  await q(
    `UPDATE systems SET auto_renew = true, period_spend_usd = 7, period_start = now() - interval '40 days',
       period_end = now() - interval '10 days', billing_anchor = now() - interval '40 days' WHERE id = $1`,
    [s.id],
  );
  assert.equal((await ask()).status, 200);
  const row = await sysRow(s.id);
  assert.ok(near(Number(row.period_spend_usd), 0.0019, 1e-7), 'spend should restart in the new period');
  assert.ok(new Date(row.period_end) > new Date());
  const ev = await q(`SELECT * FROM events WHERE system_id = $1 AND type = 'period_renewed'`, [s.id]);
  assert.equal(ev.length, 1);
});

test('plan rules: allowed models and requests-per-minute', async () => {
  const onlyGpt = (await api('POST', '/plans', { name: 'Only GPT', price_usd: 5, monthly_limit_usd: 5, rpm_limit: 2, allowed_models: [ctx.gpt.id] })).plan;
  const s = await newSystem({ plan_id: onlyGpt.id });
  const models = await (await gw('/models', s.key)).json();
  assert.deepEqual(models.data.map((m) => m.id), ['gpt-test']);
  const denied = await gw('/chat/completions', s.key, { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'model_not_allowed');
  for (let i = 0; i < 2; i++) {
    const ok = await gw('/chat/completions', s.key, { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(ok.status, 200);
  }
  const limited = await gw('/chat/completions', s.key, { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);

  const anth = await (await gw('/models', ctx.sys.key, null, { 'anthropic-version': '2023-06-01' })).json();
  assert.deepEqual(anth.data.map((m) => m.id), ['claude-test']);
});

test('client disconnect mid-stream is billed for what was generated', async () => {
  const s = await newSystem();
  const ac = new AbortController();
  const r = await gw('/chat/completions', s.key, { model: 'slow', stream: true, messages: [{ role: 'user', content: 'tell me a story' }] }, {}, ac.signal);
  const reader = r.body.getReader();
  await reader.read();
  await reader.read();
  await new Promise((res) => setTimeout(res, 200));
  ac.abort();
  const log = await waitFor(async () => {
    const l = await lastLog(s.id);
    return l && l.status === 499 ? l : null;
  });
  assert.equal(log.estimated, true);
  assert.ok(log.output_tokens > 0 && log.output_tokens < 60, `output tokens ${log.output_tokens}`);
  assert.ok(Number(log.cost_usd) > 0);
});

test('usage endpoint and client portal data hide dollar amounts by default', async () => {
  const u = await (await gw('/usage', ctx.sys.key)).json();
  assert.equal(u.system.name, 'Star Style');
  assert.equal(u.plan.name, 'Pro');
  assert.ok(u.usage.percent > 0 && u.usage.percent < 100);
  assert.equal(u.usage.spent_usd, undefined);
  assert.ok(u.models.some((m) => m.id === 'claude-test'));
  await api('PUT', '/settings', { portal_show_cost: true });
  const u2 = await (await gw('/usage', ctx.sys.key)).json();
  assert.equal(u2.usage.limit_usd, 20);
  await api('PUT', '/settings', { portal_show_cost: false });
});

test('dashboard API: auth, overview, finance and logs', async () => {
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
  const evil = await fetch(`${base}/api/plans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'x', monthly_limit_usd: 1 }),
  });
  assert.equal(evil.status, 403);
  const o = await api('GET', '/overview');
  assert.ok(o.month.cost > 0);
  assert.ok(o.month.revenue >= 30);
  assert.equal(o.daily.length, 30);
  assert.ok(o.systems.find((s) => s.name === 'Star Style'));
  const f = await api('GET', '/finance');
  const star = f.systems.find((s) => s.name === 'Star Style');
  assert.equal(star.revenue, 30);
  assert.ok(star.cost > 0 && near(star.profit, 30 - star.cost, 1e-6));
  assert.equal(f.history.length, 6);
  const logs = await api('GET', `/logs?system_id=${ctx.sys.id}&status=error`);
  assert.ok(logs.logs.length >= 1 && logs.logs.every((l) => l.status >= 400));
  const page = await api('GET', `/logs?limit=10`);
  assert.equal(page.logs.length, 10);
  const next = await api('GET', `/logs?limit=10&before=${page.next_before}`);
  assert.ok(next.logs[0].id < page.logs.at(-1).id);
});
