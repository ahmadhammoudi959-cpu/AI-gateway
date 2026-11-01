import { num, round, addMonths, nextBoundary } from './util.js';
import { logEvent } from './events.js';

/** Monthly allowance for the current period: plan limit (or a per-system override) + one-off credit. */
export function effectiveLimit(sys) {
  const base =
    sys.limit_override_usd != null ? num(sys.limit_override_usd) : sys.plan_limit != null ? num(sys.plan_limit) : 0;
  return round(base + num(sys.extra_credit_usd), 6);
}

const ZERO = { input: 0, cached: 0, cacheWrite: 0, output: 0 };

/**
 * Normalized usage = { input (uncached prompt tokens), cached (cache reads), cacheWrite, output }.
 * Each provider reports usage differently; these adapters make them comparable.
 */
export const usageFrom = {
  openai(u) {
    if (!u || typeof u !== 'object') return null;
    const prompt = num(u.prompt_tokens ?? u.input_tokens);
    const completion = num(u.completion_tokens ?? u.output_tokens);
    const cached = Math.min(
      prompt,
      num(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.input_tokens_details?.cached_tokens),
    );
    const total = num(u.total_tokens);
    // Some providers (e.g. Gemini thinking) count hidden reasoning only in total_tokens.
    const output = total > prompt + completion ? total - prompt : completion;
    const out = { input: Math.max(0, prompt - cached), cached, cacheWrite: 0, output };
    if (typeof u.cost === 'number') out.reportedCost = u.cost; // OpenRouter reports its own cost
    return out;
  },
  anthropic(u) {
    if (!u || typeof u !== 'object') return null;
    return {
      input: num(u.input_tokens),
      cached: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      output: num(u.output_tokens),
    };
  },
  responses(u) {
    if (!u || typeof u !== 'object') return null;
    const input = num(u.input_tokens);
    const cached = Math.min(input, num(u.input_tokens_details?.cached_tokens));
    return { input: input - cached, cached, cacheWrite: 0, output: num(u.output_tokens) };
  },
  embeddings(u) {
    if (!u || typeof u !== 'object') return null;
    return { ...ZERO, input: num(u.prompt_tokens ?? u.total_tokens ?? u.input_tokens) };
  },
  images(u) {
    if (!u || typeof u !== 'object') return null;
    return { ...ZERO, input: num(u.input_tokens), output: num(u.output_tokens) };
  },
};

/** What a request cost us at the provider (USD). Prices are per 1M tokens. */
export function computeCost(model, usage, units = 1) {
  const u = { ...ZERO, ...(usage || {}) };
  let inP = num(model.input_price);
  let outP = num(model.output_price);
  // A model imported without prices (e.g. from OpenRouter) is billed at the provider-reported cost.
  if (inP === 0 && outP === 0 && num(model.request_price) === 0 && typeof u.reportedCost === 'number') {
    return round(u.reportedCost, 8);
  }
  let cachedP = model.cached_input_price != null ? num(model.cached_input_price) : inP;
  let writeP = model.cache_write_price != null ? num(model.cache_write_price) : inP * 1.25;
  const promptTotal = u.input + u.cached + u.cacheWrite;
  const threshold = num(model.long_context_threshold);
  if (threshold > 0 && promptTotal > threshold) {
    const longIn = model.long_input_price != null ? num(model.long_input_price) : inP;
    const longOut = model.long_output_price != null ? num(model.long_output_price) : outP;
    const ratio = inP > 0 ? longIn / inP : 1;
    cachedP *= ratio;
    writeP *= ratio;
    inP = longIn;
    outP = longOut;
  }
  const tokenCost = (u.input * inP + u.cached * cachedP + u.cacheWrite * writeP + u.output * outP) / 1e6;
  return round(tokenCost + num(model.request_price) * Math.max(1, num(units, 1)), 8);
}

/**
 * Moves a system into its current billing period if the previous one ended.
 * auto_renew systems roll over automatically (spend resets); others become "expired" until renewed.
 */
