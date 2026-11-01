import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, d = false) =>
  v == null || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const rawDataDir = env.DATA_DIR || 'data';
  return {
    isProd,
    port: Number(env.PORT || 3000),
    host: env.HOST || '0.0.0.0',
    // Postgres in production. Leave empty to use the embedded database (PGlite) stored in DATA_DIR.
    databaseUrl: env.DATABASE_URL || '',
    databaseSsl: env.DATABASE_SSL,
    dataDir: rawDataDir === 'memory://' ? 'memory://' : path.resolve(ROOT, rawDataDir),
    encryptionKey: env.ENCRYPTION_KEY || '',
    sessionSecret: env.SESSION_SECRET || '',
    adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || '',
    // Render sets RENDER_EXTERNAL_URL automatically; PUBLIC_URL (or the dashboard setting) wins for custom domains.
    publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY ?? '1',
    defaultTimezone: env.DEFAULT_TIMEZONE || 'Africa/Cairo',
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 10 * 60 * 1000),
    bodyLimit: env.BODY_LIMIT || '25mb',
    telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    corsOrigins: env.CORS_ORIGINS || '*',
    // Hourly is enough (renewals also happen on each request) and lets serverless databases sleep.
    jobsIntervalMs: Number(env.JOBS_INTERVAL_MS || 60 * 60 * 1000),
    allowEmbeddedDb: bool(env.ALLOW_EMBEDDED_DB),
    disableJobs: bool(env.DISABLE_JOBS),
    quiet: bool(env.QUIET),
  };
}

/**
 * ENCRYPTION_KEY protects the providers' API keys stored in the database, SESSION_SECRET signs
 * admin sessions. Production must set both. In development they are generated once and kept in
 * DATA_DIR/.secrets.json so restarts keep working.
 */
export function resolveSecrets(cfg, log = console) {
  const missing = [];
  if (!cfg.encryptionKey) missing.push('ENCRYPTION_KEY');
  if (!cfg.sessionSecret) missing.push('SESSION_SECRET');
  if (!missing.length) return;
  if (cfg.isProd) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (cfg.dataDir === 'memory://') {
    cfg.encryptionKey ||= crypto.randomBytes(32).toString('base64url');
    cfg.sessionSecret ||= crypto.randomBytes(32).toString('base64url');
    return;
  }
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, '.secrets.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  saved.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString('base64url');
  saved.SESSION_SECRET ||= crypto.randomBytes(32).toString('base64url');
  cfg.encryptionKey ||= saved.ENCRYPTION_KEY;
  cfg.sessionSecret ||= saved.SESSION_SECRET;
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  log.warn(`[config] development secrets in ${file} — set ENCRYPTION_KEY and SESSION_SECRET in production`);
}
