import crypto from 'node:crypto';

export const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export const round = (n, digits = 8) => {
  const f = 10 ** digits;
  return Math.round(num(n) * f) / f;
};

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function randomBase62(n) {
  let out = '';
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b < 248) out += B62[b % 62]; // 248 = 62*4, avoids modulo bias
      if (out.length === n) break;
    }
  }
  return out;
}

export const requestId = () => 'req_' + randomBase62(20);

/** Client API keys look like OpenAI keys so every SDK accepts them. Only the hash is stored. */
export function generateApiKey() {
  const key = 'sk-gw-' + randomBase62(40);
  return { key, hash: sha256(key), prefix: key.slice(0, 10), last4: key.slice(-4) };
}

/** AES-256-GCM for provider API keys at rest. */
export function makeCipher(secret) {
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
    },
    decrypt(blob) {
      const [v, iv, tag, ct] = String(blob).split(':');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unsupported ciphertext');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

const scryptAsync = (pw, salt, len, opts) =>
  new Promise((resolve, reject) => crypto.scrypt(pw, salt, len, opts, (e, k) => (e ? reject(e) : resolve(k))));

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const hash = await scryptAsync(String(password), salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const got = await scryptAsync(String(password), Buffer.from(salt, 'base64url'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Adds calendar months in UTC, clamping to the month's last day (Jan 31 + 1 → Feb 28/29). */
export function addMonths(date, n) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Smallest anchor + k months (k ≥ 1) that is strictly after `after`. Keeps renewals on the same day of month. */
export function nextBoundary(anchor, after) {
  const a = new Date(anchor);
  const t = new Date(after);
  let k = Math.max(1, (t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth()) - 1);
  let d = addMonths(a, k);
  while (d <= t) d = addMonths(a, ++k);
  return d;
}

/** Rough token estimate used only when a provider does not report usage (aborted streams etc.).
 * UTF-8 bytes / 4 ≈ 1 token per 4 English chars and per ~2 Arabic chars — deliberately conservative. */
export const estimateTokens = (text) => (text ? Math.ceil(Buffer.byteLength(String(text), 'utf8') / 4) : 0);

export function estimatePromptTokens(body = {}) {
  let bytes = 0;
  let images = 0;
  const add = (c, depth = 0) => {
    if (c == null || depth > 4) return;
    if (typeof c === 'string') {
      bytes += Buffer.byteLength(c);
      return;
    }
    if (Array.isArray(c)) {
      for (const p of c) add(p, depth + 1);
      return;
    }
    if (typeof c !== 'object') return;
    const t = c.type;
    if (t === 'image_url' || t === 'image' || t === 'input_image') images++;
    else if (t === 'file' || t === 'document' || t === 'input_file') images += 2;
    else if (typeof c.text === 'string') bytes += Buffer.byteLength(c.text);
    else if (c.content != null) add(c.content, depth + 1);
    else if (t === 'tool_use') bytes += Buffer.byteLength(JSON.stringify(c.input || {}));
    if (Array.isArray(c.tool_calls)) {
      for (const tc of c.tool_calls) bytes += Buffer.byteLength(String(tc?.function?.arguments || '')) + 16;
    }
  };
  add(body.system);
  add(body.instructions);
  add(body.messages);
  add(body.input);
  add(body.prompt);
  if (Array.isArray(body.tools)) bytes += Buffer.byteLength(JSON.stringify(body.tools));
  return Math.ceil(bytes / 4) + images * 1000;
}

export function joinUrl(base, p) {
  return String(base).replace(/\/+$/, '') + '/' + String(p).replace(/^\/+/, '');
}

export function maskTail(s, keep = 4) {
  if (!s) return '';
  const str = String(s);
  return str.length <= keep ? '••••' : '••••' + str.slice(-keep);
}

/** Removes anything that looks like a credential from provider error messages before they reach a client. */
export function scrubSecrets(text, extra = []) {
  let out = String(text ?? '');
  for (const s of extra) if (s && s.length >= 8) out = out.split(s).join('***');
  return out
    .replace(/sk-[A-Za-z0-9_\-*.]{8,}/g, 'sk-***')
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, 'AIza***')
    .replace(/gsk_[A-Za-z0-9]{10,}/g, 'gsk_***')
    .replace(/xai-[A-Za-z0-9]{10,}/g, 'xai-***')
    .replace(/\borg-[A-Za-z0-9]{10,}/g, 'org-***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{10,}/gi, 'Bearer ***');
}

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
