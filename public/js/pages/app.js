import {
  html,
  useState,
  api,
  useData,
  useApp,
  go,
  toast,
  money,
  int,
  compact,
  date,
  dayMonth,
  dateTime,
  ago,
  daysCount,
  ENDPOINTS,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
} from '../lib.js';
import {
  PageHead,
  Loading,
  ErrorBox,
  Meter,
  StateBadge,
  Money,
  Modal,
  Field,
  FormError,
  useAction,
  CodeTabs,
  envTabs,
  KeyChip,
  BarChart,
  levelFor,
  planOptions,
  Icon,
} from '../ui.js';
import { KeyRevealModal } from './apps.js';

function PaymentFields({ f, setF, label = 'المبلغ المدفوع' }) {
  return html`<div class="form-grid">
    <${Field} label=${label} hint="اتركه فارغاً إذا لم تستلم دفعة.">
      <input class="input ltr" type="number" min="0" step="0.01" value=${f.amount_usd} onInput=${(e) => setF({ ...f, amount_usd: e.target.value })} />
    </${Field}>
    <${Field} label="طريقة الدفع">
      <input class="input" list="pay-methods-d" value=${f.method} onInput=${(e) => setF({ ...f, method: e.target.value })} />
      <datalist id="pay-methods-d">${PAYMENT_METHODS.map((m) => html`<option value=${m} />`)}</datalist>
    </${Field}>
    <${Field} full label="ملاحظة"><input class="input" value=${f.note} onInput=${(e) => setF({ ...f, note: e.target.value })} /></${Field}>
  </div>`;
}

function ChangePlanModal({ sys, plans, onClose, onDone }) {
  const options = plans.filter((p) => !p.archived);
  const first = options.find((p) => p.id !== sys.plan_id) || options[0];
  const [planId, setPlanId] = useState(first ? String(first.id) : '');
  const [reset, setReset] = useState(true);
  const [pay, setPay] = useState({ amount_usd: first ? String(first.price_usd) : '', method: '', note: '' });
  const { busy, error, run } = useAction();
  const pick = (id) => {
    setPlanId(id);
    const p = plans.find((x) => String(x.id) === id);
    if (p) setPay({ ...pay, amount_usd: String(p.price_usd) });
  };
  const submit = () =>
    run(async () => {
      await api(`/systems/${sys.id}/change-plan`, { method: 'POST', body: { plan_id: Number(planId), reset_period: reset, ...pay } });
      toast('تم تغيير الباقة');
      onDone();
    });
  return html`<${Modal} title="ترقية أو تغيير الباقة" desc=${`الباقة الحالية: ${sys.plan_name || 'بدون باقة'}`} onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy || !planId}>${busy ? 'جارِ الحفظ…' : 'تأكيد الباقة'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    ${options.length
      ? html`<${Field} label="الباقة الجديدة"><select class="select" value=${planId} onChange=${(e) => pick(e.target.value)}>${planOptions(options)}</select></${Field}>`
      : html`<div class="callout warn">لا توجد باقات — أنشئ باقة أولاً من صفحة الباقات.</div>`}
    <label class="check"><input type="checkbox" checked=${reset} onChange=${(e) => setReset(e.target.checked)} />
      <span>ابدأ شهراً جديداً من اليوم<small>يتصفّر الاستهلاك ويبدأ حد الباقة الجديدة كاملاً لمدة شهر. بدون هذا الخيار يُرفع الحد فوراً على الشهر الحالي ويُحتسب ما استُهلك.</small></span></label>
    <${PaymentFields} f=${pay} setF=${setPay} />
  </${Modal}>`;
}

