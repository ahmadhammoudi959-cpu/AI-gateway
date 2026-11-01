import { html, useState, useMemo, api, useData, go, useApp, PAYMENT_METHODS, toast, daysPhrase } from '../lib.js';
import {
  PageHead,
  Loading,
  ErrorBox,
  Empty,
  Seg,
  Meter,
  StateBadge,
  Money,
  Modal,
  Field,
  FormError,
  useAction,
  CodeTabs,
  envTabs,
  Icon,
  planOptions,
} from '../ui.js';

/** One app as a meter row (used here and on the overview). */
export function AppRow({ s, warn }) {
  const days = s.days_left;
  const period =
    s.state === 'expired'
      ? 'انتهت الدورة'
      : days <= 0
        ? 'تتجدد اليوم'
        : `${s.auto_renew ? 'تتجدد' : 'تنتهي'} ${daysPhrase(days)}`;
  return html`<a class="ledger-row" href=${`#/apps/${s.id}`}>
    <div>
      <div class="name">${s.name}</div>
      <div class="sub">${s.plan_name || (s.limit_override_usd != null ? 'حد مخصص' : 'بدون باقة')}${s.owner_name ? ` — ${s.owner_name}` : ''}</div>
    </div>
    <${Meter} pct=${s.usage_pct} warn=${warn} state=${s.state} label=${`استهلاك ${s.name}`} />
    <div class="figures">
      <div><${Money} v=${s.spend_usd} /> <span class="faint">من</span> <${Money} v=${s.limit_usd} /></div>
      <div class="faint tiny">${period}</div>
    </div>
    <div class="state"><${StateBadge} state=${s.state} /></div>
  </a>`;
}

export function KeyRevealModal({ title, apiKey, baseUrl, models = [], onClose }) {
  const anthropic = models.find((m) => m.provider_kind === 'anthropic' && m.kind === 'chat')?.alias;
  const chat = models.find((m) => m.kind === 'chat')?.alias;
  return html`<${Modal} wide title=${title} onClose=${onClose}
    desc="ضع هذه المتغيرات في إعدادات التطبيق (Environment Variables) ثم أعد تشغيله."
    footer=${html`<button class="btn btn-primary" onClick=${onClose}>تم الحفظ</button>`}>
    <div class="callout warn">المفتاح الكامل يظهر هذه المرة فقط. انسخه الآن واحفظه في إعدادات التطبيق — لو ضاع، أنشئ مفتاحاً جديداً من صفحة التطبيق.</div>
    <${CodeTabs} tabs=${envTabs({ baseUrl, apiKey, anthropicModel: anthropic, model: chat })} />
  </${Modal}>`;
}

export function NewAppModal({ plans, onClose, onCreated }) {
  const activePlans = plans.filter((p) => !p.archived);
  const [f, setF] = useState({
    name: '',
    plan_id: activePlans[0]?.id ?? 'custom',
    limit_override_usd: '',
    owner_name: '',
    contact: '',
    auto_renew: true,
    pay_amount: activePlans[0] ? String(activePlans[0].price_usd) : '',
    pay_method: '',
    notes: '',
  });
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const onPlan = (e) => {
    const p = plans.find((x) => String(x.id) === e.target.value);
    setF({ ...f, plan_id: e.target.value, pay_amount: p ? String(p.price_usd) : f.pay_amount });
  };
  const custom = f.plan_id === 'custom';
  const submit = () =>
    run(async () => {
      const r = await api('/systems', {
        method: 'POST',
        body: {
          name: f.name,
          plan_id: custom ? null : Number(f.plan_id),
          limit_override_usd: custom ? f.limit_override_usd : null,
          owner_name: f.owner_name,
          contact: f.contact,
          auto_renew: f.auto_renew,
          notes: f.notes,
          payment: Number(f.pay_amount) > 0 ? { amount_usd: f.pay_amount, method: f.pay_method } : null,
        },
      });
      onCreated(r);
    });
  return html`<${Modal} title="إضافة تطبيق" desc="كل تطبيق يأخذ مفتاحاً خاصاً به وحداً شهرياً حسب باقته." onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الإضافة…' : 'إضافة التطبيق'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <div class="form-grid">
      <${Field} full label="اسم التطبيق"><input class="input" required value=${f.name} onInput=${set('name')} placeholder="مثال: Star Style" /></${Field}>
      <${Field} full label="الباقة" hint=${activePlans.length ? '' : 'لا توجد باقات بعد — حدد حداً مخصصاً أو أنشئ باقة من صفحة الباقات.'}>
        <select class="select" value=${f.plan_id} onChange=${onPlan}>
          ${planOptions(plans)}
          <option value="custom">حد شهري مخصص بدون باقة</option>
        </select>
      </${Field}>
      ${custom &&
      html`<${Field} full label="الحد الشهري (بالدولار)" hint="أقصى تكلفة استهلاك فعلية مسموحة للتطبيق في الشهر.">
        <input class="input ltr" type="number" min="0.01" step="0.01" required value=${f.limit_override_usd} onInput=${set('limit_override_usd')} />
      </${Field}>`}
      <${Field} label="صاحب التطبيق"><input class="input" value=${f.owner_name} onInput=${set('owner_name')} /></${Field}>
      <${Field} label="رقم التواصل أو البريد"><input class="input ltr" value=${f.contact} onInput=${set('contact')} /></${Field}>
      <div class="full">
        <label class="check"><input type="checkbox" checked=${f.auto_renew} onChange=${set('auto_renew')} />
          <span>تجديد تلقائي كل شهر<small>عند نهاية الشهر يبدأ شهر جديد ويتصفّر الاستهلاك. لو أوقفته، يتوقف التطبيق في نهاية الشهر حتى تجدده يدوياً.</small></span></label>
      </div>
      <${Field} label="دفعة مستلمة الآن (اختياري)" hint="تُسجَّل في المالية كاشتراك.">
        <input class="input ltr" type="number" min="0" step="0.01" value=${f.pay_amount} onInput=${set('pay_amount')} />
      </${Field}>
      <${Field} label="طريقة الدفع">
        <input class="input" list="pay-methods" value=${f.pay_method} onInput=${set('pay_method')} />
        <datalist id="pay-methods">${PAYMENT_METHODS.map((m) => html`<option value=${m} />`)}</datalist>
      </${Field}>
      <${Field} full label="ملاحظات"><textarea class="textarea" value=${f.notes} onInput=${set('notes')}></textarea></${Field}>
    </div>
  </${Modal}>`;
}

const FILTERS = [
  { value: 'all', label: 'الكل', test: () => true },
  { value: 'attention', label: 'قرب الحد', test: (s) => s.state === 'warning' || s.state === 'no_plan' },
  { value: 'stopped', label: 'متوقفة', test: (s) => s.state === 'limit_reached' || s.state === 'expired' },
  { value: 'suspended', label: 'موقوفة', test: (s) => s.state === 'suspended' },
];

export function AppsPage({ query }) {
  const { warn } = useApp();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const archived = filter === 'archived';
  const { data, error, loading, reload } = useData(`/systems${archived ? '?archived=1' : ''}`);
  const [modal, setModal] = useState(query.new ? 'new' : null);
  const [reveal, setReveal] = useState(null);

  const list = useMemo(() => {
    if (!data) return [];
    const f = FILTERS.find((x) => x.value === filter) || FILTERS[0];
    const q = search.trim().toLowerCase();
    return data.systems.filter(
      (s) => (archived || f.test(s)) && (!q || [s.name, s.owner_name, s.contact].some((v) => String(v || '').toLowerCase().includes(q))),
    );
  }, [data, filter, search]);

  const counts = useMemo(() => {
    const c = {};
    if (data && !archived) for (const f of FILTERS) c[f.value] = data.systems.filter(f.test).length;
    return c;
  }, [data]);

  return html`<div>
    <${PageHead} title="التطبيقات" desc="كل تطبيق مربوط بالمنصة بعداد شهري: يمتلئ مع الاستهلاك ويتوقف عند الحد."
      actions=${html`<button class="btn btn-primary" onClick=${() => setModal('new')}><${Icon} name="plus" />إضافة تطبيق</button>`} />
    <div class="spread" style=${{ marginBottom: '14px' }}>
      <${Seg} label="تصفية" value=${filter} onChange=${setFilter}
        options=${[...FILTERS.map((f) => ({ value: f.value, label: f.label, count: counts[f.value] })), { value: 'archived', label: 'الأرشيف' }]} />
      <input class="input" style=${{ maxWidth: '260px' }} type="search" placeholder="بحث بالاسم أو التواصل" value=${search}
        onInput=${(e) => setSearch(e.target.value)} aria-label="بحث" />
    </div>
    ${loading && !data
      ? html`<${Loading} />`
      : error
        ? html`<${ErrorBox} error=${error} retry=${reload} />`
        : html`<div class="sheet">
            ${list.length
              ? html`<div class="ledger">${list.map((s) => html`<${AppRow} s=${s} warn=${warn} />`)}</div>`
              : data.systems.length || archived
                ? html`<${Empty} title="لا توجد نتائج" text=${archived ? 'لا توجد تطبيقات مؤرشفة.' : 'جرّب تصفية أو بحثاً آخر.'} />`
                : html`<${Empty} title="لا توجد تطبيقات بعد"
                    text="أضف أول تطبيق (مثل Star Style) لتحصل على المفتاح والمتغيرات الجاهزة لربطه."
                    action=${html`<button class="btn btn-primary" onClick=${() => setModal('new')}>إضافة تطبيق</button>`} />`}
          </div>`}
    ${modal === 'new' &&
    data &&
    html`<${NewAppModal} plans=${data.plans} onClose=${() => setModal(null)}
      onCreated=${(r) => {
        setModal(null);
        setReveal(r);
        toast(`تمت إضافة «${r.system.name}»`);
        reload();
      }} />`}
    ${reveal &&
    html`<${KeyRevealModal} title=${`«${reveal.system.name}» جاهز للربط`} apiKey=${reveal.api_key} baseUrl=${reveal.base_url}
      models=${reveal.models} onClose=${() => {
        const id = reveal.system.id;
        setReveal(null);
        go(`/apps/${id}`);
      }} />`}
  </div>`;
}
