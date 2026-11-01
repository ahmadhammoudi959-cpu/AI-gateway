import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// Postgres type OIDs we parse into plain JS values (identical for pg and PGlite).
const NUMERIC = 1700;
const INT8 = 20;
const DATE = 1082;

/**
 * Schema is idempotent (IF NOT EXISTS). Later changes go into MIGRATIONS with an increasing version.
 * Money is NUMERIC in USD; tokens are integers.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  session_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS providers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  preset TEXT NOT NULL DEFAULT 'custom',
  kind TEXT NOT NULL CHECK (kind IN ('openai', 'anthropic')),
  base_url TEXT NOT NULL,
  api_key_enc TEXT,
  key_hint TEXT NOT NULL DEFAULT '',
  extra_headers JSONB,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_test_at TIMESTAMPTZ,
  last_test_ok BOOLEAN,
  last_test_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS models (
  id SERIAL PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  provider_id INT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'embedding', 'image')),
  input_price NUMERIC(14,6) NOT NULL DEFAULT 0,
  output_price NUMERIC(14,6) NOT NULL DEFAULT 0,
  cached_input_price NUMERIC(14,6),
  cache_write_price NUMERIC(14,6),
  request_price NUMERIC(14,6) NOT NULL DEFAULT 0,
  long_context_threshold INT,
  long_input_price NUMERIC(14,6),
  long_output_price NUMERIC(14,6),
  default_max_tokens INT,
  fallback_model_id INT REFERENCES models(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price_usd NUMERIC(12,2) NOT NULL DEFAULT 0,
  monthly_limit_usd NUMERIC(14,4) NOT NULL,
  rpm_limit INT,
  allowed_models JSONB,
  description TEXT NOT NULL DEFAULT '',
  is_public BOOLEAN NOT NULL DEFAULT true,
  archived BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS systems (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  plan_id INT REFERENCES plans(id) ON DELETE SET NULL,
  limit_override_usd NUMERIC(14,4),
  extra_credit_usd NUMERIC(14,4) NOT NULL DEFAULT 0,
  period_spend_usd NUMERIC(16,8) NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  billing_anchor TIMESTAMPTZ NOT NULL,
  auto_renew BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  alert_level INT NOT NULL DEFAULT 0,
  expiry_notice_for TIMESTAMPTZ,
  expired_notice_for TIMESTAMPTZ,
  webhook_url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  system_id INT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'default',
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  key_last4 TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_system ON api_keys (system_id);

CREATE TABLE IF NOT EXISTS usage_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id TEXT NOT NULL DEFAULT '',
  system_id INT NOT NULL,
  api_key_id INT,
  model_id INT,
  model_alias TEXT NOT NULL DEFAULT '',
  provider_id INT,
  endpoint TEXT NOT NULL,
  stream BOOLEAN NOT NULL DEFAULT false,
  status INT NOT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  cached_tokens INT NOT NULL DEFAULT 0,
  cache_write_tokens INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(16,8) NOT NULL DEFAULT 0,
  latency_ms INT,
  estimated BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  note TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS usage_logs_sys_time ON usage_logs (system_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_logs_time ON usage_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS usage_daily (
  day DATE NOT NULL,
  system_id INT NOT NULL,
  model_id INT NOT NULL DEFAULT 0,
  model_alias TEXT NOT NULL DEFAULT '',
  provider_id INT,
  requests INT NOT NULL DEFAULT 0,
  errors INT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cached_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(16,8) NOT NULL DEFAULT 0,
  PRIMARY KEY (day, system_id, model_id)
);
CREATE INDEX IF NOT EXISTS usage_daily_sys ON usage_daily (system_id, day);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  system_id INT REFERENCES systems(id) ON DELETE SET NULL,
  system_name TEXT NOT NULL DEFAULT '',
  amount_usd NUMERIC(12,2) NOT NULL,
  kind TEXT NOT NULL DEFAULT 'subscription',
  method TEXT NOT NULL DEFAULT '',
  credit_usd NUMERIC(14,4),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_time ON payments (paid_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  system_id INT,
  actor TEXT NOT NULL DEFAULT 'system',
  type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  data JSONB
);
CREATE INDEX IF NOT EXISTS events_sys ON events (system_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_time ON events (created_at DESC);
`;

// Future schema changes: { version: 2, sql: 'ALTER TABLE ...' }
const MIGRATIONS = [];

async function migrate(db) {
  await db.exec(SCHEMA);
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'schema_version'`);
  let version = rows[0] ? Number(rows[0].value) : 1;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    await db.exec(m.sql);
    version = m.version;
  }
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('schema_version', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(version)],
  );
}

export async function openDb(cfg, log = console) {
  let db;
  if (cfg.databaseUrl) {
    pg.types.setTypeParser(NUMERIC, (v) => (v === null ? null : parseFloat(v)));
    pg.types.setTypeParser(INT8, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(DATE, (v) => v);
    let connectionString = cfg.databaseUrl;
    const wantSsl =
      cfg.databaseSsl != null && cfg.databaseSsl !== ''
        ? ['1', 'true', 'yes', 'require'].includes(String(cfg.databaseSsl).toLowerCase())
        : /[?&]sslmode=(require|prefer|verify-ca|verify-full)/i.test(connectionString);
    let ssl;
    if (wantSsl) {
      ssl = { rejectUnauthorized: false };
      connectionString = connectionString.replace(/([?&])sslmode=[^&]*(&|$)/i, '$1').replace(/[?&]$/, '');
    }
    const pool = new pg.Pool({ connectionString, ssl, max: Number(process.env.PG_POOL_MAX || 10) });
    pool.on('error', (e) => log.error('[db] idle client error:', e.message));
    db = {
      kind: 'postgres',
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: (t, p) => client.query(t, p) });
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    let dir = cfg.dataDir;
    if (dir !== 'memory://') {
      dir = path.join(cfg.dataDir, 'pglite');
      fs.mkdirSync(dir, { recursive: true });
    }
    const lite = await PGlite.create(dir, {
      parsers: { [NUMERIC]: (v) => parseFloat(v), [INT8]: (v) => Number(v), [DATE]: (v) => v },
    });
    db = {
      kind: 'pglite',
      query: (text, params) => lite.query(text, params),
      exec: (text) => lite.exec(text),
      tx: (fn) => lite.transaction((t) => fn({ query: (q, p) => t.query(q, p) })),
      close: () => lite.close(),
    };
    if (!cfg.quiet) log.info(`[db] embedded database (PGlite) at ${dir}`);
    if (cfg.isProd) {
      log.warn('[db] NODE_ENV=production without DATABASE_URL: data lives in DATA_DIR — make sure it is on a persistent disk.');
    }
  }
  await migrate(db);
  return db;
}
