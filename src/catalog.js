// In-memory view of providers + models (with decrypted provider keys). Invalidated on every admin change.

/** "claude-sonnet-4-5-20250929" → "claude-sonnet-4-5", "models/gemini-2.5-flash" → "gemini-2.5-flash". */
export function normalizeModelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '');
}

export function createCatalog({ db, cipher, log }) {
  let cache = null;
  let loadedAt = 0;
  let loading = null;

  async function load() {
    const [{ rows: providers }, { rows: models }] = await Promise.all([
      db.query('SELECT * FROM providers ORDER BY id'),
      db.query('SELECT * FROM models ORDER BY sort_order, id'),
    ]);
    const providerMap = new Map();
    for (const p of providers) {
      let apiKey = null;
      let keyError = null;
      if (p.api_key_enc) {
        try {
          apiKey = cipher.decrypt(p.api_key_enc);
        } catch {
          keyError = 'decrypt_failed';
          log?.error?.(`[catalog] cannot decrypt API key of provider #${p.id} (${p.name}) — was ENCRYPTION_KEY changed?`);
        }
      }
      providerMap.set(p.id, { ...p, apiKey, keyError });
    }
    const byId = new Map();
    const byAlias = new Map();
    const byNorm = new Map();
    const byUpstream = new Map();
    for (const m of models) {
      const entry = { ...m, provider: providerMap.get(m.provider_id) || null };
      byId.set(m.id, entry);
      byAlias.set(m.alias, entry);
      const norm = normalizeModelName(m.alias);
      if (!byNorm.has(norm) || (!byNorm.get(norm).enabled && m.enabled)) byNorm.set(norm, entry);
      const up = normalizeModelName(m.upstream_model);
      if (!byUpstream.has(up) || (!byUpstream.get(up).enabled && m.enabled)) byUpstream.set(up, entry);
    }
    cache = { providers: providerMap, byId, byAlias, byNorm, byUpstream };
    loadedAt = Date.now();
    return cache;
  }

  return {
    async get() {
      if (cache && Date.now() - loadedAt < 60_000) return cache;
      loading ||= load().finally(() => (loading = null));
      return loading;
    },
    invalidate() {
      cache = null;
    },
    /**
     * Finds the model a client asked for. Apps keep using the names they already have:
     * exact alias → case/date-suffix-insensitive alias → the provider's own model id.
     */
    async resolve(name) {
      const c = await this.get();
      if (!name) return null;
      if (c.byAlias.has(name)) return c.byAlias.get(name);
      const norm = normalizeModelName(name);
      return c.byNorm.get(norm) || c.byUpstream.get(norm) || null;
    },
    async byId(id) {
      return (await this.get()).byId.get(Number(id)) || null;
    },
  };
}
