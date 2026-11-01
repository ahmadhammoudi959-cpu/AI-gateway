// Client portal: an app owner opens /portal with their app key to see usage and request an upgrade.
import { html, render, useState, useEffect, money, int, compact, date, daysCount, STATES } from './lib.js';
import { BrandMark, Meter, BarChart, Toasts, levelFor } from './ui.js';

const KEY_STORE = 'gw_portal_key';
const store = {
  get() {
    try {
      return sessionStorage.getItem(KEY_STORE) || '';
    } catch {
      return '';
    }
  },
  set(v) {
    try {
      v ? sessionStorage.setItem(KEY_STORE, v) : sessionStorage.removeItem(KEY_STORE);
    } catch {}
  },
};

async function fetchUsage(key) {
  const r = await fetch('/v1/usage', { headers: { authorization: `Bearer ${key}` } });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(r.status === 401 ? 'المفتاح غير صحيح أو أُلغي.' : j?.error?.message || 'تعذر تحميل البيانات.');
  return j;
}

const waLink = (support, text) =>
  support?.whatsapp_url ? `${support.whatsapp_url}${support.whatsapp_url.includes('?') ? '&' : '?'}text=${encodeURIComponent(text)}` : null;

function KeyForm({ onKey, error, busy }) {
  const [key, setKey] = useState('');
  return html`<form class="sheet sheet-pad stack" onSubmit=${(e) => (e.preventDefault(), onKey(key.trim()))}>
    <div><h1 style=${{ fontSize: '22px' }}>استهلاك الذكاء الاصطناعي لتطبيقك</h1>
      <p class="muted" style=${{ marginTop: '4px' }}>أدخل مفتاح التطبيق (يبدأ بـ sk-gw-) لعرض الباقة ونسبة الاستهلاك هذا الشهر.</p></div>
    ${error && html`<div class="callout bad" role="alert">${error}</div>`}
    <label class="field"><span>مفتاح التطبيق</span>
      <input class="input ltr" type="password" autocomplete="off" required value=${key} onInput=${(e) => setKey(e.target.value)} placeholder="sk-gw-…" /></label>
    <div><button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ التحميل…' : 'عرض الاستهلاك'}</button></div>
    <p class="tiny faint">المفتاح يُستخدم للقراءة فقط ولا يُحفظ بعد إغلاق الصفحة.</p>
  </form>`;
}

