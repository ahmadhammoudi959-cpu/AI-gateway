// Shared runtime: Preact + htm (vendored, no build step), API client, formatting, toasts, routing.
import {
  html,
  render,
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  useContext,
  createContext,
} from '/vendor/htm/preact/standalone.module.js';

export { html, render, useState, useEffect, useMemo, useRef, useCallback, useContext, createContext };

// ───────────── API ─────────────
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    onUnauthorized();
  }
  if (!res.ok) throw new Error(data?.error || `خطأ ${res.status}`);
  return data;
}

/** Loads data for a page; `reload()` refetches. */
export function useData(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const load = useCallback(async () => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api(path);
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (n === seq.current) setState({ data: null, error: e.message, loading: false });
    }
  }, [path]);
  useEffect(() => {
    load();
  }, [load, ...deps]);
  return { ...state, reload: load };
}

// ───────────── Toasts ─────────────
const toastSubs = new Set();
let toasts = [];
export function toast(message, kind = 'info') {
  const id = Math.random();
  toasts = [...toasts, { id, message, kind }];
  toastSubs.forEach((f) => f(toasts));
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastSubs.forEach((f) => f(toasts));
  }, kind === 'error' ? 6000 : 3200);
}
export function useToasts() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    toastSubs.add(setList);
    return () => toastSubs.delete(setList);
  }, []);
  return list;
}

// ───────────── Routing (hash based) ─────────────
const parseHash = () => {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = h.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(query)) };
};
export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}
export const go = (path) => {
  location.hash = path;
};

// ───────────── App context ─────────────
export const AppCtx = createContext({ admin: null, tz: 'Africa/Cairo', brand: '', baseUrl: '' });
export const useApp = () => useContext(AppCtx);

// ───────────── Formatting ─────────────
const en = 'en-US';
export function money(v, { sign = false } = {}) {
  const n = Number(v) || 0;
  const abs = Math.abs(n);
  const max = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  const s = '$' + abs.toLocaleString(en, { minimumFractionDigits: 2, maximumFractionDigits: max });
  if (n < 0) return '−' + s;
  return sign && n > 0 ? '+' + s : s;
}
export const int = (v) => Math.round(Number(v) || 0).toLocaleString(en);
export const compact = (v) =>
  new Intl.NumberFormat(en, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(v) || 0);
export const pct = (v, digits = 0) => `${(Number(v) || 0).toFixed(digits)}%`;
export const price = (v) => (v == null || v === '' ? '—' : '$' + Number(v).toLocaleString(en, { maximumFractionDigits: 6 }));

const AR = 'ar-EG-u-nu-latn';
const fmtCache = new Map();
function fmt(opts, tz) {
  const key = JSON.stringify(opts) + tz;
  if (!fmtCache.has(key)) {
    try {
      fmtCache.set(key, new Intl.DateTimeFormat(AR, { ...opts, timeZone: tz }));
    } catch {
      fmtCache.set(key, new Intl.DateTimeFormat(AR, opts));
    }
  }
  return fmtCache.get(key);
}
export const date = (d, tz) => (d ? fmt({ day: 'numeric', month: 'short', year: 'numeric' }, tz).format(new Date(d)) : '—');
export const dayMonth = (d, tz) => (d ? fmt({ day: 'numeric', month: 'short' }, tz).format(new Date(d)) : '—');
export const dateTime = (d, tz) =>
  d ? fmt({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, tz).format(new Date(d)) : '—';
export const monthLabel = (ym) => {
  const [y, m] = String(ym).split('-').map(Number);
  return new Intl.DateTimeFormat(AR, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
};
/** A YYYY-MM-DD day key rendered as "3 نوفمبر". */
export const dayLabel = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Intl.DateTimeFormat(AR, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
};
/** Arabic counted phrase: "بعد يوم"، "بعد يومين"، "بعد 5 أيام"، "بعد 12 يوماً". */
export function daysPhrase(n) {
  if (n === 1) return 'بعد يوم';
  if (n === 2) return 'بعد يومين';
  if (n >= 3 && n <= 10) return `بعد ${n} أيام`;
  return `بعد ${n} يوماً`;
}
export function daysCount(n) {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومان';
  if (n >= 3 && n <= 10) return `${n} أيام`;
  return `${n} يوماً`;
}

const rtf = new Intl.RelativeTimeFormat(AR, { numeric: 'auto' });
export function ago(d) {
  if (!d) return 'لم يُستخدم';
  const s = (new Date(d).getTime() - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 60) return 'الآن';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 30) return rtf.format(Math.round(s / 86400), 'day');
  return rtf.format(Math.round(s / (86400 * 30)), 'month');
}

export const STATES = {
  active: { label: 'نشط', tone: 'ok' },
  warning: { label: 'قرب الحد', tone: 'warn' },
  limit_reached: { label: 'وصل للحد', tone: 'bad' },
  expired: { label: 'الاشتراك منتهي', tone: 'bad' },
  suspended: { label: 'موقوف', tone: 'dim' },
  no_plan: { label: 'بدون باقة', tone: 'warn' },
  archived: { label: 'مؤرشف', tone: 'dim' },
};

export const ENDPOINTS = {
  chat: 'Chat',
  messages: 'Claude Messages',
  embeddings: 'Embeddings',
  images: 'صور',
  responses: 'Responses',
};

export const PAYMENT_KINDS = {
  subscription: 'اشتراك',
  upgrade: 'ترقية',
  topup: 'شحن رصيد',
  other: 'أخرى',
};

export const PAYMENT_METHODS = ['تحويل بنكي', 'إنستاباي', 'فودافون كاش', 'كاش', 'بطاقة'];

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {}
    ta.remove();
  }
  toast('تم النسخ');
}
