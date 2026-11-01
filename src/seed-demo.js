// Fills an empty database with realistic demo data (providers, plans, apps, 5 months of usage).
// The provider keys are fake: the demo shows the dashboard, it cannot call real AI models.
//   npm run seed:demo            (only when there are no apps yet)
//   npm run seed:demo -- --force
import { loadConfig, resolveSecrets } from './config.js';
import { openDb } from './db.js';
import { bootstrapAdmin } from './app.js';
import { makeCipher, generateApiKey, addMonths, round, requestId } from './util.js';
import { computeCost } from './billing.js';
import { MODEL_PRESETS, presetToModel } from './presets.js';

const cfg = loadConfig();
resolveSecrets(cfg);
const db = await openDb(cfg);
await bootstrapAdmin({ cfg, db });
const { rows: existing } = await db.query('SELECT COUNT(*)::int AS n FROM systems');
if (existing[0].n > 0 && !process.argv.includes('--force')) {
  console.log('Apps already exist — demo data skipped (add --force to insert anyway).');
  process.exit(0);
}

const cipher = makeCipher(cfg.encryptionKey);
const TZ = 'Africa/Cairo';
let seed = 20261101;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + (b - a) * rnd();
const pick = (weights) => {
  const total = weights.reduce((s, w) => s + w[1], 0);
  let r = rnd() * total;
  for (const [v, w] of weights) if ((r -= w) <= 0) return v;
  return weights[0][0];
};
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const DAY = 86400000;
const now = new Date();