function Usage({ d }) {
  const level = levelFor(d.usage.percent, 80, d.system.state);
  const state = STATES[d.system.state] || STATES.active;
  const stopped = ['limit_reached', 'expired', 'suspended'].includes(d.system.state);
  const upgradeText = `مرحباً، أريد ترقية باقة الذكاء الاصطناعي لتطبيق «${d.system.name}».`;
  const showCost = d.usage.limit_usd != null;
  return html`<div class="stack" style=${{ gap: '22px' }}>
    <section class="sheet sheet-pad">
      <div class="spread" style=${{ marginBottom: '18px' }}>
        <div class="portal-hero"><h1>${d.system.name}</h1>
          <p class="muted">${d.plan ? html`باقة ${d.plan.name} — <span class="num">${money(d.plan.price_usd)}</span> شهرياً` : 'بدون باقة'}</p></div>
        <span class=${`badge ${state.tone}`}>${state.label}</span>
      </div>
      <div class="readout">
        <div class="readout-main">
          <span class="num display">${Math.round(d.usage.percent)}%</span>
          <span class="readout-of">${showCost ? html`<span class="num">${money(d.usage.spent_usd)}</span> من <span class="num">${money(d.usage.limit_usd)}</span>` : 'من باقة هذا الشهر'}</span>
        </div>
      </div>
      <${Meter} large pct=${d.usage.percent} state=${d.system.state} label="استهلاك الباقة" />
      <dl class="kv" style=${{ marginTop: '22px' }}>
        <div><dt>${d.period.auto_renew ? 'تتجدد الباقة بعد' : 'تنتهي الباقة بعد'}</dt><dd>${d.period.days_left > 0 ? daysCount(d.period.days_left) : 'اليوم'}</dd></div>
        <div><dt>نهاية الشهر الحالي</dt><dd>${date(d.period.end)}</dd></div>
        <div><dt>الطلبات</dt><dd class="num">${int(d.usage.requests)}</dd></div>
        <div><dt>التوكنز</dt><dd><span class="num">${compact(d.usage.input_tokens + d.usage.output_tokens)}</span></dd></div>
      </dl>
      ${stopped &&
      html`<div class="callout bad" style=${{ marginTop: '18px' }}>
        ${d.system.state === 'limit_reached' ? 'تم استهلاك الباقة بالكامل لهذا الشهر، وميزات الذكاء الاصطناعي في التطبيق متوقفة حتى الترقية أو الشحن.' : d.system.state === 'expired' ? 'انتهى الاشتراك وميزات الذكاء الاصطناعي متوقفة حتى التجديد.' : 'الخدمة موقوفة مؤقتاً.'}
      </div>`}
      ${level === 'warn' && !stopped && html`<div class="callout warn" style=${{ marginTop: '18px' }}>اقتربت من حد الباقة — رقِّها قبل أن تتوقف الخدمة.</div>`}
      ${d.support &&
      html`<div class="row" style=${{ marginTop: '18px' }}>
        ${waLink(d.support, upgradeText)
          ? html`<a class="btn btn-primary" href=${waLink(d.support, upgradeText)} target="_blank" rel="noopener">طلب ترقية عبر واتساب</a>`
          : html`<span class="small">للترقية تواصل معنا: <span class="ltr">${d.support.contact}</span></span>`}
      </div>`}
    </section>

    ${d.daily.length > 0 &&
    html`<section class="sheet sheet-pad">
      <h2>الاستهلاك اليومي</h2>
      <p class="small muted">نسبة كل يوم من الباقة</p>
      <${BarChart} data=${d.daily} value="percent_of_limit" fmt=${(v) => `${Number(v || 0).toFixed(1)}%`} label="الاستهلاك اليومي"
        extra=${(x) => `${int(x.requests)} طلب`} />
    </section>`}

    ${d.plans.length > 0 &&
    html`<section class="sheet">
      <div class="sheet-head"><h2>الباقات المتاحة</h2></div>
      <ul class="plan-list">
        ${d.plans.map(
          (p) => html`<li class=${p.current ? 'current' : ''}>
            <div><strong>${p.name}</strong>${p.current ? html` <span class="badge ok plain">باقتك</span>` : ''}${p.description ? html`<div class="small muted">${p.description}</div>` : ''}</div>
            <div class="row"><span class="num" style=${{ fontWeight: 500 }}>${money(p.price_usd)}</span>
              ${!p.current && waLink(d.support, `${upgradeText} الباقة المطلوبة: ${p.name}.`) &&
              html`<a class="btn btn-sm" href=${waLink(d.support, `${upgradeText} الباقة المطلوبة: ${p.name}.`)} target="_blank" rel="noopener">اطلبها</a>`}</div>
          </li>`,
        )}
      </ul>
    </section>`}

    <section class="sheet sheet-pad">
      <h2 style=${{ marginBottom: '10px' }}>الموديلات المتاحة لتطبيقك</h2>
      <div class="models-inline">${d.models.map((m) => html`<span class="keychip">${m.id}</span>`)}</div>
    </section>
  </div>`;
}

function Portal() {
  const [brand, setBrand] = useState('');
  const [key, setKey] = useState(store.get());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch('/api/public/info').then((r) => r.json()).then((i) => setBrand(i.brand_name)).catch(() => {});
  }, []);
  const load = async (k) => {
    setBusy(true);
    setError('');
    try {
      const d = await fetchUsage(k);
      setData(d);
      setKey(k);
      store.set(k);
      document.title = `${d.system.name} — ${d.brand}`;
    } catch (e) {
      setError(e.message);
      setData(null);
      store.set('');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (key) load(key);
  }, []);
  const reset = () => (store.set(''), setKey(''), setData(null));
  return html`<div class="portal">
    <header class="portal-head">
      <div class="brand"><${BrandMark} size=${30} /><div>${data?.brand || brand || ''}<small>استهلاك الذكاء الاصطناعي</small></div></div>
      ${data && html`<button class="btn btn-sm btn-quiet" onClick=${reset}>مفتاح آخر</button>`}
    </header>
    ${data ? html`<${Usage} d=${data} />` : html`<${KeyForm} onKey=${load} error=${error} busy=${busy} />`}
    <${Toasts} />
  </div>`;
}

render(html`<${Portal} />`, document.getElementById('root'));
