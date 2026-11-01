import express from 'express';
import { sha256, requestId, num, round, estimatePromptTokens } from '../util.js';
import { effectiveLimit, computeCost, recordUsage, rollPeriod } from '../billing.js';
import { GatewayError, errorBody, providerUrl, providerHeaders, upstreamFetch, upstreamError } from './upstream.js';
import { openaiChat, openaiPassthrough } from './openai.js';
import { anthropicChat, anthropicNative } from './anthropic.js';
import { safeWrite, safeEnd } from './sse.js';

const contactLine = (c) => (c ? ` Contact: ${c} | للتواصل: ${c}` : '');

const MESSAGES = {
  budget: (c) =>
    'Monthly AI usage limit reached for this app. Upgrade the plan or add credit to continue. | تم الوصول للحد الشهري لاستهلاك الذكاء الاصطناعي لهذا التطبيق، يلزم ترقية الباقة أو شحن رصيد للمتابعة.' +
    contactLine(c),
  expired: (c) =>
    'The AI subscription for this app has expired. Renew it to continue. | انتهى اشتراك الذكاء الاصطناعي لهذا التطبيق، يلزم التجديد للمتابعة.' +
    contactLine(c),
  suspended: (c) =>
    'AI access for this app is suspended. | خدمة الذكاء الاصطناعي لهذا التطبيق موقوفة مؤقتاً.' + contactLine(c),
  noPlan: (c) =>
    'No active plan is assigned to this app. | لا توجد باقة مفعّلة لهذا التطبيق.' + contactLine(c),
};

export function sendError(res, err, format = 'openai') {
  const e = err instanceof GatewayError ? err : new GatewayError(500, 'internal_error', 'Internal gateway error.');
  if (res.headersSent) {
    // The stream already started: report the error in-band and close.
    if (format === 'anthropic') safeWrite(res, `event: error\ndata: ${JSON.stringify(errorBody(e, format))}\n\n`);
    else safeWrite(res, `data: ${JSON.stringify(errorBody(e, format))}\n\n`);
    safeEnd(res);
    return;
  }
  if (res.destroyed) return;
  if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
  res.status(e.status || 500).json(errorBody(e, format));
}