// ── providers & models ──
async function provider(name, preset, kind, base_url, fakeKey) {
  const { rows } = await db.query(
    `INSERT INTO providers (name, preset, kind, base_url, api_key_enc, key_hint, last_test_at, last_test_ok, last_test_message)
     VALUES ($1, $2, $3, $4, $5, $6, now(), true, 'بيانات تجريبية') RETURNING *`,
    [name, preset, kind, base_url, cipher.encrypt(fakeKey), '••••' + fakeKey.slice(-4)],
  );
  return rows[0];
}
const anthropic = await provider('Anthropic (Claude)', 'anthropic', 'anthropic', 'https://api.anthropic.com', 'sk-ant-demo-key-not-real-0000');
const openai = await provider('OpenAI', 'openai', 'openai', 'https://api.openai.com/v1', 'sk-proj-demo-key-not-real-1111');
const gemini = await provider('Google Gemini', 'gemini', 'openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'AIza-demo-key-not-real-2222');

const models = {};
async function addModel(prov, presetList, upstream, sort) {
  const p = presetToModel(presetList.find((x) => x.upstream === upstream));
  const keys = Object.keys(p);
  const { rows } = await db.query(
    `INSERT INTO models (${keys.join(', ')}, provider_id, sort_order) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}, $${keys.length + 2}) RETURNING *`,
    [...keys.map((k) => p[k]), prov.id, sort],
  );
  models[upstream] = rows[0];
}
await addModel(anthropic, MODEL_PRESETS.anthropic, 'claude-sonnet-5-5', 1);
await addModel(anthropic, MODEL_PRESETS.anthropic, 'claude-haiku-5-5', 2);
await addModel(anthropic, MODEL_PRESETS.anthropic, 'claude-opus-5-5', 3);
await addModel(openai, MODEL_PRESETS.openai, 'gpt-5.4-mini', 4);
await addModel(openai, MODEL_PRESETS.openai, 'text-embedding-3-small', 6);
await addModel(gemini, MODEL_PRESETS.gemini, 'gemini-3.5-flash', 5);
await db.query('UPDATE models SET fallback_model_id = $1 WHERE id = $2', [models['gpt-5.4-mini'].id, models['claude-haiku-5-5'].id]);

// ── plans ──
const plans = {};
for (const [i, [name, price, limit, rpm, desc]] of [
  ['أساسية', 15, 10, 30, 'للتطبيقات الصغيرة: ردود ذكية ومساعد بسيط.'],
  ['احترافية', 30, 20, 60, 'استخدام يومي متوسط مع كل الموديلات.'],
  ['أعمال', 50, 35, 120, 'للتطبيقات النشطة وفرق العمل.'],
  ['مؤسسات', 120, 90, null, 'استهلاك مرتفع وأولوية في الدعم.'],
].entries()) {
  const { rows } = await db.query(
    `INSERT INTO plans (name, price_usd, monthly_limit_usd, rpm_limit, description, sort_order) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, price, limit, rpm, desc, i],
  );
  plans[name] = rows[0];
}

// ── apps ──
const APPS = [
  { name: 'Star Style', owner: 'فريق Star Style', contact: '+20 100 555 1201', plan: 'احترافية', pct: 0.72, age: 140, mix: [['claude-sonnet-5-5', 6], ['claude-haiku-5-5', 3], ['text-embedding-3-small', 1]] },
  { name: 'GoTrend', owner: 'شركة جو ترند', contact: '+20 111 222 3344', plan: 'أعمال', pct: 0.38, age: 120, mix: [['claude-haiku-5-5', 5], ['gpt-5.4-mini', 3], ['gemini-3.5-flash', 2]] },
  { name: 'منيو المطعم الذكي', owner: 'مطعم الأصيل', contact: '+20 122 909 4410', plan: 'أساسية', pct: 1.01, age: 75, mix: [['claude-haiku-5-5', 8], ['gpt-5.4-mini', 2]] },
  { name: 'عيادة النور', owner: 'د. سارة حسن', contact: '+20 106 777 0021', plan: 'احترافية', pct: 0.88, age: 60, mix: [['claude-sonnet-5-5', 7], ['claude-haiku-5-5', 3]] },
  { name: 'متجر لمسة', owner: 'متجر لمسة', contact: 'hello@lamsa.shop', plan: 'أساسية', pct: 0.14, age: 25, mix: [['gemini-3.5-flash', 6], ['gpt-5.4-mini', 4]] },
  { name: 'مساعد المحاسبة', owner: 'مكتب الأمانة', contact: '+20 155 300 8800', plan: 'مؤسسات', pct: 0.55, age: 150, mix: [['claude-opus-5-5', 2], ['claude-sonnet-5-5', 6], ['text-embedding-3-small', 2]] },
  { name: 'تطبيق التوصيل السريع', owner: 'سريع للخدمات', contact: '+20 128 440 7000', plan: 'أساسية', pct: 0.86, age: 70, expired: true, mix: [['gpt-5.4-mini', 7], ['claude-haiku-5-5', 3]] },
];

const tokensFor = (m) => {
  if (m.kind === 'embedding') return { input: Math.round(between(200, 2500)), cached: 0, cacheWrite: 0, output: 0 };
  const input = Math.round(between(600, 5200));
  const cached = rnd() < 0.25 ? Math.round(input * between(0.3, 0.7)) : 0;
  return { input: input - cached, cached, cacheWrite: 0, output: Math.round(between(150, 1300)) };
};
const avgCost = (mix) => {
  let total = 0;
  let n = 0;
  for (let i = 0; i < 400; i++) {
    total += computeCost(models[pick(mix)], tokensFor(models[pick(mix)]));
    n++;
  }
  return total / n;
};

const logRows = [];
const daily = new Map();
function addUsage(sys, when, model, u, status = 200, error = null) {
  const cost = status < 400 ? computeCost(model, u) : 0;
  logRows.push([
    when, requestId(), sys.id, sys.key_id, status < 400 ? model.id : null, model.alias, model.provider_id,
    model.provider_id === anthropic.id ? (rnd() < 0.7 ? 'messages' : 'chat') : model.kind === 'embedding' ? 'embeddings' : 'chat',
    rnd() < 0.6, status, u.input + u.cacheWrite, u.output, u.cached, u.cacheWrite, cost,
    Math.round(between(700, 9000)), error,
  ]);
  const k = `${dayKey(when)}|${sys.id}|${status < 400 ? model.id : 0}`;
  const d = daily.get(k) || { day: dayKey(when), system_id: sys.id, model_id: status < 400 ? model.id : 0, alias: model.alias, provider: model.provider_id, req: 0, err: 0, inp: 0, out: 0, cached: 0, cost: 0 };
  d.req++;
  if (status >= 400) d.err++;
  d.inp += u.input + u.cacheWrite;
  d.out += u.output;
  d.cached += u.cached;
  d.cost += cost;
  daily.set(k, d);
  return cost;
}

for (const app of APPS) {
  const plan = plans[app.plan];
  const created = new Date(now.getTime() - app.age * DAY);
  let start = new Date(created);
  while (addMonths(start, 1) <= now) start = addMonths(start, 1);
  let end = addMonths(start, 1);
  if (app.expired) {
    end = new Date(now.getTime() - 2 * DAY);
    start = addMonths(end, -1);
  }
  const key = generateApiKey();
  const { rows } = await db.query(
    `INSERT INTO systems (name, owner_name, contact, plan_id, period_start, period_end, billing_anchor, auto_renew, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [app.name, app.owner, app.contact, plan.id, start, end, start, !app.expired, created],
  );
  const sys = rows[0];
  const k = await db.query(
    `INSERT INTO api_keys (system_id, name, key_hash, key_prefix, key_last4, created_at, last_used_at) VALUES ($1, 'prod', $2, $3, $4, $5, $6) RETURNING id`,
    [sys.id, key.hash, key.prefix, key.last4, created, app.expired ? end : new Date(now.getTime() - between(2, 50) * 60000)],
  );
  sys.key_id = k.rows[0].id;
  const limit = Number(plan.monthly_limit_usd);
  const per = avgCost(app.mix);

  // Older months: monthly aggregates only (feeds the finance history) + a paid subscription each month.
  let monthStart = new Date(created);
  while (monthStart < start) {
    const mEnd = addMonths(monthStart, 1);
    const target = limit * between(0.45, 0.9);
    const days = Math.max(1, Math.round((Math.min(mEnd, start) - monthStart) / DAY));
    for (let i = 0; i < days; i++) {
      const when = new Date(monthStart.getTime() + i * DAY + between(9, 22) * 3600000);
      const n = Math.max(1, Math.round((target / days / per) * between(0.6, 1.4)));
      for (let r = 0; r < n; r++) {
        const m = models[pick(app.mix)];
        const u = tokensFor(m);
        const cost = computeCost(m, u);
        const kk = `${dayKey(when)}|${sys.id}|${m.id}`;
        const d = daily.get(kk) || { day: dayKey(when), system_id: sys.id, model_id: m.id, alias: m.alias, provider: m.provider_id, req: 0, err: 0, inp: 0, out: 0, cached: 0, cost: 0 };
        d.req++;
        d.inp += u.input;
        d.out += u.output;
        d.cached += u.cached;
        d.cost += cost;
        daily.set(kk, d);
      }
    }
    await db.query(
      `INSERT INTO payments (system_id, system_name, amount_usd, kind, method, created_by, paid_at) VALUES ($1, $2, $3, 'subscription', $4, 'المدير', $5)`,
      [sys.id, sys.name, plan.price_usd, pick([['تحويل بنكي', 2], ['فودافون كاش', 3], ['إنستاباي', 3]]), monthStart],
    );
    monthStart = mEnd;
  }

  // Current period: individual request logs that add up to the target percentage.
  const target = limit * app.pct;
  const stopAt = Math.min(now.getTime(), end.getTime());
  const periodDays = Math.max(1, Math.ceil((stopAt - start.getTime()) / DAY));
  let spent = 0;
  for (let i = 0; i < periodDays && spent < target; i++) {
    const dayStart = start.getTime() + i * DAY;
    const remainingDays = periodDays - i;
    const n = Math.max(1, Math.round(((target - spent) / remainingDays / per) * between(0.55, 1.45)));
    for (let r = 0; r < n && spent < target; r++) {
      const when = new Date(Math.min(dayStart + between(0, DAY), stopAt - 60000));
      const m = models[pick(app.mix)];
      spent += addUsage(sys, when, m, tokensFor(m));
    }
    if (rnd() < 0.08) addUsage(sys, new Date(dayStart + between(0, DAY)), models[pick(app.mix)], { input: 0, cached: 0, cacheWrite: 0, output: 0 }, 400, 'upstream_invalid_request: max_tokens is too large');
  }
  // Make sure the app meant to be over its limit really is.
  while (app.pct >= 1 && spent < limit * app.pct) {
    const m = models[pick(app.mix)];
    spent += addUsage(sys, new Date(now.getTime() - between(30, 200) * 60000), m, tokensFor(m));
  }
  if (app.pct >= 1 || app.expired) {
    for (let r = 0; r < 4; r++) {
      const when = new Date(now.getTime() - between(1, 30) * 3600000);
      addUsage(sys, when, models[pick(app.mix)], { input: 0, cached: 0, cacheWrite: 0, output: 0 }, 402, app.expired ? 'subscription_expired' : 'budget_exceeded');
    }
  }
  await db.query('UPDATE systems SET period_spend_usd = $2, alert_level = $3 WHERE id = $1', [
    sys.id,
    round(spent, 8),
    spent >= limit ? 100 : spent / limit >= 0.8 ? 80 : 0,
  ]);
  await db.query(
    `INSERT INTO payments (system_id, system_name, amount_usd, kind, method, created_by, paid_at) VALUES ($1, $2, $3, 'subscription', $4, 'المدير', $5)`,
    [sys.id, sys.name, plan.price_usd, pick([['تحويل بنكي', 2], ['فودافون كاش', 3], ['إنستاباي', 3]]), start],
  );
  const ev = (type, message, at, actor = 'المدير') =>
    db.query(`INSERT INTO events (system_id, actor, type, message, created_at) VALUES ($1, $2, $3, $4, $5)`, [sys.id, actor, type, message, at]);
  await ev('system_created', `تمت إضافة التطبيق «${sys.name}»`, created);
  if (start > created) await ev('period_renewed', 'تجديد تلقائي — بدأت دورة جديدة وتصفّر الاستهلاك', start, 'system');
  if (spent / limit >= 0.8) await ev('limit_warning', `⚠️ «${sys.name}» استهلك 80% من حده الشهري.`, new Date(now.getTime() - between(3, 40) * 3600000), 'system');
  if (spent >= limit) await ev('limit_reached', `⛔ «${sys.name}» وصل للحد الشهري وتوقفت طلباته.`, new Date(now.getTime() - between(1, 3) * 3600000), 'system');
  if (app.expired) await ev('expired', `🔒 انتهى اشتراك «${sys.name}» — الطلبات متوقفة حتى التجديد.`, end, 'system');
}

// ── bulk insert (chronological, like real traffic) ──
logRows.sort((a, b) => a[0] - b[0]);
for (let i = 0; i < logRows.length; i += 400) {
  const chunk = logRows.slice(i, i + 400);
  const values = [];
  const params = [];
  chunk.forEach((row, r) => {
    values.push(`(${row.map((_, c) => `$${r * row.length + c + 1}`).join(', ')})`);
    params.push(...row);
  });
  await db.query(
    `INSERT INTO usage_logs (created_at, request_id, system_id, api_key_id, model_id, model_alias, provider_id, endpoint, stream, status,
       input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_usd, latency_ms, error) VALUES ${values.join(', ')}`,
    params,
  );
}
const dailyRows = [...daily.values()];
for (let i = 0; i < dailyRows.length; i += 400) {
  const chunk = dailyRows.slice(i, i + 400);
  const values = [];
  const params = [];
  chunk.forEach((d, r) => {
    const row = [d.day, d.system_id, d.model_id, d.alias, d.provider, d.req, d.err, d.inp, d.out, d.cached, round(d.cost, 8)];
    values.push(`(${row.map((_, c) => `$${r * row.length + c + 1}`).join(', ')})`);
    params.push(...row);
  });
  await db.query(
    `INSERT INTO usage_daily (day, system_id, model_id, model_alias, provider_id, requests, errors, input_tokens, output_tokens, cached_tokens, cost_usd)
     VALUES ${values.join(', ')}
     ON CONFLICT (day, system_id, model_id) DO UPDATE SET requests = usage_daily.requests + EXCLUDED.requests,
       errors = usage_daily.errors + EXCLUDED.errors, input_tokens = usage_daily.input_tokens + EXCLUDED.input_tokens,
       output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens, cached_tokens = usage_daily.cached_tokens + EXCLUDED.cached_tokens,
       cost_usd = usage_daily.cost_usd + EXCLUDED.cost_usd`,
    params,
  );
}
await db.query(
  `INSERT INTO settings (key, value) VALUES ('support_contact', $1) ON CONFLICT (key) DO NOTHING`,
  [JSON.stringify('+20 100 000 0000')],
);
console.log(`Demo data ready: ${APPS.length} apps, ${logRows.length} request logs. Provider keys are fake.`);
await db.close();
