import { html, useState, api, useData, toast } from '../lib.js';
import { PageHead, Loading, ErrorBox, Empty, Modal, Field, FormError, useAction, Icon } from '../ui.js';
import { ImportModal } from './providers.js';

const KIND = { chat: 'محادثة', embedding: 'Embeddings', image: 'صور' };
const p6 = (v) => (v == null ? '' : String(v));

function ModelModal({ model, providers, models, presets, onClose, onDone }) {
  const editing = !!model;
  const [f, setF] = useState({
    alias: model?.alias || '',
    provider_id: String(model?.provider_id || providers[0]?.id || ''),
    upstream_model: model?.upstream_model || '',
    kind: model?.kind || 'chat',
    input_price: p6(model?.input_price ?? ''),
    output_price: p6(model?.output_price ?? ''),
    cached_input_price: p6(model?.cached_input_price),
    cache_write_price: p6(model?.cache_write_price),
    request_price: p6(model?.request_price ?? ''),
    long_context_threshold: p6(model?.long_context_threshold),
    long_input_price: p6(model?.long_input_price),
    long_output_price: p6(model?.long_output_price),
    default_max_tokens: p6(model?.default_max_tokens),
    fallback_model_id: p6(model?.fallback_model_id),
    enabled: model ? model.enabled : true,
    notes: model?.notes || '',
    sort_order: p6(model?.sort_order ?? 0),
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const provider = providers.find((p) => String(p.id) === f.provider_id);
  const suggestions = (presets[provider?.preset] || []).map((x) => x.upstream);
  const applyPreset = (upstream) => {
    const pr = (presets[provider?.preset] || []).find((x) => x.upstream === upstream);
    if (!pr) return setF({ ...f, upstream_model: upstream });
    setF({
      ...f,
      upstream_model: upstream,
      alias: f.alias || upstream,
      kind: pr.kind,
      input_price: p6(pr.in),
      output_price: p6(pr.out),
      cached_input_price: p6(pr.cached),
      cache_write_price: p6(pr.write),
      long_context_threshold: p6(pr.long?.threshold),
      long_input_price: p6(pr.long?.in),
      long_output_price: p6(pr.long?.out),
      default_max_tokens: p6(pr.max_tokens),
    });
  };
  const { busy, error, run } = useAction();
  const nul = (v) => (v === '' ? null : v);
  const submit = () =>
    run(async () => {
      const body = {
        ...f,
        provider_id: Number(f.provider_id),
        cached_input_price: nul(f.cached_input_price),
        cache_write_price: nul(f.cache_write_price),
        long_context_threshold: nul(f.long_context_threshold),
        long_input_price: nul(f.long_input_price),
        long_output_price: nul(f.long_output_price),
        default_max_tokens: nul(f.default_max_tokens),
        fallback_model_id: nul(f.fallback_model_id),
        input_price: f.input_price || 0,
        output_price: f.output_price || 0,
        request_price: f.request_price || 0,
        sort_order: f.sort_order || 0,
      };
      if (editing) await api(`/models/${model.id}`, { method: 'PATCH', body });
      else await api('/models', { method: 'POST', body });
      toast(editing ? 'تم حفظ الموديل' : 'تمت إضافة الموديل');
      onDone();
    });
  return html`<${Modal} wide title=${editing ? `تعديل ${model.alias}` : 'إضافة موديل'} onClose=${onClose} onSubmit=${submit}
    desc="الأسعار بالدولار لكل مليون توكن — تكلفتكم عند المزوّد، وعليها يُحتسب استهلاك التطبيقات."
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الحفظ…' : 'حفظ الموديل'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <div class="form-grid">
      <${Field} label="المزوّد"><select class="select" value=${f.provider_id} onChange=${set('provider_id')}>
        ${providers.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select></${Field}>
      <${Field} label="معرّف الموديل لدى المزوّد" hint="كما في توثيق المزوّد، مثل claude-sonnet-5-5.">
        <input class="input ltr" required list="up-models" value=${f.upstream_model} onChange=${(e) => applyPreset(e.target.value)} onInput=${set('upstream_model')} />
        <datalist id="up-models">${suggestions.map((s) => html`<option value=${s} />`)}</datalist>
      </${Field}>
      <${Field} label="الاسم الذي تستخدمه التطبيقات" hint="اتركه مطابقاً لمعرّف المزوّد حتى لا تُعدَّل التطبيقات، أو اختر اسماً خاصاً مثل smart.">
        <input class="input ltr" required value=${f.alias} onInput=${set('alias')} />
      </${Field}>
      <${Field} label="النوع"><select class="select" value=${f.kind} onChange=${set('kind')}>
        <option value="chat">محادثة / نصوص</option><option value="embedding">Embeddings</option><option value="image">توليد صور</option></select></${Field}>
      <${Field} label="سعر الدخل (لكل مليون توكن)"><input class="input ltr" type="number" min="0" step="any" value=${f.input_price} onInput=${set('input_price')} /></${Field}>
      <${Field} label="سعر الخرج (لكل مليون توكن)"><input class="input ltr" type="number" min="0" step="any" value=${f.output_price} onInput=${set('output_price')} /></${Field}>
      <${Field} label="سعر الدخل من الكاش" hint="اتركه فارغاً ليساوي سعر الدخل."><input class="input ltr" type="number" min="0" step="any" value=${f.cached_input_price} onInput=${set('cached_input_price')} /></${Field}>
      <${Field} label="سعر كتابة الكاش (Claude)" hint="فارغ = 1.25 × سعر الدخل."><input class="input ltr" type="number" min="0" step="any" value=${f.cache_write_price} onInput=${set('cache_write_price')} /></${Field}>
    </div>
    <details class="advanced">
      <summary>إعدادات متقدمة</summary>
      <div class="form-grid">
        <${Field} label="سعر ثابت لكل طلب/صورة" hint="للموديلات التي تُحاسَب بالصورة."><input class="input ltr" type="number" min="0" step="any" value=${f.request_price} onInput=${set('request_price')} /></${Field}>
        <${Field} label="أقصى توكنز خرج افتراضي" hint="لطلبات Claude التي لا تحدد max_tokens. فارغ = 16384."><input class="input ltr" type="number" min="1" step="1" value=${f.default_max_tokens} onInput=${set('default_max_tokens')} /></${Field}>
        <${Field} label="سعر أعلى بعد حجم سياق (توكنز)" hint="مثل Gemini Pro فوق 200 ألف."><input class="input ltr" type="number" min="1" step="1" value=${f.long_context_threshold} onInput=${set('long_context_threshold')} /></${Field}>
        <div class="row" style=${{ alignItems: 'flex-end' }}>
          <${Field} label="دخل (سياق طويل)"><input class="input ltr" type="number" min="0" step="any" value=${f.long_input_price} onInput=${set('long_input_price')} /></${Field}>
          <${Field} label="خرج (سياق طويل)"><input class="input ltr" type="number" min="0" step="any" value=${f.long_output_price} onInput=${set('long_output_price')} /></${Field}>
        </div>
        <${Field} label="موديل بديل عند العطل" hint="إذا فشل المزوّد (عطل أو ضغط) يُحوَّل الطلب تلقائياً للبديل.">
          <select class="select" value=${f.fallback_model_id} onChange=${set('fallback_model_id')}>
            <option value="">بدون</option>
            ${models.filter((m) => m.id !== model?.id && m.kind === f.kind).map((m) => html`<option value=${m.id}>${m.alias}</option>`)}
          </select>
        </${Field}>
        <${Field} label="الترتيب"><input class="input ltr" type="number" step="1" value=${f.sort_order} onInput=${set('sort_order')} /></${Field}>
        <${Field} full label="ملاحظات"><input class="input" value=${f.notes} onInput=${set('notes')} /></${Field}>
      </div>
    </details>
    <label class="check"><input type="checkbox" checked=${f.enabled} onChange=${set('enabled')} /><span>مفعّل</span></label>
  </${Modal}>`;
}

function PickProviderModal({ providers, onClose, onPicked }) {
  const [id, setId] = useState(String(providers[0]?.id || ''));
  const { busy, error, run } = useAction();
  const submit = () =>
    run(async () => {
      const r = await api(`/providers/${id}/test`, { method: 'POST' });
      if (!r.test.ok) throw new Error(r.test.message);
      onPicked({ provider: providers.find((p) => String(p.id) === id), items: r.import });
    });
  return html`<${Modal} title="استيراد موديلات" desc="نجلب قائمة الموديلات المتاحة لمفتاحكم مباشرة من المزوّد." onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy || !id}>${busy ? 'جارِ الجلب…' : 'عرض الموديلات'}</button>`}>
    <${FormError} error=${error} />
    <${Field} label="المزوّد"><select class="select" value=${id} onChange=${(e) => setId(e.target.value)}>
      ${providers.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select></${Field}>
  </${Modal}>`;
}

export function ModelsPage() {
  const { data, error, loading, reload } = useData('/models');
  const [modal, setModal] = useState(null);
  const [importing, setImporting] = useState(null);
  const { run } = useAction();
  if (loading && !data) return html`<${Loading} />`;
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  const toggle = (m) => run(async () => (await api(`/models/${m.id}`, { method: 'PATCH', body: { enabled: !m.enabled } }), reload()));
  const remove = (m) =>
    run(async () => {
      if (!confirm(`حذف الموديل «${m.alias}»؟ التطبيقات التي تطلبه ستتلقى «الموديل غير متاح».`)) return;
      await api(`/models/${m.id}`, { method: 'DELETE' });
      toast('تم حذف الموديل');
      reload();
    });
  const noPrice = data.models.filter((m) => m.enabled && !Number(m.input_price) && !Number(m.output_price) && !Number(m.request_price));
  return html`<div>
    <${PageHead} title="الموديلات والأسعار"
      desc=${`الأسعار بالدولار لكل مليون توكن، وهي تكلفتكم عند المزوّد — عليها يُحسب عداد كل تطبيق. الأسعار المرجعية روجعت في ${data.prices_checked_at}؛ راجعها مع صفحة أسعار المزوّد.`}
      actions=${html`${data.providers.length > 0 && html`<button class="btn" onClick=${() => setModal({ pick: true })}>استيراد من مزوّد</button>`}
        <button class="btn btn-primary" disabled=${!data.providers.length} onClick=${() => setModal({ model: null })}><${Icon} name="plus" />إضافة موديل</button>`} />
    ${noPrice.length > 0 &&
    html`<div class="callout warn" style=${{ marginBottom: '16px' }}>موديلات مفعّلة بلا سعر: <span class="ltr">${noPrice.map((m) => m.alias).join('، ')}</span>. استهلاكها لا يُحتسب في العدادات حتى تحدد أسعارها${noPrice.some((m) => m.provider_preset === 'openrouter') ? ' (موديلات OpenRouter تُحاسَب بالتكلفة التي يرسلها المزوّد)' : ''}.</div>`}
    <div class="sheet">
      ${data.models.length
        ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th class="first">الاسم في التطبيقات</th><th>المزوّد</th><th>النوع</th><th class="end">دخل</th><th class="end">كاش</th><th class="end">خرج</th><th>بديل</th><th>الحالة</th><th class="last"></th></tr></thead>
            <tbody>${data.models.map(
              (m) => html`<tr>
                <td class="first ltr"><strong>${m.alias}</strong>${m.upstream_model !== m.alias ? html`<div class="tiny faint">${m.upstream_model}</div>` : ''}</td>
                <td>${m.provider_name}${!m.provider_enabled ? html` <span class="badge dim">معطّل</span>` : ''}</td>
                <td class="small">${KIND[m.kind]}</td>
                <td class="end num">${m.kind === 'image' && Number(m.request_price) ? `$${Number(m.request_price)}/صورة` : `$${Number(m.input_price)}`}</td>
                <td class="end num faint">${m.cached_input_price != null ? `$${Number(m.cached_input_price)}` : '—'}</td>
                <td class="end num">${m.kind === 'embedding' ? '—' : `$${Number(m.output_price)}`}</td>
                <td class="ltr small">${m.fallback_alias || '—'}</td>
                <td>${m.enabled ? html`<span class="badge ok">مفعّل</span>` : html`<span class="badge dim">معطّل</span>`}</td>
                <td class="last"><div class="row" style=${{ justifyContent: 'flex-end', gap: '6px' }}>
                  <button class="btn btn-sm" onClick=${() => setModal({ model: m })}>تعديل</button>
                  <button class="btn btn-sm btn-quiet" onClick=${() => toggle(m)}>${m.enabled ? 'تعطيل' : 'تفعيل'}</button>
                  <button class="btn btn-sm btn-quiet" onClick=${() => remove(m)}>حذف</button>
                </div></td>
              </tr>`,
            )}</tbody></table></div>`
        : html`<${Empty} title="لا توجد موديلات بعد"
            text=${data.providers.length ? 'استورد الموديلات من المزوّد بضغطة، وتُملأ الأسعار المرجعية تلقائياً.' : 'أضف مزوّداً أولاً ثم استورد موديلاته.'}
            action=${data.providers.length
              ? html`<button class="btn btn-primary" onClick=${() => setModal({ pick: true })}>استيراد من مزوّد</button>`
              : html`<a class="btn btn-primary" href="#/providers?new=1">إضافة مزوّد</a>`} />`}
    </div>
    ${modal?.pick && html`<${PickProviderModal} providers=${data.providers} onClose=${() => setModal(null)} onPicked=${(x) => (setModal(null), setImporting(x))} />`}
    ${modal && !modal.pick &&
    html`<${ModelModal} model=${modal.model} providers=${data.providers} models=${data.models} presets=${data.presets}
      onClose=${() => setModal(null)} onDone=${() => (setModal(null), reload())} />`}
    ${importing && html`<${ImportModal} provider=${importing.provider} items=${importing.items} onClose=${() => setImporting(null)} onDone=${() => (setImporting(null), reload())} />`}
  </div>`;
}
