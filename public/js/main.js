import { html, render, useState, useEffect, api, useRoute, AppCtx, setUnauthorizedHandler } from './lib.js';
import { Icon, BrandMark, Toasts, Loading, useAction, FormError } from './ui.js';
import { OverviewPage } from './pages/overview.js';
import { AppsPage } from './pages/apps.js';
import { AppPage } from './pages/app.js';
import { PlansPage } from './pages/plans.js';
import { ProvidersPage } from './pages/providers.js';
import { ModelsPage } from './pages/models.js';
import { LogsPage } from './pages/logs.js';
import { FinancePage } from './pages/finance.js';
import { SettingsPage } from './pages/settings.js';

const NAV = [
  { path: '/', label: 'نظرة عامة', icon: 'overview' },
  { path: '/apps', label: 'التطبيقات', icon: 'apps' },
  { path: '/plans', label: 'الباقات', icon: 'plans' },
  { path: '/providers', label: 'المزوّدون', icon: 'providers' },
  { path: '/models', label: 'الموديلات والأسعار', icon: 'models' },
  { path: '/logs', label: 'سجل الطلبات', icon: 'logs' },
  { path: '/finance', label: 'المالية', icon: 'finance' },
  { path: '/settings', label: 'الإعدادات', icon: 'settings' },
];

function Login({ brand, onDone }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const { busy, error, run } = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/auth/login', { method: 'POST', body: form });
      onDone();
    });
  };
  return html`<div class="auth-wrap">
    <form class="sheet auth stack" onSubmit=${submit}>
      <div class="brand"><${BrandMark} size=${34} /><div>${brand || 'لوحة التحكم'}<small>إدارة مفاتيح الذكاء الاصطناعي</small></div></div>
      <h1 style=${{ fontSize: '20px' }}>تسجيل الدخول</h1>
      <${FormError} error=${error} />
      <label class="field"><span>البريد الإلكتروني</span>
        <input class="input ltr" type="email" autocomplete="username" required value=${form.email}
          onInput=${(e) => setForm({ ...form, email: e.target.value })} /></label>
      <label class="field"><span>كلمة المرور</span>
        <input class="input ltr" type="password" autocomplete="current-password" required value=${form.password}
          onInput=${(e) => setForm({ ...form, password: e.target.value })} /></label>
      <button class="btn btn-primary btn-block" disabled=${busy}>${busy ? 'جارِ الدخول…' : 'دخول'}</button>
    </form>
  </div>`;
}

function pageFor(route) {
  const { path, query } = route;
  const m = /^\/apps\/(\d+)$/.exec(path);
  if (m) return html`<${AppPage} id=${Number(m[1])} query=${query} />`;
  switch (path) {
    case '/apps':
      return html`<${AppsPage} query=${query} />`;
    case '/plans':
      return html`<${PlansPage} query=${query} />`;
    case '/providers':
      return html`<${ProvidersPage} query=${query} />`;
    case '/models':
      return html`<${ModelsPage} />`;
    case '/logs':
      return html`<${LogsPage} query=${query} />`;
    case '/finance':
      return html`<${FinancePage} query=${query} />`;
    case '/settings':
      return html`<${SettingsPage} />`;
    default:
      return html`<${OverviewPage} />`;
  }
}

function Shell({ session, onLogout }) {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [route.path]);
  useEffect(() => {
    const label = NAV.find((n) => n.path !== '/' && route.path.startsWith(n.path))?.label || 'نظرة عامة';
    document.title = `${label} — ${session.brand_name}`;
    window.scrollTo(0, 0);
  }, [route.path]);
  const active = (p) => (p === '/' ? route.path === '/' : route.path === p || route.path.startsWith(p + '/'));
  const ctx = {
    admin: session.admin,
    tz: session.timezone,
    brand: session.brand_name,
    baseUrl: session.base_url,
    warn: session.warn_threshold || 80,
  };
  return html`<${AppCtx.Provider} value=${ctx}>
    <div class="mobile-bar">
      <a class="brand" href="#/" style=${{ padding: 0 }}><${BrandMark} />${session.brand_name}</a>
      <button class="btn btn-sm" aria-label="القائمة" onClick=${() => setOpen(!open)}><${Icon} name="menu" /></button>
    </div>
    <div class="shell">
      <aside class=${`sidebar ${open ? 'open' : ''}`}>
        <a class="brand" href="#/"><${BrandMark} /><div>${session.brand_name}<small>لوحة الإدارة</small></div></a>
        <nav class="nav" aria-label="الأقسام">
          ${NAV.map(
            (n) => html`<a href=${'#' + n.path} aria-current=${active(n.path) ? 'page' : undefined}><${Icon} name=${n.icon} />${n.label}</a>`,
          )}
        </nav>
        <div class="sidebar-foot">
          <div class="ltr" style=${{ overflow: 'hidden', textOverflow: 'ellipsis' }}>${session.admin.email}</div>
          <button type="button" onClick=${onLogout}>تسجيل الخروج</button>
        </div>
      </aside>
      <main class="main" id="main">${pageFor(route)}</main>
    </div>
    <${Toasts} />
  </${AppCtx.Provider}>`;
}

function App() {
  const [session, setSession] = useState(undefined);
  const [brand, setBrand] = useState('');
  const load = async () => {
    try {
      setSession(await api('/auth/me'));
    } catch {
      setSession(null);
      api('/public/info').then((i) => setBrand(i.brand_name)).catch(() => {});
    }
  };
  useEffect(() => {
    setUnauthorizedHandler(() => setSession(null));
    load();
  }, []);
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setSession(null);
  };
  if (session === undefined) return html`<${Loading} />`;
  if (!session) return html`<${Login} brand=${brand} onDone=${load} /><${Toasts} />`;
  return html`<${Shell} session=${session} onLogout=${logout} />`;
}

render(html`<${App} />`, document.getElementById('root'));
