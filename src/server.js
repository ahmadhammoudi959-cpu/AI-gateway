import { loadConfig, resolveSecrets } from './config.js';
import { openDb } from './db.js';
import { createApp, bootstrapAdmin } from './app.js';

const cfg = loadConfig();
resolveSecrets(cfg);
const db = await openDb(cfg);
await bootstrapAdmin({ cfg, db });
const { app, jobs } = await createApp({ cfg, db });

const stopJobs = cfg.disableJobs ? () => {} : jobs.start(cfg.jobsIntervalMs);
const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`[server] AI gateway listening on http://${cfg.host}:${cfg.port}  (dashboard: /admin, API: /v1)`);
});
// Long AI responses: keep connections open and let streams finish.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, finishing in-flight requests…`);
  stopJobs();
  const force = setTimeout(() => process.exit(0), 25_000);
  force.unref();
  server.close(async () => {
    await db.close().catch(() => {});
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