function TopupModal({ sys, onClose, onDone }) {
  const ratio = sys.plan_price > 0 && sys.plan_limit > 0 ? sys.plan_limit / sys.plan_price : 1;
  const [f, setF] = useState({ credit_usd: '', amount_usd: '', method: '', note: '' });
  const [creditTouched, setCreditTouched] = useState(false);
  const { busy, error, run } = useAction();
  const setPay = (next) => {
    const amount = Number(next.amount_usd);
    if (!creditTouched && amount > 0) next = { ...next, credit_usd: (amount * ratio).toFixed(2) };
    setF(next);
  };
  const submit = () =>
    run(async () => {
      await api(`/systems/${sys.id}/topup`, { method: 'POST', body: f });
      toast('تم شحن الرصيد');
      onDone();
    });
  return html`<${Modal} title="شحن رصيد إضافي" desc="يرفع حد الشهر الحالي فقط، ويعود التطبيق للعمل فوراً إذا كان متوقفاً." onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الشحن…' : 'شحن الرصيد'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <${PaymentFields} f=${f} setF=${setPay} label="المبلغ الذي دفعه العميل" />
    <${Field} label="الرصيد المضاف للحد (بالدولار)" hint=${`مقترح حسب نسبة باقته (${Math.round(ratio * 100)}% من المدفوع). الرصيد الإضافي يُصفَّر مع بداية الشهر الجديد.`}>
      <input class="input ltr" type="number" min="0.01" step="0.01" required value=${f.credit_usd}
        onInput=${(e) => (setCreditTouched(true), setF({ ...f, credit_usd: e.target.value }))} />
    </${Field}>
  </${Modal}>`;
}

function RenewModal({ sys, onClose, onDone }) {
  const [pay, setPay] = useState({ amount_usd: sys.plan_price ? String(sys.plan_price) : '', method: '', note: '' });
  const { busy, error, run } = useAction();
  const submit = () =>
    run(async () => {
      await api(`/systems/${sys.id}/renew`, { method: 'POST', body: pay });
      toast('تم تجديد الاشتراك');
      onDone();
    });
  return html`<${Modal} title="تجديد الاشتراك" desc="يبدأ شهر جديد من اليوم، ويتصفّر الاستهلاك والرصيد الإضافي." onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ التجديد…' : 'تجديد لمدة شهر'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <${PaymentFields} f=${pay} setF=${setPay} />
  </${Modal}>`;
}

