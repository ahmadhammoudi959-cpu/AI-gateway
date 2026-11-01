import { Agent, fetch as undiciFetch } from 'undici';
import { joinUrl, scrubSecrets } from '../util.js';

let agent = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000, connect: { timeout: 30_000 } });

export function configureUpstream(cfg) {
  agent = new Agent({
    headersTimeout: cfg.upstreamTimeoutMs,
    bodyTimeout: cfg.upstreamTimeoutMs,
    connect: { timeout: 30_000 },
    keepAliveTimeout: 60_000,
  });
}

const TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'insufficient_quota',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
};
const ANTHROPIC_TYPES = { ...TYPES, 402: 'billing_error', 503: 'overloaded_error' };

/** An error returned to the client in OpenAI format (or Anthropic format on /v1/messages). */
export class GatewayError extends Error {
  constructor(status, code, message, opts = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = !!opts.retryable; // worth trying the fallback model
    this.providerAuth = !!opts.providerAuth;
    this.upstreamStatus = opts.upstreamStatus;
    this.retryAfter = opts.retryAfter;
    this.detail = opts.detail; // admin-only detail stored in the request log
  }
}

export function errorBody(err, format = 'openai') {
  const status = err.status || 500;
  if (format === 'anthropic') {
    return { type: 'error', error: { type: ANTHROPIC_TYPES[status] || 'api_error', message: err.message } };
  }
  return { error: { message: err.message, type: TYPES[status] || 'api_error', param: null, code: err.code ?? null } };
}

export function anthropicBase(baseUrl) {
  return String(baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function providerUrl(provider, path) {
  if (provider.kind === 'anthropic') return joinUrl(anthropicBase(provider.base_url), path);
  return joinUrl(provider.base_url, path);
}

export function providerHeaders(provider, { stream = false, anthropicVersion, anthropicBeta } = {}) {
  const h = { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' };
  if (provider.kind === 'anthropic') {
    h['x-api-key'] = provider.apiKey;
    h['anthropic-version'] = anthropicVersion || '2023-06-01';
    if (anthropicBeta) h['anthropic-beta'] = anthropicBeta;
  } else {
    h.authorization = `Bearer ${provider.apiKey}`;
  }
  if (provider.extra_headers && typeof provider.extra_headers === 'object') {
    for (const [k, v] of Object.entries(provider.extra_headers)) if (v != null) h[k.toLowerCase()] = String(v);
  }
  return h;
}

export async function upstreamFetch(url, init = {}) {
  try {
    return await undiciFetch(url, { ...init, dispatcher: agent });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    const reason = e?.cause?.code || e?.cause?.message || e?.message || 'network error';
    throw new GatewayError(502, 'upstream_unreachable', `Could not reach the AI provider (${reason}).`, {
      retryable: true,
      detail: String(reason),
    });
  }
}

/** Maps a failed provider response to a client-safe error (never leaks our provider key). */
export function upstreamErrorFromText(status, text, headers, provider) {
  let message = String(text || '').slice(0, 1200) || `HTTP ${status}`;
  try {
    const j = JSON.parse(text);
    const e = j?.error ?? j;
    message = (typeof e === 'string' ? e : e?.message || j?.message) || message;
  } catch {}
  message = scrubSecrets(message, [provider?.apiKey]);
  if (status === 401 || status === 403) {
    return new GatewayError(
      502,
      'upstream_auth_error',
      'The AI provider rejected the gateway credentials; the administrator has been notified. | مزوّد الذكاء الاصطناعي رفض بيانات الربط وتم إبلاغ الإدارة.',
      { retryable: true, providerAuth: true, upstreamStatus: status, detail: message },
    );
  }
  if (status === 429) {
    const ra = Number(headers?.get?.('retry-after'));
    return new GatewayError(429, 'upstream_rate_limited', `The AI provider is rate limiting requests, retry shortly. (${message})`, {
      retryable: true,
      upstreamStatus: status,
      retryAfter: Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 5,
      detail: message,
    });
  }
  if (status >= 500) {
    return new GatewayError(502, 'upstream_error', `The AI provider returned an error (${status}): ${message}`, {
      retryable: true,
      upstreamStatus: status,
      detail: message,
    });
  }
  if (status === 404) {
    return new GatewayError(502, 'upstream_not_found', `The provider could not find this model or endpoint: ${message}`, {
      retryable: true,
      upstreamStatus: status,
      detail: message,
    });
  }
  return new GatewayError(status, 'upstream_invalid_request', message, { upstreamStatus: status, detail: message });
}

export async function upstreamError(r, provider) {
  const text = await r.text().catch(() => '');
  return upstreamErrorFromText(r.status, text, r.headers, provider);
}

export async function readJson(r) {
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError(502, 'upstream_bad_response', 'The AI provider returned an invalid response.', {
      retryable: true,
      detail: text.slice(0, 300),
    });
  }
}