export async function rollPeriod(db, sys, now = new Date()) {
  if (now < new Date(sys.period_end)) return { sys, expired: false };
  if (!sys.auto_renew) return { sys, expired: true };
  const anchor = new Date(sys.billing_anchor || sys.period_start);
  let start = new Date(sys.period_end);
  let end = nextBoundary(anchor, start);
  while (end <= now) {
    start = end;
    end = nextBoundary(anchor, start);
  }
  const { rows } = await db.query(
    `UPDATE systems SET period_start = $1, period_end = $2, period_spend_usd = 0, extra_credit_usd = 0, alert_level = 0
     WHERE id = $3 AND period_end = $4 RETURNING *`,
    [start, end, sys.id, sys.period_end],
  );
  if (rows[0]) {
    await logEvent(db, {
      system_id: sys.id,
      type: 'period_renewed',
      message: `تجديد تلقائي — بدأت دورة جديدة حتى ${end.toISOString().slice(0, 10)} وتصفّر الاستهلاك`,
    });
    return { sys: { ...sys, ...rows[0] }, expired: false, renewed: true };
  }
  const fresh = await db.query('SELECT * FROM systems WHERE id = $1', [sys.id]);
  return { sys: { ...sys, ...(fresh.rows[0] || {}) }, expired: false };
}

export async function rollDuePeriods(db) {
  const { rows } = await db.query(
    `SELECT * FROM systems WHERE auto_renew AND archived_at IS NULL AND period_end <= now()`,
  );
  for (const s of rows) await rollPeriod(db, s);
  return rows.length;
}

/** Starts a fresh one-month period now (manual renewal / upgrade with reset). */
export function freshPeriod(now = new Date()) {
  return { period_start: now, period_end: addMonths(now, 1), billing_anchor: now };
}

/**
 * Records a finished request: increments the period spend, appends the request log and the daily
 * rollup — one statement, so it is atomic on both Postgres and PGlite. Returns the new period spend.
 */
export async function recordUsage(db, timezone, r) {
  const u = { ...ZERO, ...(r.usage || {}) };
  const { rows } = await db.query(
    `WITH s AS (
       UPDATE systems SET period_spend_usd = period_spend_usd + $14::numeric WHERE id = $1 RETURNING period_spend_usd
     ), l AS (
       INSERT INTO usage_logs (request_id, system_id, api_key_id, model_id, model_alias, provider_id, endpoint, stream, status,
         input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_usd, latency_ms, estimated, error, note, ip)
       VALUES ($20, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $14, $15, $16, $17, $18, $19)
     ), d AS (
       INSERT INTO usage_daily (day, system_id, model_id, model_alias, provider_id, requests, errors,
         input_tokens, output_tokens, cached_tokens, cost_usd)
       VALUES ((now() AT TIME ZONE $13)::date, $1, COALESCE($3::int, 0), $4, $5, 1, $21::int,
         $9::int + $12::int, $10::int, $11::int, $14::numeric)
       ON CONFLICT (day, system_id, model_id) DO UPDATE SET
         requests = usage_daily.requests + 1,
         errors = usage_daily.errors + EXCLUDED.errors,
         input_tokens = usage_daily.input_tokens + EXCLUDED.input_tokens,
         output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens,
         cached_tokens = usage_daily.cached_tokens + EXCLUDED.cached_tokens,
         cost_usd = usage_daily.cost_usd + EXCLUDED.cost_usd,
         model_alias = EXCLUDED.model_alias,
         provider_id = EXCLUDED.provider_id
     ), k AS (
       UPDATE api_keys SET last_used_at = now() WHERE id = $2
     )
     SELECT period_spend_usd FROM s`,
    [
      r.system_id, // 1
      r.api_key_id ?? null, // 2
      r.model_id ?? null, // 3
      r.model_alias || '', // 4
      r.provider_id ?? null, // 5
      r.endpoint, // 6
      !!r.stream, // 7
      r.status, // 8
      Math.round(u.input), // 9
      Math.round(u.output), // 10
      Math.round(u.cached), // 11
      Math.round(u.cacheWrite), // 12
      timezone, // 13
      round(r.cost || 0, 8), // 14
      r.latency_ms ?? null, // 15
      !!r.estimated, // 16
      r.error ? String(r.error).slice(0, 600) : null, // 17
      r.note ? String(r.note).slice(0, 300) : null, // 18
      r.ip || null, // 19
      r.request_id || '', // 20
      r.status >= 400 ? 1 : 0, // 21
    ],
  );
  return rows[0] ? num(rows[0].period_spend_usd) : null;
}