function corsMiddleware(origins) {
  const allowAll = origins === '*';
  const list = allowAll ? [] : String(origins).split(',').map((s) => s.trim()).filter(Boolean);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (allowAll || list.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        req.get('access-control-request-headers') || 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta',
      );
      res.setHeader('Access-Control-Expose-Headers', 'x-request-id, retry-after');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

function extractKey(req) {
  const auth = req.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim() || null;
  return (req.get('x-api-key') || req.get('api-key') || '').trim() || null;
}

export function createProxyRouter({ cfg, db, catalog, settings, alerts, rl, log }) {
  const router = express.Router();
  const inflight = new Map(); // system id → USD reserved by requests still running
  const reserve = (id, amount) => inflight.set(id, (inflight.get(id) || 0) + amount);
  const release = (id, amount) => {
    const v = (inflight.get(id) || 0) - amount;
    if (v <= 1e-12) inflight.delete(id);
    else inflight.set(id, v);
  };

  router.use(corsMiddleware(cfg.corsOrigins));

  router.use((req, res, next) => {
    req.gwId = requestId();
    req.gwFormat = req.path.startsWith('/messages') ? 'anthropic' : 'openai';
    res.setHeader('x-request-id', req.gwId);
    next();
  });

  // Authenticate from headers before reading (possibly large) bodies.
  router.use(async (req, res, next) => {
    const key = extractKey(req);
    if (!key) {
      return sendError(
        res,
        new GatewayError(401, 'missing_api_key', 'Missing API key. Send "Authorization: Bearer <key>" or "x-api-key: <key>".'),
        req.gwFormat,
      );
    }
    const { rows } = await db.query(
      `SELECT k.id AS key_id, k.revoked_at, s.*, p.name AS plan_name, p.price_usd AS plan_price,
              p.monthly_limit_usd AS plan_limit, p.rpm_limit, p.allowed_models
       FROM api_keys k JOIN systems s ON s.id = k.system_id LEFT JOIN plans p ON p.id = s.plan_id
       WHERE k.key_hash = $1`,
      [sha256(key)],
    );
    const row = rows[0];
    if (!row || row.revoked_at || row.archived_at) {
      return sendError(res, new GatewayError(401, 'invalid_api_key', 'Invalid or revoked API key.'), req.gwFormat);
    }
    req.gw = { sys: row, keyId: row.key_id };
    next();
  });

  router.use(express.json({ limit: cfg.bodyLimit, type: ['application/json', 'application/*+json'] }));

  const allowedIds = (sys) =>
    Array.isArray(sys.allowed_models) && sys.allowed_models.length ? sys.allowed_models.map(Number) : null;

  /** Every check that can refuse a request before it costs anything. */
  async function gate(req, modelName, { kinds, providerKinds, checkBudget = true }) {
    const s = await settings.all();
    let sys = req.gw.sys;
    if (sys.status === 'suspended') throw new GatewayError(403, 'system_suspended', MESSAGES.suspended(s.support_contact));
    const rolled = await rollPeriod(db, sys);
    sys = req.gw.sys = rolled.sys;
    if (rolled.expired) throw new GatewayError(402, 'subscription_expired', MESSAGES.expired(s.support_contact));

    if (typeof modelName !== 'string' || !modelName) throw new GatewayError(400, 'missing_model', 'The "model" field is required.');
    const model = await catalog.resolve(modelName);
    if (!model || !model.enabled) {
      throw new GatewayError(
        404,
        'model_not_found',
        `The model "${modelName}" is not available on this gateway. Call GET /v1/models to list the models enabled for your key.`,
      );
    }
    if (!kinds.includes(model.kind)) {
      throw new GatewayError(400, 'invalid_model_type', `The model "${modelName}" (${model.kind}) cannot be used with this endpoint.`);
    }
    if (providerKinds && !providerKinds.includes(model.provider?.kind)) {
      throw new GatewayError(
        400,
        'endpoint_not_supported',
        model.provider?.kind === 'anthropic'
          ? `The model "${modelName}" is a Claude model: use /v1/messages or /v1/chat/completions.`
          : `The model "${modelName}" is not a Claude model: use /v1/chat/completions instead of /v1/messages.`,
      );
    }
    if (!model.provider || !model.provider.enabled || !model.provider.apiKey) {
      throw new GatewayError(503, 'provider_unavailable', 'The provider for this model is temporarily unavailable.');
    }
    const allowed = allowedIds(sys);
    if (allowed && !allowed.includes(model.id)) {
      throw new GatewayError(403, 'model_not_allowed', `Your plan does not include the model "${model.alias}". | الباقة الحالية لا تشمل هذا الموديل.`);
    }
    const limit = effectiveLimit(sys);
    if (checkBudget) {
      if (!sys.plan_id && sys.limit_override_usd == null) throw new GatewayError(402, 'no_active_plan', MESSAGES.noPlan(s.support_contact));
      const spent = num(sys.period_spend_usd) + (inflight.get(sys.id) || 0);
      if (limit <= 0 || spent >= limit) {
        // Make sure the 100% alert goes out even if the last request overshot without crossing it.
        alerts.checkThresholds(sys, num(sys.period_spend_usd), limit).catch(() => {});
        throw new GatewayError(402, 'budget_exceeded', MESSAGES.budget(s.support_contact));
      }
      const rate = rl.hit('sys:' + sys.id, num(sys.rpm_limit));
      if (!rate.ok) {
        throw new GatewayError(
          429,
          'rate_limit_exceeded',
          `Too many requests: your plan allows ${sys.rpm_limit} requests per minute.`,
          { retryAfter: rate.retryAfter },
        );
      }
    }
    return { sys, model, limit, settings: s };
  }

  async function fallbackChain(model, kinds, providerKinds) {
    const chain = [model];
    let cur = model;
    while (cur.fallback_model_id && chain.length < 3) {
      const next = await catalog.byId(cur.fallback_model_id);
      if (!next || chain.some((m) => m.id === next.id)) break;
      cur = next;
      const usable =
        next.enabled && next.provider?.enabled && next.provider?.apiKey && kinds.includes(next.kind) &&
        (!providerKinds || providerKinds.includes(next.provider.kind));
      if (usable) chain.push(next);
    }
    return chain;
  }

  // Average real cost per model (EMA) — makes reservations realistic for bursts of similar requests.
  const costAvg = new Map();
  function reservationFor(model, body) {
    const out = Math.min(num(body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens, 1024) || 1024, 8192);
    const estimate = computeCost(model, { input: estimatePromptTokens(body), cached: 0, cacheWrite: 0, output: model.kind === 'chat' ? out : 0 });
    return Math.max(estimate, costAvg.get(model.id) || 0);
  }

  /**
   * Runs one billable request: gate → (fallback chain) → provider adapter → bill.
   * Streams are aborted when the client disconnects (billed for what was produced);
   * non-stream requests run to completion so we always get the exact usage.
   */
  /** Refused requests (limit reached, expired, unknown model…) are logged too — at most one per code every 10s per app. */
  async function logRefusal(req, endpoint, body, e) {
    const sys = req.gw?.sys;
    if (!(e instanceof GatewayError) || !sys) return;
    if (!rl.hit(`refusal:${sys.id}:${e.code}`, 1, 10_000).ok) return;
    try {
      const s = await settings.all();
      await recordUsage(db, s.timezone, {
        request_id: req.gwId,
        system_id: sys.id,
        api_key_id: req.gw.keyId,
        model_alias: typeof body.model === 'string' ? body.model.slice(0, 120) : '',
        endpoint,
        stream: body.stream === true,
        status: e.status,
        cost: 0,
        latency_ms: 0,
        error: e.code,
        ip: req.ip,
      });
    } catch (err) {
      log.warn('[proxy] failed to log refusal:', err.message);
    }
  }

  async function run(req, res, { endpoint, kinds, providerKinds, execute }) {
    const body = req.body ?? {};
    const t0 = Date.now();
    const stream = body.stream === true;
    let gated;
    try {
      gated = await gate(req, body.model, { kinds, providerKinds });
    } catch (e) {
      await logRefusal(req, endpoint, body, e);
      throw e;
    }
    const { sys, model, limit, settings: s } = gated;
    const reserved = reservationFor(model, body);
    reserve(sys.id, reserved);
    const ctl = new AbortController();
    const onClose = () => {
      if (stream && !res.writableEnded) ctl.abort();
    };
    res.on('close', onClose);

    let served = model;
    let state = { started: false, usage: null, outBytes: 0, units: 1 };
    let error = null;
    let note = null;
    try {
      const chain = await fallbackChain(model, kinds, providerKinds);
      for (let i = 0; i < chain.length; i++) {
        served = chain[i];
        state = { started: false, usage: null, outBytes: 0, units: 1 };
        try {
          await execute(served, { signal: ctl.signal, state, body, req, res });
          break;
        } catch (e) {
          if (e?.providerAuth) alerts.providerAuthFailed(served.provider, e).catch(() => {});
          const canRetry = e instanceof GatewayError && e.retryable && !state.started && !ctl.signal.aborted && i < chain.length - 1;
          if (!canRetry) throw e;
          note = `fallback: ${served.alias} → ${chain[i + 1].alias} (${e.upstreamStatus || e.code})`;
          log.warn(`[proxy] ${req.gwId} ${note}`);
        }
      }
    } catch (e) {
      error = e;
    } finally {
      res.off('close', onClose);
      release(sys.id, reserved);
    }

    const aborted = ctl.signal.aborted || state.aborted;
    // Bill exactly when the provider reported usage; estimate when output was produced but usage is missing.
    let usage = state.usage;
    let estimated = false;
    if (!usage && (state.started || (!error && !aborted))) {
      usage = { input: estimatePromptTokens(body), cached: 0, cacheWrite: 0, output: Math.ceil(state.outBytes / 4) };
      estimated = true;
    }
    const cost = usage ? computeCost(served, usage, state.units) : 0;
    if (cost > 0 && !error) {
      const prev = costAvg.get(served.id);
      costAvg.set(served.id, prev == null ? cost : prev * 0.8 + cost * 0.2);
    }
    let status = 200;
    if (error) status = aborted && !(error instanceof GatewayError) ? 499 : error.status || 500;
    else if (aborted) status = 499;
    else if (state.interrupted) status = 502;

    if (error && !(error instanceof GatewayError) && !aborted) {
      log.error(`[proxy] ${req.gwId} unexpected error:`, error);
    }
    try {
      const spend = await recordUsage(db, s.timezone, {
        request_id: req.gwId,
        system_id: sys.id,
        api_key_id: req.gw.keyId,
        model_id: served.id,
        model_alias: served.alias,
        provider_id: served.provider_id,
        endpoint,
        stream,
        status,
        usage,
        cost,
        latency_ms: Date.now() - t0,
        estimated,
        error: error ? `${error.code || 'error'}: ${error.detail || error.message}` : state.interrupted ? 'stream interrupted' : null,
        note,
        ip: req.ip,
      });
      if (cost > 0) await alerts.checkThresholds(sys, spend, limit);
    } catch (e) {
      log.error(`[proxy] ${req.gwId} failed to record usage:`, e.message);
    }

    if (error && !aborted) sendError(res, error, req.gwFormat);
    else if (error) safeEnd(res);
  }

  // ───────────── OpenAI-compatible endpoints ─────────────

  router.post('/chat/completions', async (req, res) => {
    const body = req.body ?? {};
    if (!Array.isArray(body.messages) || !body.messages.length) {
      throw new GatewayError(400, 'invalid_messages', '"messages" must be a non-empty array.');
    }
    await run(req, res, {
      endpoint: 'chat',
      kinds: ['chat'],
      execute: (model, ctx) =>
        model.provider.kind === 'anthropic' ? anthropicChat({ model, ...ctx }) : openaiChat({ model, ...ctx }),
    });
  });

  router.post('/responses', (req, res) =>
    run(req, res, {
      endpoint: 'responses',
      kinds: ['chat'],
      providerKinds: ['openai'],
      execute: (model, ctx) => openaiPassthrough({ model, ...ctx, path: 'responses', usageKind: 'responses' }),
    }),
  );

  router.post('/embeddings', (req, res) =>
    run(req, res, {
      endpoint: 'embeddings',
      kinds: ['embedding'],
      providerKinds: ['openai'],
      execute: (model, ctx) => openaiPassthrough({ model, ...ctx, path: 'embeddings', usageKind: 'embeddings' }),
    }),
  );

  router.post('/images/generations', (req, res) =>
    run(req, res, {
      endpoint: 'images',
      kinds: ['image'],
      providerKinds: ['openai'],
      execute: (model, ctx) => openaiPassthrough({ model, ...ctx, path: 'images/generations', usageKind: 'images' }),
    }),
  );

  // ───────────── Anthropic-native endpoints (apps using the Anthropic SDK) ─────────────

  router.post('/messages', (req, res) =>
    run(req, res, {
      endpoint: 'messages',
      kinds: ['chat'],
      providerKinds: ['anthropic'],
      execute: (model, ctx) => anthropicNative({ model, ...ctx }),
    }),
  );

  router.post('/messages/count_tokens', async (req, res) => {
    const body = req.body ?? {};
    const { model } = await gate(req, body.model, { kinds: ['chat'], providerKinds: ['anthropic'], checkBudget: false });
    const p = model.provider;
    const r = await upstreamFetch(providerUrl(p, 'v1/messages/count_tokens'), {
      method: 'POST',
      headers: providerHeaders(p, { anthropicVersion: req.get('anthropic-version'), anthropicBeta: req.get('anthropic-beta') }),
      body: JSON.stringify({ ...body, model: model.upstream_model }),
    });
    if (!r.ok) throw await upstreamError(r, p);
    res.status(200).type('application/json').send(await r.text());
  });

  // ───────────── Discovery & usage ─────────────

  async function listModels(sys) {
    const c = await catalog.get();
    const allowed = allowedIds(sys);
    return [...c.byId.values()]
      .filter((m) => m.enabled && m.provider?.enabled && (!allowed || allowed.includes(m.id)))
      .sort((a, b) => a.sort_order - b.sort_order || a.alias.localeCompare(b.alias));
  }

  router.get('/models', async (req, res) => {
    const models = await listModels(req.gw.sys);
    if (req.get('anthropic-version')) {
      const data = models
        .filter((m) => m.kind === 'chat' && m.provider.kind === 'anthropic')
        .map((m) => ({ type: 'model', id: m.alias, display_name: m.alias, created_at: new Date(m.created_at).toISOString() }));
      return res.json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    }
    res.json({
      object: 'list',
      data: models.map((m) => ({
        id: m.alias,
        object: 'model',
        created: Math.floor(new Date(m.created_at).getTime() / 1000),
        owned_by: 'gateway',
        type: m.kind,
      })),
    });
  });

  router.get('/models/:id', async (req, res) => {
    const models = await listModels(req.gw.sys);
    const m = models.find((x) => x.alias === req.params.id);
    if (!m) throw new GatewayError(404, 'model_not_found', `The model "${req.params.id}" does not exist or is not enabled for your key.`);
    res.json({ id: m.alias, object: 'model', created: Math.floor(new Date(m.created_at).getTime() / 1000), owned_by: 'gateway', type: m.kind });
  });

  /** Usage summary for client apps and the client portal (no dollar amounts unless enabled in settings). */
  router.get('/usage', async (req, res) => {
    const s = await settings.all();
    const { sys } = await rollPeriod(db, req.gw.sys);
    const limit = effectiveLimit(sys);
    const spend = num(sys.period_spend_usd);
    const now = Date.now();
    const expired = new Date(sys.period_end).getTime() <= now && !sys.auto_renew;
    const pct = limit > 0 ? Math.min(100, (spend / limit) * 100) : spend > 0 ? 100 : 0;
    const [{ rows: totals }, { rows: daily }, { rows: plans }] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS requests, COALESCE(SUM(input_tokens + cached_tokens + cache_write_tokens), 0)::float8 AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens
         FROM usage_logs WHERE system_id = $1 AND created_at >= $2`,
        [sys.id, sys.period_start],
      ),
      db.query(
        `SELECT day, SUM(requests)::int AS requests, SUM(input_tokens + output_tokens + cached_tokens)::float8 AS tokens,
                SUM(cost_usd)::float8 AS cost
         FROM usage_daily WHERE system_id = $1 AND day > (now() AT TIME ZONE $2)::date - 30
         GROUP BY day ORDER BY day`,
        [sys.id, s.timezone],
      ),
      db.query(`SELECT id, name, price_usd, description FROM plans WHERE is_public AND NOT archived ORDER BY sort_order, price_usd`),
    ]);
    let state = 'active';
    if (sys.status === 'suspended') state = 'suspended';
    else if (expired) state = 'expired';
    else if (limit <= 0 || spend >= limit) state = 'limit_reached';
    const models = (await listModels(sys)).map((m) => ({ id: m.alias, type: m.kind }));
    const showCost = !!s.portal_show_cost;
    const contact = String(s.support_contact || '').trim();
    const digits = contact.replace(/[^\d]/g, '');
    res.json({
      brand: s.brand_name,
      system: { name: sys.name, state },
      plan: sys.plan_id ? { name: sys.plan_name, price_usd: num(sys.plan_price) } : null,
      period: {
        start: sys.period_start,
        end: sys.period_end,
        days_left: Math.max(0, Math.ceil((new Date(sys.period_end).getTime() - now) / 86400000)),
        auto_renew: sys.auto_renew,
      },
      usage: {
        percent: round(pct, 2),
        requests: totals[0]?.requests ?? 0,
        input_tokens: totals[0]?.input_tokens ?? 0,
        output_tokens: totals[0]?.output_tokens ?? 0,
        ...(showCost ? { spent_usd: round(spend, 4), limit_usd: limit, remaining_usd: round(Math.max(0, limit - spend), 4) } : {}),
      },
      daily: daily.map((d) => ({
        day: d.day,
        requests: d.requests,
        tokens: d.tokens,
        percent_of_limit: limit > 0 ? round((d.cost / limit) * 100, 2) : 0,
        ...(showCost ? { cost_usd: round(d.cost, 4) } : {}),
      })),
      models,
      plans: plans.map((p) => ({ name: p.name, price_usd: num(p.price_usd), description: p.description, current: p.id === sys.plan_id })),
      support: contact
        ? { contact, whatsapp_url: /^https?:\/\//.test(contact) ? contact : digits.length >= 8 ? `https://wa.me/${digits}` : null }
        : null,
    });
  });

  router.use((req, res) => {
    sendError(res, new GatewayError(404, 'unknown_endpoint', `Unknown endpoint: ${req.method} /v1${req.path}`), req.gwFormat);
  });

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      return sendError(res, new GatewayError(400, 'invalid_json', 'The request body is not valid JSON.'), req.gwFormat);
    }
    if (err?.type === 'entity.too.large') {
      return sendError(res, new GatewayError(413, 'request_too_large', `The request body exceeds ${cfg.bodyLimit}.`), req.gwFormat);
    }
    if (!(err instanceof GatewayError)) log.error(`[proxy] ${req.gwId || ''} error:`, err);
    sendError(res, err, req.gwFormat);
  });

  return router;
}
