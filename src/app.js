import path from 'node:path';
import express from 'express';
import { ROOT } from './config.js';
import { makeCipher, hashPassword, randomBase62 } from './util.js';
import { createSettings } from './settings.js';
import { createCatalog } from './catalog.js';
import { createAlerts } from './alerts.js';
import { createRateLimiter } from './ratelimit.js';
import { createJobs } from './jobs.js';
import { configureUpstream } from './proxy/upstream.js';
import { createProxyRouter } from './proxy/router.js';
import { createAdminRouter } from './admin/router.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const quietLog = { info() {}, warn() {}, error: console.error.bind(console) };

/** Builds the Express app. Used by server.js and by the tests. */
export async function createApp({ cfg, db, log = console }) {
  if (cfg.quiet) log = quietLog;
  configureUpstream(cfg);
  const cipher = makeCipher(cfg.encryptionKey);
  const settings = createSettings({ db, cipher, cfg });
  const catalog = createCatalog({ db, cipher, log });
  const alerts = createAlerts({ cfg, settings, db, log });
  const rl = createRateLimiter();
  const jobs = createJobs({ db, settings, alerts, log });
  const deps = { cfg, db, cipher, settings, catalog, alerts, rl, log };

  const app = express();
  app.disable('x-powered-by');
  const tp = cfg.trustProxy;
  app.set('trust proxy', /^\d+$/.test(String(tp)) ? Number(tp) : tp === 'true' ? true : tp);

  app.get('/healthz', async (req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, db: db.kind });
    } catch (e) {
      res.status(503).json({ ok: false, error: e.message });
    }
  });

  // AI traffic from the connected apps (OpenAI- and Anthropic-compatible).
  app.use('/v1', createProxyRouter(deps));

  // Dashboard API.
  app.use('/api', createAdminRouter(deps));

  // Static files: dashboard, client portal and vendored libraries (no CDN at runtime).
  const nm = (p) => path.join(ROOT, 'node_modules', p);
  const vendorOpts = { maxAge: '7d', fallthrough: false };
  app.use('/vendor/htm', express.static(nm('htm'), vendorOpts));
  app.use('/vendor/fonts/plex-arabic', express.static(nm('@fontsource/ibm-plex-sans-arabic'), vendorOpts));
  app.use('/vendor/fonts/plex-mono', express.static(nm('@fontsource/ibm-plex-mono'), vendorOpts));
  app.use(
    '/assets',
    express.static(path.join(ROOT, 'public'), {
      fallthrough: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );

  const page = (file) => (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(ROOT, 'public', file));
  };
  app.get('/', (req, res) => res.redirect(302, '/admin'));
  app.get('/admin', page('index.html'));
  app.get('/portal', page('portal.html'));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/assets/favicon.svg'));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.status === 404 || err?.statusCode === 404) return res.status(404).json({ error: 'Not found' });
    log.error('[app]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  });

  return { app, deps, jobs };
}

/** Creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD (or a random dev password). */
export async function bootstrapAdmin({ cfg, db, log = console }) {
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM admins');
  if (rows[0].n > 0) return null;
  let email = cfg.adminEmail;
  let password = cfg.adminPassword;
  let generated = false;
  if (!email || !password) {
    if (cfg.isProd) {
      log.error('[setup] No admin account yet: set ADMIN_EMAIL and ADMIN_PASSWORD and restart.');
      return null;
    }
    email = email || 'admin@local';
    password = randomBase62(14);
    generated = true;
  }
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters');
  await db.query('INSERT INTO admins (email, name, password_hash) VALUES ($1, $2, $3)', [
    email.toLowerCase(),
    'المدير',
    await hashPassword(password),
  ]);
  if (generated) {
    log.warn(`\n[setup] Admin account created →  email: ${email}   password: ${password}\n`);
  } else {
    log.info(`[setup] Admin account created for ${email}`);
  }
  return { email, generated };
}
