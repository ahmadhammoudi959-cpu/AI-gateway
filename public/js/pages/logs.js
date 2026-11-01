import { html, useState, useEffect, api, useApp } from '../lib.js';
import { PageHead, Loading, ErrorBox, Empty, Field } from '../ui.js';
import { LogTable } from './app.js';

export function LogsPage({ query = {} }) {
  const { tz } = useApp();
  const [filters, setFilters] = useState({ system_id: query.system_id || '', model: '', status: '', from: '', to: '' });
  const [apps, setApps] = useState([]);
  const [state, setState] = useState({ logs: [], next: null, loading: true, error: null });

  const qs = (extra = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v) p.set(k, v);
    return p.toString();
  };
  const load = async (append = false) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const r = await api(`/logs?${qs(append && state.next ? { before: state.next } : {})}`);
      setState((s) => ({ logs: append ? [...s.logs, ...r.logs] : r.logs, next: r.next_before, loading: false, error: null }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e.message }));
    }
  };
  useEffect(() => {
    load();
  }, [filters.system_id, filters.status, filters.from, filters.to]);
  useEffect(() => {
    api('/systems').then((r) => setApps(r.systems)).catch(() => {});
  }, []);
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });

  return html`<div>
    <${PageHead} title="سجل الطلبات" desc="كل طلب مرّ عبر المنصة: من أرسله، لأي موديل، كم توكن، وكم كلّف. الطلبات المرفوضة (حد، اشتراك منتهي…) تظهر أيضاً." />
    <form class="sheet sheet-pad form-grid" style=${{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: '16px' }}
      onSubmit=${(e) => (e.preventDefault(), load())}>
      <${Field} label="التطبيق"><select class="select" value=${filters.system_id} onChange=${set('system_id')}>
        <option value="">كل التطبيقات</option>${apps.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select></${Field}>
      <${Field} label="الموديل"><input class="input ltr" value=${filters.model} onInput=${set('model')} onBlur=${() => load()} placeholder="claude…" /></${Field}>
      <${Field} label="النتيجة"><select class="select" value=${filters.status} onChange=${set('status')}>
        <option value="">الكل</option><option value="ok">ناجحة</option><option value="error">مرفوضة أو فاشلة</option></select></${Field}>
      <${Field} label="من"><input class="input" type="date" value=${filters.from} onChange=${set('from')} /></${Field}>
      <${Field} label="إلى"><input class="input" type="date" value=${filters.to} onChange=${set('to')} /></${Field}>
    </form>
    <div class="sheet">
      ${state.error
        ? html`<${ErrorBox} error=${state.error} retry=${() => load()} />`
        : state.logs.length
          ? html`<${LogTable} logs=${state.logs} tz=${tz} showApp />`
          : state.loading
            ? html`<${Loading} />`
            : html`<${Empty} title="لا توجد طلبات" text="لا توجد طلبات تطابق التصفية الحالية." />`}
    </div>
    ${state.next &&
    html`<div style=${{ textAlign: 'center', marginTop: '14px' }}>
      <button class="btn" disabled=${state.loading} onClick=${() => load(true)}>${state.loading ? 'جارِ التحميل…' : 'تحميل المزيد'}</button>
    </div>`}
  </div>`;
}
