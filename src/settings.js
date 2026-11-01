// Runtime settings editable from the dashboard (stored in the `settings` table).
const SECRET_KEYS = new Set(['telegram_bot_token']);

export function createSettings({ db, cipher, cfg }) {
  const DEFAULTS = {
    brand_name: 'بوابة الذكاء',
    support_contact: '', // WhatsApp number or link shown to clients when they hit their limit
    timezone: cfg.defaultTimezone, // used for monthly reports and daily charts
    public_url: '', // overrides the auto-detected URL in integration snippets
    telegram_bot_token: '',
    telegram_chat_id: '',
    alert_webhook_url: '',
    warn_threshold: 80, // % of the monthly limit that triggers a warning alert
    portal_show_cost: false, // show dollar amounts (cost basis) in the client portal
    log_retention_days: 90,
  };
  let cache = null;
  let loadedAt = 0;

  async function load() {
    const { rows } = await db.query(`SELECT key, value FROM settings WHERE key <> 'schema_version'`);
    const s = { ...DEFAULTS };
    for (const r of rows) {
      if (!(r.key in DEFAULTS)) continue;
      let v = r.value;
      if (SECRET_KEYS.has(r.key) && typeof v === 'string' && v) {
        try {
          v = cipher.decrypt(v);
        } catch {
          v = '';
        }
      }
      s[r.key] = v;
    }
    cache = s;
    loadedAt = Date.now();
    return s;
  }

  return {
    DEFAULTS,
    isSecret: (k) => SECRET_KEYS.has(k),
    async all() {
      if (!cache || Date.now() - loadedAt > 30_000) await load();
      return cache;
    },
    async update(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULTS)) continue;
        const stored = SECRET_KEYS.has(k) && v ? cipher.encrypt(v) : v;
        await db.query(
          `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [k, JSON.stringify(stored)],
        );
      }
      cache = null;
      return this.all();
    },
    invalidate() {
      cache = null;
    },
  };
}
