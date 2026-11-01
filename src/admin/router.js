import express from 'express';
import {
  HttpError,
  num,
  round,
  generateApiKey,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  parseCookies,
  maskTail,
  scrubSecrets,
} from '../util.js';
import { effectiveLimit, freshPeriod, rollDuePeriods } from '../billing.js';
import { logEvent } from '../events.js';
import {
  PROVIDER_PRESETS,
  MODEL_PRESETS,
  PRICES_CHECKED_AT,
  presetToModel,
  guessModelKind,
  isUnsupportedModel,
} from '../presets.js';
import { normalizeModelName } from '../catalog.js';
import { providerHeaders, providerUrl, upstreamFetch } from '../proxy/upstream.js';

const COOKIE = 'gw_admin';
const SESSION_DAYS = 7;
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$' + 'A'.repeat(86);

// ───────────── input validation ─────────────
const v = {
  str(val, { max = 200, required = false, name = 'الحقل' } = {}) {
    const s = val == null ? '' : String(val).trim();
    if (required && !s) throw new HttpError(400, `${name} مطلوب`);
    return s.slice(0, max);
  },
  money(val, { name = 'المبلغ', allowNull = false, min = 0, positive = false } = {}) {
    if (val === '' || val == null) {
      if (allowNull) return null;
      throw new HttpError(400, `${name} مطلوب`);
    }
    const n = Number(val);
    if (!Number.isFinite(n) || n < min || (positive && n <= 0)) throw new HttpError(400, `${name} غير صالح`);
    return round(n, 6);
  },
  int(val, { name = 'الرقم', allowNull = true, min = 0, max = 1e9 } = {}) {
    if (val === '' || val == null) {
      if (allowNull) return null;
      throw new HttpError(400, `${name} مطلوب`);
    }
    const n = Number(val);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} غير صالح`);
    return n;
  },
  bool: (val) => val === true || val === 'true' || val === 1 || val === '1' || val === 'on',
  url(val, { name = 'الرابط', required = false } = {}) {
    const s = v.str(val, { max: 500 });
    if (!s) {
      if (required) throw new HttpError(400, `${name} مطلوب`);
      return '';
    }
    try {
      const u = new URL(s);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      return s.replace(/\/+$/, '');
    } catch {
      throw new HttpError(400, `${name} غير صالح — يجب أن يبدأ بـ https://`);
    }
  },
  date(val) {
    if (!val) return null;
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'تاريخ غير صالح');
    return d;
  },
  ymd(val) {
    if (!val) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(val))) throw new HttpError(400, 'تاريخ غير صالح');
    return String(val);
  },
};

const ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