function EditModal({ sys, onClose, onDone }) {
  const [f, setF] = useState({
    name: sys.name,
    owner_name: sys.owner_name,
    contact: sys.contact,
    limit_override_usd: sys.limit_override_usd ?? '',
    auto_renew: sys.auto_renew,
    webhook_url: sys.webhook_url,
    notes: sys.notes,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { busy, error, run } = useAction();
  const submit = () =>
    run(async () => {
      await api(`/systems/${sys.id}`, { method: 'PATCH', body: { ...f, limit_override_usd: f.limit_override_usd === '' ? null : f.limit_override_usd } });
      toast('تم حفظ التعديلات');
      onDone();
    });
  return html`<${Modal} title="تعديل التطبيق" onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الحفظ…' : 'حفظ التعديلات'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <div class="form-grid">
      <${Field} full label="اسم التطبيق"><input class="input" required value=${f.name} onInput=${set('name')} /></${Field}>
      <${Field} label="صاحب التطبيق"><input class="input" value=${f.owner_name} onInput=${set('owner_name')} /></${Field}>
      <${Field} label="رقم التواصل أو البريد"><input class="input ltr" value=${f.contact} onInput=${set('contact')} /></${Field}>
      <${Field} full label="حد شهري مخصص (اختياري)" hint=${`يحل محل حد الباقة (${money(sys.plan_limit || 0)}). اتركه فارغاً لاستخدام حد الباقة.`}>
        <input class="input ltr" type="number" min="0" step="0.01" value=${f.limit_override_usd} onInput=${set('limit_override_usd')} />
      </${Field}>
      <div class="full"><label class="check"><input type="checkbox" checked=${f.auto_renew} onChange=${set('auto_renew')} />
        <span>تجديد تلقائي كل شهر</span></label></div>
      <${Field} full label="رابط إشعارات التطبيق (Webhook)" hint="اختياري — نرسل إليه POST عند الوصول لنسبة التنبيه وعند انتهاء الاشتراك، ليعرض التطبيق تنبيهاً لمستخدميه.">
        <input class="input ltr" type="url" placeholder="https://" value=${f.webhook_url} onInput=${set('webhook_url')} />
      </${Field}>
      <${Field} full label="ملاحظات"><textarea class="textarea" value=${f.notes} onInput=${set('notes')}></textarea></${Field}>
    </div>
  </${Modal}>`;
}

function NewKeyModal({ sys, onClose, onCreated }) {
  const [name, setName] = useState('prod');
  const [revoke, setRevoke] = useState(true);
  const { busy, error, run } = useAction();
  const submit = () =>
    run(async () => {
      const r = await api(`/systems/${sys.id}/keys`, { method: 'POST', body: { name, revoke_others: revoke } });
      onCreated(r);
    });
  return html`<${Modal} title="مفتاح جديد" desc="استخدمه عند ضياع المفتاح أو لتغييره دورياً." onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الإنشاء…' : 'إنشاء المفتاح'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <${Field} label="اسم المفتاح" hint="للتمييز فقط، مثل prod أو staging."><input class="input ltr" value=${name} onInput=${(e) => setName(e.target.value)} /></${Field}>
    <label class="check"><input type="checkbox" checked=${revoke} onChange=${(e) => setRevoke(e.target.checked)} />
      <span>إلغاء المفاتيح الحالية<small>المفاتيح القديمة تتوقف فوراً، فحدّث متغيرات التطبيق بعد الإنشاء مباشرة.</small></span></label>
  </${Modal}>`;
}

function statusCallout(s, open) {
  const actions = (...btns) => html`<div class="row" style=${{ marginTop: '8px' }}>${btns}</div>`;
  switch (s.state) {
    case 'limit_reached':
      return html`<div class="callout bad">التطبيق متوقف لأنه وصل للحد الشهري، وطلباته تُرفض برسالة «تم الوصول للحد». رقِّ الباقة أو اشحن رصيداً ليعود فوراً.
        ${actions(html`<button class="btn btn-sm" onClick=${() => open('plan')}>ترقية الباقة</button>`, html`<button class="btn btn-sm" onClick=${() => open('topup')}>شحن رصيد</button>`)}</div>`;
    case 'expired':
      return html`<div class="callout bad">انتهى الاشتراك والتجديد التلقائي غير مفعّل، والطلبات متوقفة.
        ${actions(html`<button class="btn btn-sm" onClick=${() => open('renew')}>تجديد الاشتراك</button>`)}</div>`;
    case 'suspended':
      return html`<div class="callout warn">التطبيق موقوف يدوياً وطلباته تُرفض حتى تفعيله.</div>`;
    case 'no_plan':
      return html`<div class="callout warn">لا توجد باقة لهذا التطبيق، وطلباته تُرفض.
        ${actions(html`<button class="btn btn-sm" onClick=${() => open('plan')}>اختيار باقة</button>`)}</div>`;
    case 'warning':
      return html`<div class="callout warn">استهلك التطبيق ${Math.round(s.usage_pct)}% من حده الشهري — وقت مناسب لعرض الترقية على العميل.</div>`;
    default:
      return null;
  }
}

export function AppPage({ id }) {
  const { tz, warn } = useApp();
  const { data, error, loading, reload } = useData(`/systems/${id}`);
  const [modal, setModal] = useState(null);
  const [reveal, setReveal] = useState(null);
  const { run } = useAction();
  if (loading && !data) return html`<${Loading} />`;
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  const s = data.system;
  const level = levelFor(s.usage_pct, warn, s.state);
  const activeKeys = data.keys.filter((k) => !k.revoked_at);
  const shownKey = activeKeys[0] ? `${activeKeys[0].key_prefix}…${activeKeys[0].key_last4}` : 'sk-gw-…';
  const anthropicModel = data.models?.find((m) => m.provider_kind === 'anthropic' && m.kind === 'chat')?.alias;
  const chatModel = data.models?.find((m) => m.kind === 'chat')?.alias;
  const close = () => setModal(null);
  const done = () => (setModal(null), reload());

  const toggleStatus = () =>
    run(async () => {
      const next = s.status === 'suspended' ? 'active' : 'suspended';
      if (next === 'suspended' && !confirm(`إيقاف «${s.name}»؟ ستُرفض كل طلباته حتى إعادة التفعيل.`)) return;
      await api(`/systems/${s.id}`, { method: 'PATCH', body: { status: next } });
      toast(next === 'active' ? 'تم التفعيل' : 'تم الإيقاف');
      reload();
    }).then(() => {});
  const archive = () =>
    run(async () => {
      if (!confirm(`أرشفة «${s.name}»؟ تُلغى مفاتيحه فوراً ويبقى سجله المالي.`)) return;
      await api(`/systems/${s.id}`, { method: 'DELETE' });
      toast('تمت الأرشفة');
      go('/apps');
    });
  const restore = () =>
    run(async () => {
      await api(`/systems/${s.id}/restore`, { method: 'POST' });
      toast('تمت الاستعادة — أنشئ مفتاحاً جديداً لتشغيله');
      reload();
    });
  const purge = () =>
    run(async () => {
      if (!confirm(`حذف «${s.name}» نهائياً مع سجل طلباته؟ لا يمكن التراجع.`)) return;
      await api(`/systems/${s.id}?purge=1`, { method: 'DELETE' });
      toast('تم الحذف النهائي');
      go('/apps');
    });
  const revokeKey = (k) =>
    run(async () => {
      if (!confirm(`إلغاء المفتاح ${k.key_prefix}…${k.key_last4}؟ أي تطبيق يستخدمه سيتوقف فوراً.`)) return;
      await api(`/systems/${s.id}/keys/${k.id}`, { method: 'DELETE' });
      toast('تم إلغاء المفتاح');
      reload();
    });

  const archived = s.state === 'archived';
  return html`<div>
    <${PageHead} crumb=${{ href: '#/apps', label: 'التطبيقات' }}
      title=${html`<span class="row" style=${{ gap: '12px' }}>${s.name} <${StateBadge} state=${s.state} /></span>`}
      desc=${s.owner_name || s.contact
        ? html`${s.owner_name}${s.owner_name && s.contact ? ' — ' : ''}${s.contact ? html`<bdi>${s.contact}</bdi>` : ''}`
        : null}
      actions=${!archived &&
      html`<button class="btn btn-primary" onClick=${() => setModal('plan')}>ترقية الباقة</button>
        <button class="btn" onClick=${() => setModal('topup')}>شحن رصيد</button>
        <button class="btn" onClick=${() => setModal('renew')}>تجديد</button>
        <button class="btn btn-quiet" onClick=${() => setModal('edit')}>تعديل</button>
        <button class="btn btn-quiet" onClick=${toggleStatus}>${s.status === 'suspended' ? 'تفعيل' : 'إيقاف مؤقت'}</button>`} />

    ${statusCallout(s, setModal) && html`<div style=${{ marginBottom: '18px' }}>${statusCallout(s, setModal)}</div>`}

    <section class="sheet sheet-pad" aria-label="العداد">
      <div class="readout">
        <div class="readout-main">
          <span class="num display">${money(s.spend_usd)}</span>
          <span class="readout-of">من <span class="num">${money(s.limit_usd)}</span> هذا الشهر</span>
        </div>
        <span class="readout-pct num" data-level=${level}>${Math.round(s.usage_pct)}%</span>
      </div>
      <${Meter} large pct=${s.usage_pct} warn=${warn} state=${s.state} label="استهلاك الشهر الحالي" />
      <dl class="kv" style=${{ marginTop: '22px' }}>
        <div><dt>الباقة</dt><dd>${s.plan_name || (s.limit_override_usd != null ? 'حد مخصص' : '—')}${s.plan_price != null ? html` <span class="faint num">${money(s.plan_price)}</span>` : ''}</dd></div>
        <div><dt>الحد الشهري</dt><dd><${Money} v=${s.limit_override_usd ?? s.plan_limit ?? 0} />${s.extra_credit_usd > 0 ? html` + <${Money} v=${s.extra_credit_usd} /> رصيد` : ''}</dd></div>
        <div><dt>المتبقي</dt><dd><${Money} v=${s.remaining_usd} /></dd></div>
        <div><dt>الدورة الحالية</dt><dd>${dayMonth(s.period_start, tz)} — ${date(s.period_end, tz)}</dd></div>
        <div><dt>${s.auto_renew ? 'تتجدد تلقائياً بعد' : 'تنتهي بعد'}</dt><dd>${s.days_left > 0 ? daysCount(s.days_left) : 'اليوم'}</dd></div>
        <div><dt>طلبات الدورة</dt><dd><span class="num">${int(data.totals.requests)}</span>${data.totals.errors ? html` <span class="faint small">(${int(data.totals.errors)} مرفوض/فاشل)</span>` : ''}</dd></div>
        <div><dt>توكنز الدورة</dt><dd><span class="num">${compact(data.totals.input_tokens)}</span> دخل، <span class="num">${compact(data.totals.output_tokens)}</span> خرج</dd></div>
        <div><dt>آخر استخدام</dt><dd>${ago(s.last_used_at)}</dd></div>
      </dl>
    </section>

    <section class="sheet section-gap" aria-label="ربط التطبيق">
      <div class="sheet-head">
        <div><h2>ربط التطبيق</h2><p>المتغيرات التي توضع في إعدادات التطبيق مكان مفتاح المزوّد الأصلي.</p></div>
        ${!archived && html`<button class="btn btn-sm" onClick=${() => setModal('key')}>مفتاح جديد</button>`}
      </div>
      <div class="sheet-pad stack">
        <${CodeTabs} tabs=${envTabs({ baseUrl: data.base_url, apiKey: shownKey, anthropicModel, model: chatModel })} />
        <p class="small faint">المفتاح يظهر مختصراً هنا لأنه محفوظ مشفّراً باتجاه واحد. إذا لم يكن محفوظاً لديك، أنشئ مفتاحاً جديداً.</p>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>المفتاح</th><th>الاسم</th><th>أُنشئ</th><th>آخر استخدام</th><th>الحالة</th><th></th></tr></thead>
            <tbody>
              ${data.keys.map(
                (k) => html`<tr>
                  <td><${KeyChip} prefix=${k.key_prefix} last4=${k.key_last4} /></td>
                  <td class="ltr">${k.name}</td>
                  <td>${date(k.created_at, tz)}</td>
                  <td>${ago(k.last_used_at)}</td>
                  <td>${k.revoked_at ? html`<span class="badge dim">ملغى</span>` : html`<span class="badge ok">فعّال</span>`}</td>
                  <td class="end">${!k.revoked_at && html`<button class="btn btn-sm btn-danger" onClick=${() => revokeKey(k)}>إلغاء</button>`}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <div class="cols-even section-gap">
      <section class="sheet sheet-pad" aria-label="الاستهلاك اليومي">
        <h2>الاستهلاك اليومي</h2>
        <p class="small muted">تكلفة آخر 30 يوماً بسعر المزوّد</p>
        <${BarChart} data=${data.daily} extra=${(x) => `${int(x.requests)} طلب`} />
      </section>
      <section class="sheet" aria-label="حسب الموديل">
        <div class="sheet-head"><div><h2>حسب الموديل</h2><p>الدورة الحالية</p></div></div>
        ${data.by_model.length
          ? html`<div class="table-wrap"><table class="table">
              <thead><tr><th class="first">الموديل</th><th class="end">طلبات</th><th class="end">توكنز دخل/خرج</th><th class="end last">التكلفة</th></tr></thead>
              <tbody>${data.by_model.map(
                (m) => html`<tr><td class="first ltr">${m.model}</td><td class="end num">${int(m.requests)}</td>
                  <td class="end"><span class="num">${compact(m.input_tokens)}</span> / <span class="num">${compact(m.output_tokens)}</span></td>
                  <td class="end last"><${Money} v=${m.cost} /></td></tr>`,
              )}</tbody></table></div>`
          : html`<p class="sheet-pad small muted">لا توجد طلبات في هذه الدورة.</p>`}
      </section>
    </div>

    <section class="sheet section-gap" aria-label="آخر الطلبات">
      <div class="sheet-head"><h2>آخر الطلبات</h2><a class="btn btn-sm btn-quiet" href=${`#/logs?system_id=${s.id}`}>السجل الكامل</a></div>
      ${data.logs.length
        ? html`<${LogTable} logs=${data.logs.slice(0, 15)} tz=${tz} />`
        : html`<p class="sheet-pad small muted">لم يرسل التطبيق أي طلب بعد. جرّب أمر «تجربة سريعة» في قسم الربط.</p>`}
    </section>

    <div class="cols-even section-gap">
      <section class="sheet" aria-label="المدفوعات">
        <div class="sheet-head"><h2>المدفوعات</h2></div>
        ${data.payments.length
          ? html`<ul class="list feed">${data.payments.map(
              (p) => html`<li><span><${Money} v=${p.amount_usd} /> ${PAYMENT_KINDS[p.kind] || p.kind}${p.method ? ` — ${p.method}` : ''}${p.credit_usd ? html` <span class="faint">(رصيد <${Money} v=${p.credit_usd} />)</span>` : ''}${p.note ? html`<div class="tiny faint">${p.note}</div>` : ''}</span>
                <time>${date(p.paid_at, tz)}</time></li>`,
            )}</ul>`
          : html`<p class="sheet-pad small muted">لا توجد مدفوعات مسجلة.</p>`}
      </section>
      <section class="sheet" aria-label="النشاط">
        <div class="sheet-head"><h2>النشاط</h2></div>
        ${data.events.length
          ? html`<ul class="list feed">${data.events.map((e) => html`<li><span>${e.message}${e.actor && e.actor !== 'system' ? html` <span class="faint tiny">— ${e.actor}</span>` : ''}</span><time>${dateTime(e.created_at, tz)}</time></li>`)}</ul>`
          : html`<p class="sheet-pad small muted">لا يوجد نشاط.</p>`}
      </section>
    </div>

    <section class="sheet sheet-pad section-gap spread" aria-label="الأرشفة">
      <div><h3>${archived ? 'التطبيق مؤرشف' : 'أرشفة التطبيق'}</h3>
        <p class="small muted">${archived ? 'مفاتيحه ملغاة. يمكنك استعادته أو حذفه نهائياً مع سجل طلباته.' : 'تُلغى مفاتيحه فوراً وتبقى مدفوعاته في التقارير المالية.'}</p></div>
      <div class="row">
        ${archived
          ? html`<button class="btn" onClick=${restore}>استعادة</button><button class="btn btn-danger" onClick=${purge}>حذف نهائي</button>`
          : html`<button class="btn btn-danger" onClick=${archive}>أرشفة</button>`}
      </div>
    </section>

    ${modal === 'plan' && html`<${ChangePlanModal} sys=${s} plans=${data.plans} onClose=${close} onDone=${done} />`}
    ${modal === 'topup' && html`<${TopupModal} sys=${s} onClose=${close} onDone=${done} />`}
    ${modal === 'renew' && html`<${RenewModal} sys=${s} onClose=${close} onDone=${done} />`}
    ${modal === 'edit' && html`<${EditModal} sys=${s} onClose=${close} onDone=${done} />`}
    ${modal === 'key' && html`<${NewKeyModal} sys=${s} onClose=${close} onCreated=${(r) => (setModal(null), setReveal(r), reload())} />`}
    ${reveal && html`<${KeyRevealModal} title="المفتاح الجديد جاهز" apiKey=${reveal.api_key} baseUrl=${reveal.base_url} models=${reveal.models} onClose=${() => setReveal(null)} />`}
  </div>`;
}

const ERROR_LABELS = {
  budget_exceeded: 'وصل للحد الشهري',
  subscription_expired: 'الاشتراك منتهي',
  system_suspended: 'التطبيق موقوف',
  no_active_plan: 'بدون باقة',
  model_not_allowed: 'الموديل خارج الباقة',
  model_not_found: 'موديل غير معروف',
  rate_limit_exceeded: 'تجاوز حد الطلبات في الدقيقة',
  upstream_auth_error: 'المزوّد رفض مفتاح المنصة',
  upstream_rate_limited: 'المزوّد مشغول (429)',
  upstream_error: 'خطأ لدى المزوّد',
  upstream_unreachable: 'تعذر الوصول للمزوّد',
  upstream_not_found: 'المزوّد لا يعرف الموديل',
  upstream_invalid_request: 'طلب غير صالح',
  invalid_model_type: 'نوع موديل غير مناسب',
  endpoint_not_supported: 'المسار لا يدعم هذا الموديل',
  provider_unavailable: 'المزوّد معطّل',
};
function errorLabel(err) {
  const [code, ...rest] = String(err).split(':');
  const label = ERROR_LABELS[code.trim()];
  if (!label) return err;
  const detail = rest.join(':').trim();
  return detail ? `${label} — ${detail}` : label;
}

export function LogTable({ logs, tz, showApp = false }) {
  return html`<div class="table-wrap"><table class="table">
    <thead><tr>
      <th class="first">الوقت</th>${showApp && html`<th>التطبيق</th>`}<th>الموديل</th><th>النوع</th>
      <th class="end">توكنز دخل</th><th class="end">خرج</th><th class="end">التكلفة</th><th class="end">المدة</th><th class="last">النتيجة</th>
    </tr></thead>
    <tbody>${logs.map(
      (l) => html`<tr>
        <td class="first nowrap" title=${l.request_id}>${dateTime(l.created_at, tz)}</td>
        ${showApp && html`<td>${l.system_id ? html`<a href=${`#/apps/${l.system_id}`}>${l.system_name || `#${l.system_id}`}</a>` : '—'}</td>`}
        <td class="ltr">${l.model_alias || '—'}${l.note ? html`<div class="tiny faint">${l.note}</div>` : ''}</td>
        <td class="small">${ENDPOINTS[l.endpoint] || l.endpoint}${l.stream ? html` <span class="faint">stream</span>` : ''}</td>
        <td class="end num">${int(l.input_tokens + l.cached_tokens + l.cache_write_tokens)}${l.cached_tokens ? html`<div class="tiny faint">${compact(l.cached_tokens)} من الكاش</div>` : ''}</td>
        <td class="end num">${int(l.output_tokens)}</td>
        <td class="end"><${Money} v=${l.cost_usd} />${l.estimated ? html`<div class="tiny faint" title="المزوّد لم يرسل الاستهلاك (اتصال مقطوع)، فتم التقدير">تقديري</div>` : ''}</td>
        <td class="end num">${l.latency_ms != null ? `${(l.latency_ms / 1000).toFixed(1)}s` : '—'}</td>
        <td class="last">${l.status < 400
          ? html`<span class="badge ok plain">نجح</span>`
          : l.status === 499
            ? html`<span class="badge dim plain">أُلغي</span><div class="tiny faint">التطبيق قطع الاتصال</div>`
            : html`<span class="badge bad plain"><span class="num">${l.status}</span></span>${l.error ? html`<div class="err" title=${l.error}>${errorLabel(l.error)}</div>` : ''}`}</td>
      </tr>`,
    )}</tbody>
  </table></div>`;
}
