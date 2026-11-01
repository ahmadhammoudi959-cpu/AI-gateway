import { html, useState, api, useData, toast, money } from '../lib.js';
import { PageHead, Loading, ErrorBox, Empty, Modal, Field, FormError, useAction, Icon } from '../ui.js';

function PlanModal({ plan, models, onClose, onDone }) {
  const [f, setF] = useState({
    name: plan?.name || '',
    price_usd: plan ? String(plan.price_usd) : '',
    monthly_limit_usd: plan ? String(plan.monthly_limit_usd) : '',
    rpm_limit: plan?.rpm_limit ? String(plan.rpm_limit) : '',
    description: plan?.description || '',
    is_public: plan ? plan.is_public : true,
    sort_order: plan ? String(plan.sort_order) : '0',
    allowed_models: plan?.allowed_models || [],
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const { busy, error, run } = useAction();
  const price = Number(f.price_usd) || 0;
  const limit = Number(f.monthly_limit_usd) || 0;
  const margin = price - limit;
  const toggleModel = (id) =>
    setF({ ...f, allowed_models: f.allowed_models.includes(id) ? f.allowed_models.filter((x) => x !== id) : [...f.allowed_models, id] });
  const submit = () =>
    run(async () => {
      const body = { ...f, rpm_limit: f.rpm_limit === '' ? null : f.rpm_limit, sort_order: f.sort_order || 0 };
      if (plan) await api(`/plans/${plan.id}`, { method: 'PATCH', body });
      else await api('/plans', { method: 'POST', body });
      toast(plan ? 'تم حفظ الباقة' : 'تم إنشاء الباقة');
      onDone();
    });
  return html`<${Modal} title=${plan ? `تعديل باقة «${plan.name}»` : 'باقة جديدة'} onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الحفظ…' : plan ? 'حفظ الباقة' : 'إنشاء الباقة'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <div class="form-grid">
      <${Field} full label="اسم الباقة"><input class="input" required value=${f.name} onInput=${set('name')} placeholder="مثال: الباقة الذهبية" /></${Field}>
      <${Field} label="سعر الاشتراك الشهري" hint="ما يدفعه العميل لكم.">
        <input class="input ltr" type="number" min="0" step="0.01" required value=${f.price_usd} onInput=${set('price_usd')} />
      </${Field}>
      <${Field} label="حد الاستهلاك الشهري" hint="أقصى تكلفة فعلية عند المزوّد، بعدها يتوقف التطبيق.">
        <input class="input ltr" type="number" min="0.01" step="0.01" required value=${f.monthly_limit_usd} onInput=${set('monthly_limit_usd')} />
      </${Field}>
      ${price > 0 &&
      limit > 0 &&
      html`<div class=${`full callout ${margin >= 0 ? 'ok' : 'bad'}`}>
        ${margin >= 0
          ? html`أقل ربح مضمون <span class="num">${money(margin)}</span> شهرياً (<span class="num">${Math.round((margin / price) * 100)}%</span>) حتى لو استهلك العميل الحد بالكامل.`
          : html`الحد أعلى من السعر — قد تخسر حتى <span class="num">${money(-margin)}</span> شهرياً على كل تطبيق في هذه الباقة.`}
      </div>`}
      <${Field} label="حد الطلبات في الدقيقة (اختياري)" hint="يحمي من الاستخدام المفرط. اتركه فارغاً بلا حد.">
        <input class="input ltr" type="number" min="1" step="1" value=${f.rpm_limit} onInput=${set('rpm_limit')} />
      </${Field}>
      <${Field} label="الترتيب"><input class="input ltr" type="number" step="1" value=${f.sort_order} onInput=${set('sort_order')} /></${Field}>
      <${Field} full label="وصف للعملاء" hint="يظهر في صفحة العميل عند عرض الباقات المتاحة للترقية.">
        <textarea class="textarea" value=${f.description} onInput=${set('description')}></textarea>
      </${Field}>
      <div class="full"><label class="check"><input type="checkbox" checked=${f.is_public} onChange=${set('is_public')} />
        <span>تظهر في صفحة العميل ضمن خيارات الترقية</span></label></div>
    </div>
    <details class="advanced" open=${f.allowed_models.length > 0}>
      <summary>الموديلات المسموحة ${f.allowed_models.length ? `(${f.allowed_models.length})` : '(كل الموديلات)'}</summary>
      <p class="small muted" style=${{ marginBottom: '10px' }}>بدون تحديد، تستخدم الباقة كل الموديلات المفعّلة. حدّد لتقييدها (مثلاً الموديلات الأرخص فقط).</p>
      <div class="form-grid">
        ${models.map(
          (m) => html`<label class="check"><input type="checkbox" checked=${f.allowed_models.includes(m.id)} onChange=${() => toggleModel(m.id)} />
            <span class="ltr">${m.alias}${!m.enabled ? html` <small>(معطّل)</small>` : ''}</span></label>`,
        )}
      </div>
    </details>
  </${Modal}>`;
}

export function PlansPage({ query = {} }) {
  const { data, error, loading, reload } = useData('/plans');
  const [modal, setModal] = useState(query.new ? { plan: null } : null);
  const { run } = useAction();
  const remove = (p) =>
    run(async () => {
      if (!confirm(`حذف باقة «${p.name}»؟`)) return;
      const r = await api(`/plans/${p.id}`, { method: 'DELETE' });
      toast(r.archived ? r.message : 'تم حذف الباقة');
      reload();
    });
  if (loading && !data) return html`<${Loading} />`;
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  const names = new Map(data.models.map((m) => [m.id, m.alias]));
  return html`<div>
    <${PageHead} title="الباقات" desc="الباقة = سعر شهري يدفعه العميل + حد لتكلفة الاستهلاك الفعلية. الفرق بينهما هو ربحكم المضمون."
      actions=${html`<button class="btn btn-primary" onClick=${() => setModal({ plan: null })}><${Icon} name="plus" />باقة جديدة</button>`} />
    ${data.plans.length
      ? html`<div class="plans">
          ${data.plans.map((p) => {
            const margin = p.price_usd - p.monthly_limit_usd;
            const costShare = p.price_usd > 0 ? Math.min(100, (p.monthly_limit_usd / p.price_usd) * 100) : 100;
            return html`<article class=${`sheet plan ${p.archived ? 'archived' : ''}`}>
              <div class="spread"><h2>${p.name}</h2>${p.archived ? html`<span class="badge dim">مخفية</span>` : !p.is_public ? html`<span class="badge plain">داخلية</span>` : ''}</div>
              <div class="plan-price"><span class="num">${money(p.price_usd)}</span><small>شهرياً</small></div>
              <div>
                <div class="split" title="الحد من السعر"><i style=${{ inlineSize: `${costShare}%` }}></i></div>
                <div class="spread tiny muted" style=${{ marginTop: '6px' }}>
                  <span>حد الاستهلاك <span class="num">${money(p.monthly_limit_usd)}</span></span>
                  <span>${margin >= 0 ? 'ربح مضمون' : 'خسارة محتملة'} <span class="num">${money(Math.abs(margin))}</span></span>
                </div>
              </div>
              <dl class="kv">
                <div><dt>التطبيقات</dt><dd class="num">${p.systems_count}</dd></div>
                <div><dt>طلبات/دقيقة</dt><dd>${p.rpm_limit ? html`<span class="num">${p.rpm_limit}</span>` : 'بلا حد'}</dd></div>
                <div style=${{ gridColumn: '1 / -1' }}><dt>الموديلات</dt><dd class="small">${p.allowed_models?.length ? p.allowed_models.map((id) => names.get(id) || `#${id}`).join('، ') : 'كل الموديلات المفعّلة'}</dd></div>
              </dl>
              ${p.description && html`<p class="small muted">${p.description}</p>`}
              <div class="row" style=${{ marginTop: 'auto' }}>
                <button class="btn btn-sm" onClick=${() => setModal({ plan: p })}>تعديل</button>
                ${p.archived
                  ? html`<button class="btn btn-sm btn-quiet" onClick=${() => run(async () => (await api(`/plans/${p.id}`, { method: 'PATCH', body: { archived: false } }), reload()))}>إظهار</button>`
                  : html`<button class="btn btn-sm btn-quiet" onClick=${() => remove(p)}>حذف</button>`}
              </div>
            </article>`;
          })}
        </div>`
      : html`<div class="sheet"><${Empty} title="لا توجد باقات بعد"
          text="مثال: باقة 50$ شهرياً بحد استهلاك 35$ — العميل يحصل على شهر من الذكاء الاصطناعي، وتربحون 15$ على الأقل."
          action=${html`<button class="btn btn-primary" onClick=${() => setModal({ plan: null })}>إنشاء أول باقة</button>`} /></div>`}
    ${modal && html`<${PlanModal} plan=${modal.plan} models=${data.models} onClose=${() => setModal(null)} onDone=${() => (setModal(null), reload())} />`}
  </div>`;
}