function updateQuery(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return null;
  return {
    text: `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
    values: [...keys.map((k) => fields[k]), id],
  };
}

function lastDays(today, n) {
  const base = new Date(`${today}T00:00:00Z`);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function fillDays(days, rows) {
  const map = new Map(rows.map((r) => [r.day, r]));
  return days.map((day) => ({ day, cost: round(map.get(day)?.cost || 0, 6), requests: map.get(day)?.requests || 0 }));
}

export function decorateSystem(s, warn = 80, now = Date.now()) {
  const limit = effectiveLimit(s);
  const spend = num(s.period_spend_usd);
  const pct = limit > 0 ? (spend / limit) * 100 : spend > 0 ? 100 : 0;
  const end = new Date(s.period_end).getTime();
  let state = 'active';
  if (s.archived_at) state = 'archived';
  else if (s.status === 'suspended') state = 'suspended';
  else if (!s.plan_id && s.limit_override_usd == null) state = 'no_plan';
  else if (end <= now && !s.auto_renew) state = 'expired';
  else if (limit <= 0 || spend >= limit) state = 'limit_reached';
  else if (pct >= warn) state = 'warning';
  return {
    ...s,
    limit_usd: limit,
    spend_usd: round(spend, 6),
    remaining_usd: round(Math.max(0, limit - spend), 6),
    usage_pct: round(pct, 2),
    days_left: Math.ceil((end - now) / 86400000),
    state,
  };
}

const SYSTEM_SELECT = `
  SELECT s.*, p.name AS plan_name, p.price_usd AS plan_price, p.monthly_limit_usd AS plan_limit, p.rpm_limit,
    (SELECT COUNT(*)::int FROM api_keys k WHERE k.system_id = s.id AND k.revoked_at IS NULL) AS active_keys,
    (SELECT MAX(k.last_used_at) FROM api_keys k WHERE k.system_id = s.id) AS last_used_at
  FROM systems s LEFT JOIN plans p ON p.id = s.plan_id`;

export function createAdminRouter({ cfg, db, catalog, settings, alerts, rl, cipher, log }) {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));
  r.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Reject cross-site writes (cookies are SameSite=Strict too).
  r.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'طلب مرفوض (origin)' });
      } catch {
        return res.status(403).json({ error: 'طلب مرفوض (origin)' });
      }
    }
    next();
  });

  const baseUrlFor = async (req) => {
    const s = await settings.all();
    return (s.public_url || cfg.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  };

  function setSession(req, res, admin) {
    const token = signToken({ uid: admin.id, sv: admin.session_version, exp: Date.now() + SESSION_DAYS * 864e5 }, cfg.sessionSecret);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`,
    );
  }

  // ───────────── public ─────────────
  r.get('/public/info', async (req, res) => {
    const s = await settings.all();
    res.json({ brand_name: s.brand_name });
  });

  r.post('/auth/login', async (req, res) => {
    const limit = rl.hit('login:' + req.ip, 10, 15 * 60 * 1000);
    if (!limit.ok) throw new HttpError(429, `محاولات كثيرة، حاول بعد ${Math.ceil(limit.retryAfter / 60)} دقيقة`);
    const email = v.str(req.body?.email, { max: 200 }).toLowerCase();
    const password = String(req.body?.password || '');
    const { rows } = await db.query('SELECT * FROM admins WHERE email = $1', [email]);
    const admin = rows[0];
    const ok = await verifyPassword(password, admin?.password_hash || DUMMY_HASH);
    if (!admin || !ok) throw new HttpError(401, 'البريد أو كلمة المرور غير صحيحة');
    rl.reset('login:' + req.ip);
    await db.query('UPDATE admins SET last_login_at = now() WHERE id = $1', [admin.id]);
    setSession(req, res, admin);
    res.json({ admin: { id: admin.id, email: admin.email, name: admin.name } });
  });

  r.post('/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  // ───────────── session required below ─────────────
  r.use(async (req, res, next) => {
    const payload = verifyToken(parseCookies(req.headers.cookie)[COOKIE], cfg.sessionSecret);
    if (!payload) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
    const { rows } = await db.query('SELECT id, email, name, session_version FROM admins WHERE id = $1', [payload.uid]);
    const a = rows[0];
    if (!a || a.session_version !== payload.sv) return res.status(401).json({ error: 'انتهت الجلسة، سجل الدخول مرة أخرى' });
    req.admin = a;
    req.actor = a.name || a.email;
    next();
  });

  r.get('/auth/me', async (req, res) => {
    const s = await settings.all();
    res.json({
      admin: req.admin,
      brand_name: s.brand_name,
      timezone: s.timezone,
      warn_threshold: num(s.warn_threshold, 80),
      base_url: await baseUrlFor(req),
    });
  });

  // ───────────── overview ─────────────
  r.get('/overview', async (req, res) => {
    await rollDuePeriods(db);
    const s = await settings.all();
    const tz = s.timezone;
    const { rows: [b] } = await db.query(
      `SELECT (date_trunc('month', now() AT TIME ZONE $1))::date AS m0,
              (date_trunc('month', now() AT TIME ZONE $1) - interval '1 month')::date AS pm0,
              (now() AT TIME ZONE $1)::date AS today`,
      [tz],
    );
    const usageSum = `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS cost, COALESCE(SUM(requests), 0)::int AS requests,
        COALESCE(SUM(errors), 0)::int AS errors, COALESCE(SUM(input_tokens + output_tokens + cached_tokens), 0)::float8 AS tokens
      FROM usage_daily`;
    const [cur, prev, rev, prevRev, daily, byModel, systems, setup, mrr, events] = await Promise.all([
      db.query(`${usageSum} WHERE day >= $1`, [b.m0]),
      db.query(`${usageSum} WHERE day >= $1 AND day < $2`, [b.pm0, b.m0]),
      db.query(`SELECT COALESCE(SUM(amount_usd), 0)::float8 AS v FROM payments WHERE paid_at >= ($1::date::timestamp AT TIME ZONE $2)`, [b.m0, tz]),
      db.query(
        `SELECT COALESCE(SUM(amount_usd), 0)::float8 AS v FROM payments
         WHERE paid_at >= ($1::date::timestamp AT TIME ZONE $3) AND paid_at < ($2::date::timestamp AT TIME ZONE $3)`,
        [b.pm0, b.m0, tz],
      ),
      db.query(
        `SELECT day, SUM(cost_usd)::float8 AS cost, SUM(requests)::int AS requests FROM usage_daily
         WHERE day > $1::date - 30 GROUP BY day ORDER BY day`,
        [b.today],
      ),
      db.query(
        `SELECT model_alias AS model, SUM(cost_usd)::float8 AS cost, SUM(requests)::int AS requests FROM usage_daily
         WHERE day >= $1 AND model_id <> 0 GROUP BY model_alias ORDER BY cost DESC LIMIT 8`,
        [b.m0],
      ),
      db.query(`${SYSTEM_SELECT} WHERE s.archived_at IS NULL ORDER BY s.created_at DESC`),
      db.query(
        `SELECT (SELECT COUNT(*) FROM providers)::int AS providers, (SELECT COUNT(*) FROM models)::int AS models,
                (SELECT COUNT(*) FROM plans WHERE NOT archived)::int AS plans,
                (SELECT COUNT(*) FROM systems WHERE archived_at IS NULL)::int AS systems`,
      ),
      db.query(
        `SELECT COALESCE(SUM(p.price_usd), 0)::float8 AS v FROM systems s JOIN plans p ON p.id = s.plan_id
         WHERE s.archived_at IS NULL AND s.status = 'active'`,
      ),
      db.query(
        `SELECT e.id, e.created_at, e.type, e.message, e.actor, e.system_id, s.name AS system_name
         FROM events e LEFT JOIN systems s ON s.id = e.system_id ORDER BY e.id DESC LIMIT 12`,
      ),
    ]);
    const warn = num(s.warn_threshold, 80);
    const list = systems.rows.map((x) => decorateSystem(x, warn));
    const month = { ...cur.rows[0], revenue: rev.rows[0].v };
    month.profit = round(month.revenue - month.cost, 6);
    const prevMonth = { ...prev.rows[0], revenue: prevRev.rows[0].v };
    prevMonth.profit = round(prevMonth.revenue - prevMonth.cost, 6);
    res.json({
      brand_name: s.brand_name,
      today: b.today,
      month,
      prev_month: prevMonth,
      mrr: mrr.rows[0].v,
      daily: fillDays(lastDays(b.today, 30), daily.rows),
      by_model: byModel.rows,
      systems: list.sort((a, c) => c.usage_pct - a.usage_pct),
      attention: list.filter(
        (x) =>
          ['warning', 'limit_reached', 'expired', 'suspended', 'no_plan'].includes(x.state) ||
          (!x.auto_renew && x.days_left <= 3 && x.state === 'active'),
      ),
      setup: setup.rows[0],
      events: events.rows,
    });
  });

  // ───────────── systems ─────────────
  async function loadSystem(id) {
    const { rows } = await db.query(`${SYSTEM_SELECT} WHERE s.id = $1`, [id]);
    if (!rows[0]) throw new HttpError(404, 'النظام غير موجود');
    return rows[0];
  }

  /** Enabled models an app can call (respecting its plan), for the integration snippets. */
  async function modelsFor(sysId) {
    const [{ rows }, { rows: plan }] = await Promise.all([
      db.query(
        `SELECT m.id, m.alias, m.kind, p.kind AS provider_kind FROM models m JOIN providers p ON p.id = m.provider_id
         WHERE m.enabled AND p.enabled ORDER BY m.sort_order, m.alias`,
      ),
      db.query(`SELECT p.allowed_models FROM systems s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`, [sysId]),
    ]);
    const allowed = Array.isArray(plan[0]?.allowed_models) && plan[0].allowed_models.length ? plan[0].allowed_models.map(Number) : null;
    return rows.filter((m) => !allowed || allowed.includes(m.id)).map(({ id, ...m }) => m);
  }

  async function insertPayment(q, sys, p, kind, actor, credit = null) {
    const amount = v.money(p?.amount_usd, { allowNull: true, name: 'المبلغ المدفوع' });
    if (!amount) return null;
    const { rows } = await q.query(
      `INSERT INTO payments (system_id, system_name, amount_usd, kind, method, credit_usd, note, created_by, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now())) RETURNING *`,
      [sys.id, sys.name, amount, kind, v.str(p.method, { max: 60 }), credit, v.str(p.note, { max: 300 }), actor, v.date(p.paid_at)],
    );
    return rows[0];
  }

  r.get('/systems', async (req, res) => {
    await rollDuePeriods(db);
    const s = await settings.all();
    const archived = v.bool(req.query.archived);
    const { rows } = await db.query(
      `${SYSTEM_SELECT} WHERE ${archived ? 's.archived_at IS NOT NULL' : 's.archived_at IS NULL'} ORDER BY s.created_at DESC`,
    );
    const plans = await db.query(`SELECT id, name, price_usd, monthly_limit_usd, archived FROM plans ORDER BY sort_order, price_usd`);
    res.json({ systems: rows.map((x) => decorateSystem(x, num(s.warn_threshold, 80))), plans: plans.rows, base_url: await baseUrlFor(req) });
  });

  r.post('/systems', async (req, res) => {
    const b = req.body || {};
    const name = v.str(b.name, { required: true, name: 'اسم النظام', max: 120 });
    const plan_id = b.plan_id ? v.int(b.plan_id, { name: 'الباقة' }) : null;
    if (plan_id) {
      const p = await db.query('SELECT id FROM plans WHERE id = $1', [plan_id]);
      if (!p.rows[0]) throw new HttpError(400, 'الباقة غير موجودة');
    }
    const limit_override_usd = v.money(b.limit_override_usd, { allowNull: true, name: 'الحد المخصص' });
    if (!plan_id && limit_override_usd == null) throw new HttpError(400, 'اختر باقة أو حدد حداً شهرياً مخصصاً');
    const per = freshPeriod();
    const key = generateApiKey();
    const sys = await db.tx(async (q) => {
      const { rows } = await q.query(
        `INSERT INTO systems (name, owner_name, contact, plan_id, limit_override_usd, auto_renew, notes, webhook_url,
           period_start, period_end, billing_anchor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          name,
          v.str(b.owner_name, { max: 120 }),
          v.str(b.contact, { max: 120 }),
          plan_id,
          limit_override_usd,
          b.auto_renew === undefined ? true : v.bool(b.auto_renew),
          v.str(b.notes, { max: 1000 }),
          v.url(b.webhook_url, { name: 'رابط الـ Webhook' }),
          per.period_start,
          per.period_end,
          per.billing_anchor,
        ],
      );
      await q.query(`INSERT INTO api_keys (system_id, name, key_hash, key_prefix, key_last4) VALUES ($1, 'default', $2, $3, $4)`, [
        rows[0].id,
        key.hash,
        key.prefix,
        key.last4,
      ]);
      await insertPayment(q, rows[0], b.payment, 'subscription', req.actor);
      return rows[0];
    });
    await logEvent(db, { system_id: sys.id, actor: req.actor, type: 'system_created', message: `تمت إضافة النظام «${name}»` });
    res.status(201).json({
      system: await loadSystem(sys.id),
      api_key: key.key,
      base_url: await baseUrlFor(req),
      models: await modelsFor(sys.id),
    });
  });

  r.get('/systems/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    await rollDuePeriods(db);
    const s = await settings.all();
    const sys = decorateSystem(await loadSystem(id), num(s.warn_threshold, 80));
    const { rows: [b] } = await db.query(`SELECT (now() AT TIME ZONE $1)::date AS today`, [s.timezone]);
    const [keys, daily, byModel, totals, logs, payments, events, plans] = await Promise.all([
      db.query(
        `SELECT id, name, key_prefix, key_last4, revoked_at, last_used_at, created_at FROM api_keys
         WHERE system_id = $1 ORDER BY revoked_at NULLS FIRST, id DESC`,
        [id],
      ),
      db.query(
        `SELECT day, SUM(cost_usd)::float8 AS cost, SUM(requests)::int AS requests FROM usage_daily
         WHERE system_id = $1 AND day > $2::date - 30 GROUP BY day ORDER BY day`,
        [id, b.today],
      ),
      db.query(
        `SELECT model_alias AS model, COUNT(*)::int AS requests, COALESCE(SUM(cost_usd), 0)::float8 AS cost,
                COALESCE(SUM(input_tokens + cached_tokens + cache_write_tokens), 0)::float8 AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens
         FROM usage_logs WHERE system_id = $1 AND created_at >= $2 AND status < 400
         GROUP BY model_alias ORDER BY cost DESC`,
        [id, sys.period_start],
      ),
      db.query(
        `SELECT COUNT(*)::int AS requests, COUNT(*) FILTER (WHERE status >= 400)::int AS errors,
                COALESCE(SUM(input_tokens + cached_tokens + cache_write_tokens), 0)::float8 AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens
         FROM usage_logs WHERE system_id = $1 AND created_at >= $2`,
        [id, sys.period_start],
      ),
      db.query(`SELECT * FROM usage_logs WHERE system_id = $1 ORDER BY id DESC LIMIT 25`, [id]),
      db.query(`SELECT * FROM payments WHERE system_id = $1 ORDER BY paid_at DESC LIMIT 50`, [id]),
      db.query(`SELECT * FROM events WHERE system_id = $1 ORDER BY id DESC LIMIT 30`, [id]),
      db.query(`SELECT id, name, price_usd, monthly_limit_usd, archived FROM plans ORDER BY sort_order, price_usd`),
    ]);
    res.json({
      system: sys,
      keys: keys.rows,
      daily: fillDays(lastDays(b.today, 30), daily.rows),
      by_model: byModel.rows,
      totals: totals.rows[0],
      logs: logs.rows,
      payments: payments.rows,
      events: events.rows,
      plans: plans.rows,
      base_url: await baseUrlFor(req),
      models: await modelsFor(id),
    });
  });

  r.patch('/systems/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const before = await loadSystem(id);
    const b = req.body || {};
    const f = {};
    if ('name' in b) f.name = v.str(b.name, { required: true, name: 'اسم النظام', max: 120 });
    if ('owner_name' in b) f.owner_name = v.str(b.owner_name, { max: 120 });
    if ('contact' in b) f.contact = v.str(b.contact, { max: 120 });
    if ('notes' in b) f.notes = v.str(b.notes, { max: 1000 });
    if ('webhook_url' in b) f.webhook_url = v.url(b.webhook_url, { name: 'رابط الـ Webhook' });
    if ('auto_renew' in b) f.auto_renew = v.bool(b.auto_renew);
    if ('limit_override_usd' in b) f.limit_override_usd = v.money(b.limit_override_usd, { allowNull: true, name: 'الحد المخصص' });
    if ('status' in b) {
      if (!['active', 'suspended'].includes(b.status)) throw new HttpError(400, 'حالة غير صالحة');
      f.status = b.status;
    }
    if ('limit_override_usd' in f && f.limit_override_usd == null && !before.plan_id) {
      throw new HttpError(400, 'النظام بدون باقة — لا يمكن إلغاء الحد المخصص');
    }
    if ('limit_override_usd' in f) f.alert_level = 0;
    const q = updateQuery('systems', id, f);
    if (q) await db.query(q.text, q.values);
    if ('status' in f && f.status !== before.status) {
      await logEvent(db, {
        system_id: id,
        actor: req.actor,
        type: f.status === 'suspended' ? 'system_suspended' : 'system_activated',
        message: f.status === 'suspended' ? 'تم إيقاف النظام مؤقتاً' : 'تم تفعيل النظام',
      });
    } else if (q) {
      await logEvent(db, { system_id: id, actor: req.actor, type: 'system_updated', message: 'تم تعديل بيانات النظام' });
    }
    res.json({ system: await loadSystem(id) });
  });

  r.post('/systems/:id/topup', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const sys = await loadSystem(id);
    const b = req.body || {};
    const credit = v.money(b.credit_usd, { name: 'الرصيد المضاف', positive: true });
    await db.tx(async (q) => {
      await q.query('UPDATE systems SET extra_credit_usd = extra_credit_usd + $2, alert_level = 0 WHERE id = $1', [id, credit]);
      await insertPayment(q, sys, b, 'topup', req.actor, credit);
    });
    await logEvent(db, {
      system_id: id,
      actor: req.actor,
      type: 'topup',
      message: `شحن رصيد إضافي $${credit.toFixed(2)} للدورة الحالية${num(b.amount_usd) ? ` (مدفوع $${num(b.amount_usd).toFixed(2)})` : ''}`,
    });
    res.json({ system: await loadSystem(id) });
  });

  r.post('/systems/:id/renew', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const sys = await loadSystem(id);
    const per = freshPeriod();
    await db.tx(async (q) => {
      await q.query(
        `UPDATE systems SET period_start = $2, period_end = $3, billing_anchor = $4, period_spend_usd = 0, extra_credit_usd = 0,
           alert_level = 0, expiry_notice_for = NULL, expired_notice_for = NULL WHERE id = $1`,
        [id, per.period_start, per.period_end, per.billing_anchor],
      );
      await insertPayment(q, sys, req.body || {}, 'subscription', req.actor);
    });
    await logEvent(db, {
      system_id: id,
      actor: req.actor,
      type: 'renewed',
      message: `تجديد الاشتراك — دورة جديدة حتى ${per.period_end.toISOString().slice(0, 10)}`,
    });
    res.json({ system: await loadSystem(id) });
  });

  r.post('/systems/:id/change-plan', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const sys = await loadSystem(id);
    const b = req.body || {};
    const planId = v.int(b.plan_id, { allowNull: false, name: 'الباقة' });
    const { rows: [plan] } = await db.query('SELECT * FROM plans WHERE id = $1', [planId]);
    if (!plan) throw new HttpError(400, 'الباقة غير موجودة');
    const reset = b.reset_period === undefined ? true : v.bool(b.reset_period);
    const per = freshPeriod();
    await db.tx(async (q) => {
      if (reset) {
        await q.query(
          `UPDATE systems SET plan_id = $2, limit_override_usd = NULL, period_start = $3, period_end = $4, billing_anchor = $5,
             period_spend_usd = 0, extra_credit_usd = 0, alert_level = 0, expiry_notice_for = NULL, expired_notice_for = NULL
           WHERE id = $1`,
          [id, planId, per.period_start, per.period_end, per.billing_anchor],
        );
      } else {
        await q.query('UPDATE systems SET plan_id = $2, limit_override_usd = NULL, alert_level = 0 WHERE id = $1', [id, planId]);
      }
      const kind = sys.plan_id !== planId && num(plan.price_usd) > num(sys.plan_price) ? 'upgrade' : 'subscription';
      await insertPayment(q, sys, b, kind, req.actor);
    });
    await logEvent(db, {
      system_id: id,
      actor: req.actor,
      type: 'plan_changed',
      message: `تغيير الباقة من «${sys.plan_name || '—'}» إلى «${plan.name}»${reset ? ' مع بدء دورة جديدة' : ''}`,
    });
    res.json({ system: await loadSystem(id) });
  });

  r.post('/systems/:id/keys', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const sys = await loadSystem(id);
    if (sys.archived_at) throw new HttpError(400, 'النظام مؤرشف');
    const name = v.str(req.body?.name, { max: 60 }) || 'key';
    const key = generateApiKey();
    const { rows } = await db.query(
      `INSERT INTO api_keys (system_id, name, key_hash, key_prefix, key_last4) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, key_prefix, key_last4, created_at`,
      [id, name, key.hash, key.prefix, key.last4],
    );
    if (v.bool(req.body?.revoke_others)) {
      await db.query('UPDATE api_keys SET revoked_at = now() WHERE system_id = $1 AND id <> $2 AND revoked_at IS NULL', [id, rows[0].id]);
    }
    await logEvent(db, { system_id: id, actor: req.actor, type: 'key_created', message: `إنشاء مفتاح جديد «${name}»` });
    res.status(201).json({ key: rows[0], api_key: key.key, base_url: await baseUrlFor(req), models: await modelsFor(id) });
  });

  r.delete('/systems/:id/keys/:keyId', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const keyId = v.int(req.params.keyId, { allowNull: false });
    const { rows } = await db.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND system_id = $2 AND revoked_at IS NULL RETURNING name',
      [keyId, id],
    );
    if (!rows[0]) throw new HttpError(404, 'المفتاح غير موجود');
    await logEvent(db, { system_id: id, actor: req.actor, type: 'key_revoked', message: `إلغاء المفتاح «${rows[0].name}»` });
    res.json({ ok: true });
  });

  r.delete('/systems/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const sys = await loadSystem(id);
    if (v.bool(req.query.purge)) {
      if (!sys.archived_at) throw new HttpError(400, 'يجب أرشفة النظام أولاً قبل الحذف النهائي');
      await db.tx(async (q) => {
        await q.query('DELETE FROM usage_logs WHERE system_id = $1', [id]);
        await q.query('DELETE FROM usage_daily WHERE system_id = $1', [id]);
        await q.query('DELETE FROM events WHERE system_id = $1', [id]);
        await q.query('DELETE FROM systems WHERE id = $1', [id]);
      });
      await logEvent(db, { actor: req.actor, type: 'system_purged', message: `حذف نهائي للنظام «${sys.name}»` });
      return res.json({ ok: true, purged: true });
    }
    await db.query('UPDATE systems SET archived_at = now() WHERE id = $1', [id]);
    await db.query('UPDATE api_keys SET revoked_at = now() WHERE system_id = $1 AND revoked_at IS NULL', [id]);
    await logEvent(db, { system_id: id, actor: req.actor, type: 'system_archived', message: 'أرشفة النظام وإلغاء مفاتيحه' });
    res.json({ ok: true, archived: true });
  });

  r.post('/systems/:id/restore', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    await db.query('UPDATE systems SET archived_at = NULL WHERE id = $1', [id]);
    await logEvent(db, { system_id: id, actor: req.actor, type: 'system_restored', message: 'استعادة النظام من الأرشيف — أنشئ مفتاحاً جديداً لتشغيله' });
    res.json({ system: await loadSystem(id) });
  });

  // ───────────── plans ─────────────
  function planFields(b, partial) {
    const f = {};
    if (!partial || 'name' in b) f.name = v.str(b.name, { required: true, name: 'اسم الباقة', max: 80 });
    if (!partial || 'price_usd' in b) f.price_usd = v.money(b.price_usd ?? 0, { name: 'سعر الباقة' });
    if (!partial || 'monthly_limit_usd' in b) f.monthly_limit_usd = v.money(b.monthly_limit_usd, { name: 'حد الاستهلاك', positive: true });
    if (!partial || 'rpm_limit' in b) f.rpm_limit = v.int(b.rpm_limit, { name: 'حد الطلبات في الدقيقة', min: 1 });
    if (!partial || 'description' in b) f.description = v.str(b.description, { max: 500 });
    if (!partial || 'is_public' in b) f.is_public = b.is_public === undefined ? true : v.bool(b.is_public);
    if (!partial || 'sort_order' in b) f.sort_order = v.int(b.sort_order ?? 0, { min: -1000, max: 1000, allowNull: false });
    if (!partial || 'allowed_models' in b) {
      const list = Array.isArray(b.allowed_models) ? [...new Set(b.allowed_models.map(Number).filter(Number.isInteger))] : [];
      f.allowed_models = list.length ? JSON.stringify(list) : null;
    }
    if (partial && 'archived' in b) f.archived = v.bool(b.archived);
    return f;
  }

  r.get('/plans', async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM systems s WHERE s.plan_id = p.id AND s.archived_at IS NULL) AS systems_count
       FROM plans p ORDER BY p.archived, p.sort_order, p.price_usd`,
    );
    const models = await db.query(`SELECT id, alias, kind, enabled FROM models ORDER BY sort_order, alias`);
    res.json({ plans: rows, models: models.rows });
  });

  r.post('/plans', async (req, res) => {
    const f = planFields(req.body || {}, false);
    const keys = Object.keys(f);
    const { rows } = await db.query(
      `INSERT INTO plans (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => f[k]),
    );
    await logEvent(db, { actor: req.actor, type: 'plan_created', message: `إضافة باقة «${f.name}»` });
    res.status(201).json({ plan: rows[0] });
  });

  r.patch('/plans/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const q = updateQuery('plans', id, planFields(req.body || {}, true));
    if (!q) throw new HttpError(400, 'لا توجد تعديلات');
    const { rows } = await db.query(q.text, q.values);
    if (!rows[0]) throw new HttpError(404, 'الباقة غير موجودة');
    res.json({ plan: rows[0] });
  });

  r.delete('/plans/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM systems WHERE plan_id = $1 AND archived_at IS NULL', [id]);
    if (rows[0].n > 0) {
      await db.query('UPDATE plans SET archived = true WHERE id = $1', [id]);
      return res.json({ ok: true, archived: true, message: 'الباقة مستخدمة في أنظمة فعّالة، تم إخفاؤها بدلاً من حذفها' });
    }
    await db.query('DELETE FROM plans WHERE id = $1', [id]);
    res.json({ ok: true, deleted: true });
  });

  // ───────────── providers ─────────────
  const publicProvider = (p) => {
    const { api_key_enc, ...rest } = p;
    let key_error = null;
    if (api_key_enc) {
      try {
        cipher.decrypt(api_key_enc);
      } catch {
        key_error = 'تعذر فك تشفير المفتاح — أعد إدخاله';
      }
    }
    return { ...rest, has_key: !!api_key_enc, key_error };
  };

  async function testProvider(p, apiKey) {
    const provider = { ...p, apiKey };
    if (!apiKey) return { ok: false, message: 'لا يوجد مفتاح API' };
    const url = provider.kind === 'anthropic' ? providerUrl(provider, 'v1/models?limit=1000') : providerUrl(provider, 'models');
    try {
      const resp = await upstreamFetch(url, { headers: providerHeaders(provider), signal: AbortSignal.timeout(20_000) });
      const text = await resp.text();
      if (!resp.ok) {
        let msg = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          msg = j?.error?.message || j?.message || msg;
        } catch {}
        return { ok: false, status: resp.status, message: `${resp.status}: ${scrubSecrets(msg, [apiKey])}` };
      }
      let items = [];
      try {
        const j = JSON.parse(text);
        items = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
      } catch {}
      const models = items
        .map((m) => ({
          id: String(m.id || m.name || '').replace(/^models\//, ''),
          name: m.display_name || m.name || '',
          pricing:
            m.pricing && m.pricing.prompt != null
              ? { in: round(Number(m.pricing.prompt) * 1e6, 6), out: round(Number(m.pricing.completion || 0) * 1e6, 6) }
              : null,
        }))
        .filter((m) => m.id);
      return { ok: true, message: `الاتصال ناجح — ${models.length} موديل متاح`, models };
    } catch (e) {
      return { ok: false, message: e.detail || e.message };
    }
  }

  async function saveTest(id, t) {
    await db.query('UPDATE providers SET last_test_at = now(), last_test_ok = $2, last_test_message = $3 WHERE id = $1', [
      id,
      t.ok,
      String(t.message || '').slice(0, 300),
    ]);
  }

  /** Builds the import list: upstream models + matching reference prices + whether already added. */
  async function importList(provider, upstreamModels) {
    const own = MODEL_PRESETS[provider.preset] || [];
    const all = Object.values(MODEL_PRESETS).flat();
    const byNorm = new Map();
    for (const p of [...all, ...own]) byNorm.set(normalizeModelName(p.upstream), p);
    const { rows: existing } = await db.query('SELECT alias, upstream_model, provider_id FROM models');
    const taken = new Set(existing.filter((e) => e.provider_id === provider.id).map((e) => e.upstream_model));
    const aliases = new Set(existing.map((e) => e.alias));
    return upstreamModels.map((m) => {
      const preset = byNorm.get(normalizeModelName(m.id.split('/').pop()));
      const fields = preset ? { ...presetToModel(preset), alias: m.id, upstream_model: m.id } : null;
      return {
        id: m.id,
        name: m.name || preset?.label || '',
        kind: preset?.kind || guessModelKind(m.id),
        supported: !isUnsupportedModel(m.id),
        preset: fields,
        pricing: m.pricing,
        // Providers that publish prices in their model list (OpenRouter) pre-fill the import.
        suggested: !fields && m.pricing ? { input_price: m.pricing.in, output_price: m.pricing.out } : null,
        exists: taken.has(m.id),
        alias_taken: aliases.has(m.id),
      };
    });
  }

  r.get('/providers', async (req, res) => {
    const { rows } = await db.query(
      `SELECT p.*, (SELECT COUNT(*)::int FROM models m WHERE m.provider_id = p.id) AS models_count FROM providers p ORDER BY p.id`,
    );
    res.json({ providers: rows.map(publicProvider), presets: PROVIDER_PRESETS });
  });

  function providerFields(b, partial) {
    const f = {};
    if (!partial || 'preset' in b) {
      const preset = PROVIDER_PRESETS.find((p) => p.id === b.preset) || PROVIDER_PRESETS.find((p) => p.id === 'custom');
      f.preset = preset.id;
      f.kind = preset.id === 'custom' ? (b.kind === 'anthropic' ? 'anthropic' : 'openai') : preset.kind;
      if (!partial && !b.base_url) b.base_url = preset.base_url;
      if (!partial && !b.name) b.name = preset.name;
    }
    if (!partial || 'name' in b) f.name = v.str(b.name, { required: true, name: 'اسم المزوّد', max: 80 });
    if (!partial || 'base_url' in b) f.base_url = v.url(b.base_url, { required: true, name: 'رابط الـ API' });
    if ('enabled' in b) f.enabled = v.bool(b.enabled);
    if ('extra_headers' in b) {
      let h = b.extra_headers;
      if (typeof h === 'string') {
        h = h.trim();
        if (!h) h = null;
        else {
          try {
            h = JSON.parse(h);
          } catch {
            throw new HttpError(400, 'الهيدرز الإضافية يجب أن تكون JSON صالح');
          }
        }
      }
      if (h != null && (typeof h !== 'object' || Array.isArray(h))) throw new HttpError(400, 'الهيدرز الإضافية يجب أن تكون كائن JSON');
      f.extra_headers = h == null ? null : JSON.stringify(h);
    }
    const key = v.str(b.api_key, { max: 500 });
    if (key) {
      f.api_key_enc = cipher.encrypt(key);
      f.key_hint = maskTail(key, 4);
    } else if (!partial) {
      throw new HttpError(400, 'مفتاح API مطلوب');
    }
    return { f, key };
  }

  r.post('/providers', async (req, res) => {
    const { f, key } = providerFields(req.body || {}, false);
    const keys = Object.keys(f);
    const { rows } = await db.query(
      `INSERT INTO providers (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => f[k]),
    );
    catalog.invalidate();
    const test = await testProvider(rows[0], key);
    await saveTest(rows[0].id, test);
    await logEvent(db, { actor: req.actor, type: 'provider_created', message: `إضافة المزوّد «${f.name}»` });
    res.status(201).json({
      provider: publicProvider({ ...rows[0], last_test_ok: test.ok, last_test_message: test.message }),
      test: { ok: test.ok, message: test.message },
      import: test.ok ? await importList(rows[0], test.models) : [],
    });
  });

  r.patch('/providers/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const { f } = providerFields(req.body || {}, true);
    const q = updateQuery('providers', id, f);
    if (!q) throw new HttpError(400, 'لا توجد تعديلات');
    const { rows } = await db.query(q.text, q.values);
    if (!rows[0]) throw new HttpError(404, 'المزوّد غير موجود');
    catalog.invalidate();
    res.json({ provider: publicProvider(rows[0]) });
  });

  r.delete('/providers/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const { rows } = await db.query('DELETE FROM providers WHERE id = $1 RETURNING name', [id]);
    if (!rows[0]) throw new HttpError(404, 'المزوّد غير موجود');
    catalog.invalidate();
    await logEvent(db, { actor: req.actor, type: 'provider_deleted', message: `حذف المزوّد «${rows[0].name}» وموديلاته` });
    res.json({ ok: true });
  });

  r.post('/providers/:id/test', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const { rows } = await db.query('SELECT * FROM providers WHERE id = $1', [id]);
    if (!rows[0]) throw new HttpError(404, 'المزوّد غير موجود');
    let key = null;
    try {
      key = rows[0].api_key_enc ? cipher.decrypt(rows[0].api_key_enc) : null;
    } catch {
      const t = { ok: false, message: 'تعذر فك تشفير المفتاح — أعد إدخاله (هل تغيّر ENCRYPTION_KEY؟)' };
      await saveTest(id, t);
      return res.json({ test: t, import: [] });
    }
    const test = await testProvider(rows[0], key);
    await saveTest(id, test);
    res.json({ test: { ok: test.ok, message: test.message }, import: test.ok ? await importList(rows[0], test.models) : [] });
  });

  // ───────────── models ─────────────
  function modelFields(b, partial) {
    const f = {};
    if (!partial || 'alias' in b) {
      f.alias = v.str(b.alias, { required: true, name: 'اسم الموديل', max: 120 });
      if (!ALIAS_RE.test(f.alias)) throw new HttpError(400, 'اسم الموديل يجب أن يكون بحروف إنجليزية وأرقام و - . _ / : فقط');
    }
    if (!partial || 'upstream_model' in b) f.upstream_model = v.str(b.upstream_model, { required: true, name: 'معرّف الموديل لدى المزوّد', max: 200 });
    if (!partial || 'provider_id' in b) f.provider_id = v.int(b.provider_id, { allowNull: false, name: 'المزوّد' });
    if (!partial || 'kind' in b) {
      const k = b.kind || 'chat';
      if (!['chat', 'embedding', 'image'].includes(k)) throw new HttpError(400, 'نوع الموديل غير صالح');
      f.kind = k;
    }
    for (const k of ['input_price', 'output_price', 'request_price']) {
      if (!partial || k in b) f[k] = v.money(b[k] ?? 0, { name: 'السعر' });
    }
    for (const k of ['cached_input_price', 'cache_write_price', 'long_input_price', 'long_output_price']) {
      if (!partial || k in b) f[k] = v.money(b[k], { allowNull: true, name: 'السعر' });
    }
    for (const k of ['long_context_threshold', 'default_max_tokens']) {
      if (!partial || k in b) f[k] = v.int(b[k], { min: 1, name: 'الرقم' });
    }
    if (!partial || 'fallback_model_id' in b) f.fallback_model_id = b.fallback_model_id ? v.int(b.fallback_model_id) : null;
    if (!partial || 'enabled' in b) f.enabled = b.enabled === undefined ? true : v.bool(b.enabled);
    if (!partial || 'notes' in b) f.notes = v.str(b.notes, { max: 500 });
    if (!partial || 'sort_order' in b) f.sort_order = v.int(b.sort_order ?? 0, { min: -1000, max: 100000, allowNull: false });
    return f;
  }

  r.get('/models', async (req, res) => {
    const { rows } = await db.query(
      `SELECT m.*, p.name AS provider_name, p.preset AS provider_preset, p.kind AS provider_kind, p.enabled AS provider_enabled,
              fb.alias AS fallback_alias
       FROM models m JOIN providers p ON p.id = m.provider_id LEFT JOIN models fb ON fb.id = m.fallback_model_id
       ORDER BY m.sort_order, m.alias`,
    );
    const providers = await db.query('SELECT id, name, preset, kind, enabled FROM providers ORDER BY id');
    res.json({ models: rows, providers: providers.rows, presets: MODEL_PRESETS, prices_checked_at: PRICES_CHECKED_AT });
  });

  async function assertAliasFree(alias, exceptId = 0) {
    const { rows } = await db.query('SELECT id FROM models WHERE alias = $1 AND id <> $2', [alias, exceptId]);
    if (rows[0]) throw new HttpError(400, `يوجد موديل بنفس الاسم «${alias}»`);
  }

  r.post('/models', async (req, res) => {
    const f = modelFields(req.body || {}, false);
    await assertAliasFree(f.alias);
    const keys = Object.keys(f);
    const { rows } = await db.query(
      `INSERT INTO models (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => f[k]),
    );
    catalog.invalidate();
    res.status(201).json({ model: rows[0] });
  });

  r.post('/models/bulk', async (req, res) => {
    const providerId = v.int(req.body?.provider_id, { allowNull: false, name: 'المزوّد' });
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 300) : [];
    const { rows: existing } = await db.query('SELECT alias FROM models');
    const taken = new Set(existing.map((e) => e.alias));
    const added = [];
    const skipped = [];
    for (const it of items) {
      const f = modelFields({ ...it, provider_id: providerId }, false);
      if (taken.has(f.alias)) {
        skipped.push(f.alias);
        continue;
      }
      const keys = Object.keys(f);
      await db.query(
        `INSERT INTO models (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        keys.map((k) => f[k]),
      );
      taken.add(f.alias);
      added.push(f.alias);
    }
    catalog.invalidate();
    if (added.length) await logEvent(db, { actor: req.actor, type: 'models_added', message: `إضافة ${added.length} موديل` });
    res.json({ added, skipped });
  });

  r.patch('/models/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const f = modelFields(req.body || {}, true);
    if (f.alias) await assertAliasFree(f.alias, id);
    if (f.fallback_model_id === id) throw new HttpError(400, 'لا يمكن أن يكون الموديل بديلاً لنفسه');
    const q = updateQuery('models', id, f);
    if (!q) throw new HttpError(400, 'لا توجد تعديلات');
    const { rows } = await db.query(q.text, q.values);
    if (!rows[0]) throw new HttpError(404, 'الموديل غير موجود');
    catalog.invalidate();
    res.json({ model: rows[0] });
  });

  r.delete('/models/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    await db.query('DELETE FROM models WHERE id = $1', [id]);
    catalog.invalidate();
    res.json({ ok: true });
  });

  // ───────────── logs ─────────────
  r.get('/logs', async (req, res) => {
    const s = await settings.all();
    const q = req.query;
    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (q.system_id) add('l.system_id = ?', v.int(q.system_id, { allowNull: false }));
    if (q.model) add('l.model_alias ILIKE ?', `%${v.str(q.model, { max: 100 })}%`);
    if (q.status === 'error') where.push('l.status >= 400');
    else if (q.status === 'ok') where.push('l.status < 400');
    let tzParam = null;
    const tz = () => {
      if (!tzParam) {
        params.push(s.timezone);
        tzParam = `$${params.length}`;
      }
      return tzParam;
    };
    if (q.from) {
      const d = v.ymd(q.from);
      add(`l.created_at >= (?::date::timestamp AT TIME ZONE ${tz()})`, d);
    }
    if (q.to) {
      const d = v.ymd(q.to);
      add(`l.created_at < ((?::date + 1)::timestamp AT TIME ZONE ${tz()})`, d);
    }
    if (q.before) add('l.id < ?', v.int(q.before, { allowNull: false }));
    const limit = Math.min(200, Math.max(10, Number(q.limit) || 50));
    const { rows } = await db.query(
      `SELECT l.*, s.name AS system_name FROM usage_logs l LEFT JOIN systems s ON s.id = l.system_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ${limit}`,
      params,
    );
    res.json({ logs: rows, next_before: rows.length === limit ? rows.at(-1).id : null });
  });

  // ───────────── payments & finance ─────────────
  async function monthBounds(month, tz) {
    const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? `${month}-01` : null;
    const { rows } = await db.query(
      `WITH b AS (SELECT COALESCE($1::date, date_trunc('month', now() AT TIME ZONE $2)::date) AS d0)
       SELECT d0, (d0 + interval '1 month')::date AS d1, (d0::timestamp AT TIME ZONE $2) AS t0,
              ((d0 + interval '1 month')::timestamp AT TIME ZONE $2) AS t1, to_char(d0, 'YYYY-MM') AS month FROM b`,
      [m, tz],
    );
    return rows[0];
  }

  r.get('/payments', async (req, res) => {
    const s = await settings.all();
    const b = await monthBounds(req.query.month, s.timezone);
    const params = [b.t0, b.t1];
    let extra = '';
    if (req.query.system_id) {
      params.push(v.int(req.query.system_id, { allowNull: false }));
      extra = ` AND system_id = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT * FROM payments WHERE paid_at >= $1 AND paid_at < $2${extra} ORDER BY paid_at DESC, id DESC`,
      params,
    );
    res.json({ month: b.month, payments: rows, total: round(rows.reduce((a, p) => a + num(p.amount_usd), 0), 2) });
  });

  r.post('/payments', async (req, res) => {
    const b = req.body || {};
    const sysId = v.int(b.system_id, { allowNull: false, name: 'النظام' });
    const sys = await loadSystem(sysId);
    const kind = ['subscription', 'topup', 'upgrade', 'other'].includes(b.kind) ? b.kind : 'other';
    const p = await insertPayment(db, sys, b, kind, req.actor);
    if (!p) throw new HttpError(400, 'المبلغ مطلوب');
    await logEvent(db, { system_id: sysId, actor: req.actor, type: 'payment', message: `تسجيل دفعة $${num(p.amount_usd).toFixed(2)}` });
    res.status(201).json({ payment: p });
  });

  r.delete('/payments/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    const { rows } = await db.query('DELETE FROM payments WHERE id = $1 RETURNING *', [id]);
    if (!rows[0]) throw new HttpError(404, 'الدفعة غير موجودة');
    await logEvent(db, {
      system_id: rows[0].system_id,
      actor: req.actor,
      type: 'payment_deleted',
      message: `حذف دفعة $${num(rows[0].amount_usd).toFixed(2)}`,
    });
    res.json({ ok: true });
  });

  r.get('/finance', async (req, res) => {
    const s = await settings.all();
    const b = await monthBounds(req.query.month, s.timezone);
    const [systems, unattributed, history] = await Promise.all([
      db.query(
        `SELECT s.id, s.name, s.archived_at, s.status, p.name AS plan_name, p.price_usd AS plan_price,
                COALESCE(pay.revenue, 0)::float8 AS revenue, COALESCE(u.cost, 0)::float8 AS cost, COALESCE(u.requests, 0)::int AS requests
         FROM systems s
         LEFT JOIN plans p ON p.id = s.plan_id
         LEFT JOIN (SELECT system_id, SUM(amount_usd) AS revenue FROM payments WHERE paid_at >= $1 AND paid_at < $2 GROUP BY system_id) pay
           ON pay.system_id = s.id
         LEFT JOIN (SELECT system_id, SUM(cost_usd) AS cost, SUM(requests) AS requests FROM usage_daily
                    WHERE day >= $3 AND day < $4 GROUP BY system_id) u ON u.system_id = s.id
         WHERE s.archived_at IS NULL OR COALESCE(pay.revenue, 0) > 0 OR COALESCE(u.cost, 0) > 0
         ORDER BY COALESCE(pay.revenue, 0) DESC, COALESCE(u.cost, 0) DESC`,
        [b.t0, b.t1, b.d0, b.d1],
      ),
      db.query(
        `SELECT COALESCE(SUM(amount_usd), 0)::float8 AS v FROM payments WHERE system_id IS NULL AND paid_at >= $1 AND paid_at < $2`,
        [b.t0, b.t1],
      ),
      db.query(
        `WITH months AS (
           SELECT generate_series($1::date - interval '5 months', $1::date, interval '1 month')::date AS m
         )
         SELECT to_char(m, 'YYYY-MM') AS month,
           COALESCE((SELECT SUM(amount_usd) FROM payments
                     WHERE paid_at >= (m::timestamp AT TIME ZONE $2) AND paid_at < ((m + interval '1 month')::timestamp AT TIME ZONE $2)), 0)::float8 AS revenue,
           COALESCE((SELECT SUM(cost_usd) FROM usage_daily WHERE day >= m AND day < (m + interval '1 month')::date), 0)::float8 AS cost
         FROM months ORDER BY m`,
        [b.d0, s.timezone],
      ),
    ]);
    const rows = systems.rows.map((x) => ({ ...x, profit: round(x.revenue - x.cost, 6) }));
    const revenue = round(rows.reduce((a, x) => a + x.revenue, 0) + unattributed.rows[0].v, 6);
    const cost = round(rows.reduce((a, x) => a + x.cost, 0), 6);
    res.json({
      month: b.month,
      totals: { revenue, cost, profit: round(revenue - cost, 6), margin: revenue > 0 ? round(((revenue - cost) / revenue) * 100, 1) : null },
      unattributed_revenue: unattributed.rows[0].v,
      systems: rows,
      history: history.rows.map((h) => ({ ...h, profit: round(h.revenue - h.cost, 6) })),
    });
  });

  // ───────────── settings & admins ─────────────
  r.get('/settings', async (req, res) => {
    const s = await settings.all();
    const { rows: admins } = await db.query('SELECT id, email, name, created_at, last_login_at FROM admins ORDER BY id');
    res.json({
      settings: { ...s, telegram_bot_token: '', telegram_bot_token_set: !!s.telegram_bot_token },
      admins,
      me: req.admin,
      detected_url: `${req.protocol}://${req.get('host')}`,
    });
  });

  r.put('/settings', async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if ('brand_name' in b) patch.brand_name = v.str(b.brand_name, { required: true, name: 'اسم المنصة', max: 60 });
    if ('support_contact' in b) patch.support_contact = v.str(b.support_contact, { max: 200 });
    if ('timezone' in b) {
      const tz = v.str(b.timezone, { required: true, name: 'المنطقة الزمنية', max: 60 });
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
      } catch {
        throw new HttpError(400, 'المنطقة الزمنية غير صالحة (مثال: Africa/Cairo)');
      }
      patch.timezone = tz;
    }
    if ('public_url' in b) patch.public_url = v.url(b.public_url, { name: 'رابط المنصة' });
    if ('alert_webhook_url' in b) patch.alert_webhook_url = v.url(b.alert_webhook_url, { name: 'رابط الـ Webhook' });
    if ('telegram_chat_id' in b) patch.telegram_chat_id = v.str(b.telegram_chat_id, { max: 60 });
    if (v.str(b.telegram_bot_token, { max: 200 })) patch.telegram_bot_token = v.str(b.telegram_bot_token, { max: 200 });
    if (v.bool(b.clear_telegram_bot_token)) patch.telegram_bot_token = '';
    if ('warn_threshold' in b) patch.warn_threshold = v.int(b.warn_threshold, { min: 10, max: 99, allowNull: false, name: 'نسبة التنبيه' });
    if ('portal_show_cost' in b) patch.portal_show_cost = v.bool(b.portal_show_cost);
    if ('log_retention_days' in b) {
      patch.log_retention_days = v.int(b.log_retention_days, { min: 7, max: 3650, allowNull: false, name: 'مدة حفظ السجل' });
    }
    await settings.update(patch);
    await logEvent(db, { actor: req.actor, type: 'settings_updated', message: 'تحديث الإعدادات' });
    const s = await settings.all();
    res.json({ settings: { ...s, telegram_bot_token: '', telegram_bot_token_set: !!s.telegram_bot_token } });
  });

  r.post('/settings/test-alert', async (req, res) => {
    const result = await alerts.send('✅ رسالة تجربة من لوحة التحكم — التنبيهات شغالة.', { event: 'test' });
    if (!result.sent) throw new HttpError(400, 'لا توجد قناة تنبيهات مفعّلة — أضف بيانات تيليجرام أو رابط Webhook واحفظ أولاً');
    if (result.failed) throw new HttpError(502, 'فشل الإرسال — راجع التوكن ورقم المحادثة');
    res.json({ ok: true });
  });

  r.post('/admins', async (req, res) => {
    const email = v.str(req.body?.email, { required: true, name: 'البريد', max: 200 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'البريد غير صالح');
    const password = String(req.body?.password || '');
    if (password.length < 8) throw new HttpError(400, 'كلمة المرور 8 أحرف على الأقل');
    const exists = await db.query('SELECT id FROM admins WHERE email = $1', [email]);
    if (exists.rows[0]) throw new HttpError(400, 'يوجد مدير بنفس البريد');
    const { rows } = await db.query(
      'INSERT INTO admins (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email, v.str(req.body?.name, { max: 80 }), await hashPassword(password)],
    );
    await logEvent(db, { actor: req.actor, type: 'admin_created', message: `إضافة مدير ${email}` });
    res.status(201).json({ admin: rows[0] });
  });

  r.delete('/admins/:id', async (req, res) => {
    const id = v.int(req.params.id, { allowNull: false });
    if (id === req.admin.id) throw new HttpError(400, 'لا يمكنك حذف حسابك');
    const { rows } = await db.query('DELETE FROM admins WHERE id = $1 RETURNING email', [id]);
    if (!rows[0]) throw new HttpError(404, 'المدير غير موجود');
    await logEvent(db, { actor: req.actor, type: 'admin_deleted', message: `حذف المدير ${rows[0].email}` });
    res.json({ ok: true });
  });

  r.post('/admins/me/password', async (req, res) => {
    const { rows } = await db.query('SELECT * FROM admins WHERE id = $1', [req.admin.id]);
    if (!(await verifyPassword(String(req.body?.current || ''), rows[0].password_hash))) {
      throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة');
    }
    const next = String(req.body?.password || '');
    if (next.length < 8) throw new HttpError(400, 'كلمة المرور الجديدة 8 أحرف على الأقل');
    const { rows: [a] } = await db.query(
      'UPDATE admins SET password_hash = $2, session_version = session_version + 1 WHERE id = $1 RETURNING *',
      [req.admin.id, await hashPassword(next)],
    );
    setSession(req, res, a);
    res.json({ ok: true });
  });

  r.use((req, res) => res.status(404).json({ error: 'غير موجود' }));

  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON غير صالح' });
    log.error('[admin]', err);
    res.status(500).json({ error: 'خطأ داخلي في الخادم' });
  });

  return r;
}
