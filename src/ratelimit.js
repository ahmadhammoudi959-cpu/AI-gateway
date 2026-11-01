/** Fixed-window counters kept in memory (one instance). Good enough for per-plan RPM and login throttling. */
export function createRateLimiter() {
  const windows = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, w] of windows) if (now - w.start > w.ms * 2) windows.delete(k);
  }, 60_000);
  timer.unref();

  return {
    hit(key, limit, ms = 60_000) {
      if (!limit || limit <= 0) return { ok: true };
      const now = Date.now();
      let w = windows.get(key);
      if (!w || now - w.start >= ms) {
        w = { start: now, count: 0, ms };
        windows.set(key, w);
      }
      if (w.count >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + ms - now) / 1000)) };
      w.count++;
      return { ok: true, remaining: limit - w.count };
    },
    reset(key) {
      windows.delete(key);
    },
  };
}
