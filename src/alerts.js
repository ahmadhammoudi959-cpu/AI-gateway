import { logEvent } from './events.js';
import { num, round } from './util.js';

const fmt = (n) => '$' + num(n).toFixed(2);

async function postJson(url, body, timeoutMs = 10_000) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

/** Admin notifications (Telegram + optional webhook) and per-system webhooks. Never throws. */
export function createAlerts({ cfg, settings, db, log }) {
  const lastProviderAlert = new Map();

  async function send(text, payload = {}) {
    const s = await settings.all();
    const jobs = [];
    if (s.telegram_bot_token && s.telegram_chat_id) {
      jobs.push(
        postJson(`${cfg.telegramApiBase}/bot${s.telegram_bot_token}/sendMessage`, {
          chat_id: s.telegram_chat_id,
          text: `${s.brand_name}\n${text}`,
          disable_web_page_preview: true,
        }),
      );
    }
    if (s.alert_webhook_url) jobs.push(postJson(s.alert_webhook_url, { text, brand: s.brand_name, ...payload }));
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === 'rejected') log.warn('[alerts] delivery failed:', r.reason?.message);
    return { sent: jobs.length, failed: results.filter((r) => r.status === 'rejected').length };
  }

  function systemWebhook(sys, payload) {
    if (!sys.webhook_url) return;
    postJson(sys.webhook_url, { system: { id: sys.id, name: sys.name }, ...payload }).catch((e) =>
      log.warn(`[alerts] webhook of system #${sys.id} failed:`, e.message),
    );
  }

  return {
    send,
    systemWebhook,

    /** Fires once per period when usage crosses the warning threshold and again at 100%. */
    async checkThresholds(sys, spend, limit) {
      if (!(limit > 0) || spend == null) return;
      const pct = (spend / limit) * 100;
      const warn = num((await settings.all()).warn_threshold, 80);
      const level = pct >= 100 ? 100 : pct >= warn ? Math.round(warn) : 0;
      if (!level || level <= num(sys.alert_level)) return;
      const { rows } = await db.query(
        'UPDATE systems SET alert_level = $2 WHERE id = $1 AND alert_level < $2 RETURNING id',
        [sys.id, level],
      );
      if (!rows.length) return;
      const end = new Date(sys.period_end).toISOString().slice(0, 10);
      const text =
        level >= 100
          ? `⛔ «${sys.name}» وصل للحد الشهري (${fmt(limit)}). طلبات الذكاء الاصطناعي متوقفة حتى ترقية الباقة أو شحن رصيد.`
          : `⚠️ «${sys.name}» استهلك \u2066${Math.round(pct)}%\u2069 من حده الشهري (${fmt(spend)} من ${fmt(limit)}). الدورة تنتهي ${end}.`;
      await logEvent(db, {
        system_id: sys.id,
        type: level >= 100 ? 'limit_reached' : 'limit_warning',
        message: text,
        data: { pct: round(pct, 1), spend: round(spend, 4), limit },
      });
      send(text, { event: level >= 100 ? 'limit_reached' : 'limit_warning', system_id: sys.id, percent: round(pct, 1) }).catch(
        () => {},
      );
      systemWebhook(sys, { event: 'usage.threshold', threshold: level, percent: round(pct, 1), period_end: sys.period_end });
    },

    /** The provider rejected our key — tell the admin, at most every 30 minutes per provider. */
    async providerAuthFailed(provider, err) {
      if (!provider) return;
      const last = lastProviderAlert.get(provider.id) || 0;
      if (Date.now() - last < 30 * 60 * 1000) return;
      lastProviderAlert.set(provider.id, Date.now());
      const text = `🔑 المزوّد «${provider.name}» رفض مفتاح API (${err?.upstreamStatus || 'auth'}). راجع المفتاح من صفحة المزوّدين.`;
      await logEvent(db, { type: 'provider_auth_failed', message: text, data: { provider_id: provider.id } });
      await send(text, { event: 'provider_auth_failed', provider_id: provider.id });
    },
  };
}
