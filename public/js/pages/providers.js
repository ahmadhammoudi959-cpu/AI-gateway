import { html, useState, api, useData, useApp, toast, dateTime, go } from '../lib.js';
import { PageHead, Loading, ErrorBox, Empty, Modal, Field, FormError, useAction, Icon } from '../ui.js';

const KIND_LABEL = { chat: 'محادثة', embedding: 'Embeddings', image: 'صور' };
const priceText = (v) => (v == null || v === '' ? '—' : `$${Number(v)}`);

/** Lets the admin pick which of the provider's models to enable, with reference prices pre-filled. */
export function ImportModal({ provider, items, onClose, onDone }) {
  const initial = new Set(items.filter((m) => m.preset && m.supported && !m.exists && !m.alias_taken).map((m) => m.id));
  const [picked, setPicked] = useState(initial);
  const [showAll, setShowAll] = useState(false);
  const { busy, error, run } = useAction();
  const visible = items.filter((m) => showAll || m.preset || picked.has(m.id));
  const toggle = (id) => {
    const next = new Set(picked);
    next.has(id) ? next.delete(id) : next.add(id);
    setPicked(next);
  };
  const submit = () =>
    run(async () => {
      const chosen = items.filter((m) => picked.has(m.id));
      const r = await api('/models/bulk', {
        method: 'POST',
        body: {
          provider_id: provider.id,
          items: chosen.map((m) => m.preset || { alias: m.id, upstream_model: m.id, kind: m.kind, ...(m.suggested || {}) }),
        },
      });
      toast(`أُضيف ${r.added.length} موديل${r.skipped.length ? `، وتُخطّي ${r.skipped.length} موجود مسبقاً` : ''}`);
      onDone();
    });
  const unknownPicked = items.some((m) => picked.has(m.id) && !m.preset && !m.suggested);
  return html`<${Modal} wide title=${`موديلات ${provider.name}`} onClose=${onClose} onSubmit=${submit}
    desc="اختر الموديلات التي تستخدمها تطبيقاتكم. الأسعار المرجعية (بالدولار لكل مليون توكن) تُملأ تلقائياً ويمكن تعديلها لاحقاً."
    footer=${html`<button class="btn btn-primary" disabled=${busy || !picked.size}>${busy ? 'جارِ الإضافة…' : `إضافة ${picked.size} موديل`}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>لاحقاً</button>`}>
    <${FormError} error=${error} />
    ${unknownPicked && html`<div class="callout warn">بعض الموديلات المختارة بلا سعر مرجعي — ستُضاف بسعر صفر، فحدّد أسعارها من صفحة الموديلات قبل استخدامها حتى يُحتسب الاستهلاك.</div>`}
    <div class="table-wrap"><table class="table">
      <thead><tr><th></th><th>الموديل</th><th>النوع</th><th class="end">دخل</th><th class="end">خرج</th><th></th></tr></thead>
      <tbody>${visible.map(
        (m) => html`<tr>
          <td><input type="checkbox" aria-label=${m.id} checked=${picked.has(m.id)} disabled=${m.exists} onChange=${() => toggle(m.id)} /></td>
          <td class="ltr">${m.id}${m.name && m.name !== m.id ? html`<div class="tiny faint">${m.name}</div>` : ''}</td>
          <td class="small">${KIND_LABEL[m.kind]}${!m.supported ? html` <span class="faint">(غير مدعوم)</span>` : ''}</td>
          <td class="end num">${priceText(m.preset?.input_price ?? m.suggested?.input_price)}</td>
          <td class="end num">${priceText(m.preset?.output_price ?? m.suggested?.output_price)}</td>
          <td class="small faint">${m.exists ? 'مضاف' : m.alias_taken ? 'الاسم مستخدم' : ''}</td>
        </tr>`,
      )}</tbody>
    </table></div>
    ${items.length > visible.length &&
    html`<button type="button" class="link-btn small" onClick=${() => setShowAll(true)}>عرض كل موديلات المزوّد (${items.length})</button>`}
  </${Modal}>`;
}

function ProviderModal({ provider, presets, onClose, onDone }) {
  const editing = !!provider;
  const [preset, setPreset] = useState(provider?.preset || 'anthropic');
  const p = presets.find((x) => x.id === preset) || presets[0];
  const [f, setF] = useState({
    name: provider?.name || '',
    base_url: provider?.base_url || '',
    api_key: '',
    kind: provider?.kind || 'openai',
    extra_headers: provider?.extra_headers ? JSON.stringify(provider.extra_headers) : '',
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { busy, error, run } = useAction();
  const submit = () =>
    run(async () => {
      const body = { ...f, preset, name: f.name || p.name, base_url: f.base_url || p.base_url };
      if (editing) {
        if (!body.api_key) delete body.api_key;
        await api(`/providers/${provider.id}`, { method: 'PATCH', body });
        toast('تم حفظ المزوّد');
        onDone(null);
      } else {
        const r = await api('/providers', { method: 'POST', body });
        toast(r.test.ok ? 'تمت إضافة المزوّد والاتصال ناجح' : 'تمت الإضافة لكن اختبار الاتصال فشل', r.test.ok ? 'info' : 'error');
        onDone(r);
      }
    });
  return html`<${Modal} title=${editing ? `تعديل ${provider.name}` : 'إضافة مزوّد'} onClose=${onClose} onSubmit=${submit}
    desc=${editing ? 'اترك المفتاح فارغاً للإبقاء على الحالي.' : 'المفتاح يُحفظ مشفّراً، ولا يظهر لأي تطبيق.'}
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الحفظ والاختبار…' : editing ? 'حفظ' : 'إضافة واختبار الاتصال'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <${Field} label="المزوّد">
      <select class="select" value=${preset} onChange=${(e) => (setPreset(e.target.value), setF({ ...f, base_url: '', name: '' }))}>
        ${presets.map((x) => html`<option value=${x.id}>${x.name}</option>`)}
      </select>
    </${Field}>
    <${Field} label="مفتاح API" hint=${p.keys_url ? html`من <a href=${p.keys_url} target="_blank" rel="noopener noreferrer">صفحة المفاتيح لدى ${p.name}</a>` : ''}>
      <input class="input ltr" type="password" autocomplete="off" required=${!editing} value=${f.api_key} onInput=${set('api_key')}
        placeholder=${editing ? provider.key_hint : p.key_placeholder} />
    </${Field}>
    <details class="advanced" open=${preset === 'custom'}>
      <summary>إعدادات متقدمة</summary>
      <div class="form-grid">
        <${Field} label="الاسم المعروض"><input class="input" value=${f.name} onInput=${set('name')} placeholder=${p.name} /></${Field}>
        ${preset === 'custom' &&
        html`<${Field} label="صيغة الـ API"><select class="select" value=${f.kind} onChange=${set('kind')}>
          <option value="openai">متوافق مع OpenAI</option><option value="anthropic">Anthropic Messages</option></select></${Field}>`}
        <${Field} full label="رابط الـ API" hint="مثال لخادم داخلي: http://ollama:11434/v1">
          <input class="input ltr" value=${f.base_url} onInput=${set('base_url')} placeholder=${p.base_url || 'https://'} required=${preset === 'custom'} />
        </${Field}>
        <${Field} full label="هيدرز إضافية (JSON)" hint='مثال لـ OpenRouter: {"HTTP-Referer":"https://example.com"}'>
          <input class="input ltr" value=${f.extra_headers} onInput=${set('extra_headers')} />
        </${Field}>
      </div>
    </details>
  </${Modal}>`;
}

export function ProvidersPage({ query = {} }) {
  const { tz } = useApp();
  const { data, error, loading, reload } = useData('/providers');
  const [modal, setModal] = useState(query.new ? { provider: null } : null);
  const [importing, setImporting] = useState(null);
  const [testing, setTesting] = useState(null);
  const { run } = useAction();

  const test = (p, openImport) =>
    run(async () => {
      setTesting(p.id);
      try {
        const r = await api(`/providers/${p.id}/test`, { method: 'POST' });
        toast(r.test.message, r.test.ok ? 'info' : 'error');
        if (r.test.ok && openImport) setImporting({ provider: p, items: r.import });
        reload();
      } finally {
        setTesting(null);
      }
    });
  const remove = (p) =>
    run(async () => {
      if (!confirm(`حذف «${p.name}» وكل موديلاته (${p.models_count})؟ التطبيقات التي تستخدمها ستتوقف عن الوصول إليها.`)) return;
      await api(`/providers/${p.id}`, { method: 'DELETE' });
      toast('تم حذف المزوّد');
      reload();
    });
  const toggle = (p) =>
    run(async () => {
      await api(`/providers/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } });
      reload();
    });

  if (loading && !data) return html`<${Loading} />`;
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  return html`<div>
    <${PageHead} title="المزوّدون" desc="مفاتيح الـ API التي تشترونها من Anthropic وOpenAI وغيرهما. تبقى مشفّرة هنا، والتطبيقات تستخدم مفاتيح المنصة فقط."
      actions=${html`<button class="btn btn-primary" onClick=${() => setModal({ provider: null })}><${Icon} name="plus" />إضافة مزوّد</button>`} />
    <div class="sheet">
      ${data.providers.length
        ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th class="first">المزوّد</th><th>المفتاح</th><th>الموديلات</th><th>آخر اختبار</th><th>الحالة</th><th class="last"></th></tr></thead>
            <tbody>${data.providers.map(
              (p) => html`<tr>
                <td class="first"><strong>${p.name}</strong><div class="tiny faint ltr">${p.base_url}</div></td>
                <td>${p.key_error ? html`<span class="badge bad plain">${p.key_error}</span>` : html`<span class="keychip">${p.key_hint || '—'}</span>`}</td>
                <td><a href="#/models" class="num">${p.models_count}</a></td>
                <td class="small">${p.last_test_at
                  ? html`<span class=${p.last_test_ok ? '' : 'err'}>${p.last_test_ok ? 'ناجح' : p.last_test_message}</span><div class="tiny faint">${dateTime(p.last_test_at, tz)}</div>`
                  : '—'}</td>
                <td>${p.enabled ? html`<span class="badge ok">مفعّل</span>` : html`<span class="badge dim">معطّل</span>`}</td>
                <td class="last"><div class="row" style=${{ justifyContent: 'flex-end', gap: '6px' }}>
                  <button class="btn btn-sm" disabled=${testing === p.id} onClick=${() => test(p, true)}>${testing === p.id ? 'جارِ الاختبار…' : 'اختبار وموديلات'}</button>
                  <button class="btn btn-sm btn-quiet" onClick=${() => setModal({ provider: p })}>تعديل</button>
                  <button class="btn btn-sm btn-quiet" onClick=${() => toggle(p)}>${p.enabled ? 'تعطيل' : 'تفعيل'}</button>
                  <button class="btn btn-sm btn-quiet" onClick=${() => remove(p)}>حذف</button>
                </div></td>
              </tr>`,
            )}</tbody></table></div>`
        : html`<${Empty} title="لا يوجد مزوّد بعد"
            text="ابدأ بمفتاح Anthropic (المستخدم في Star Style مثلاً): من console.anthropic.com ← API Keys ← Create Key، ثم الصقه هنا."
            action=${html`<button class="btn btn-primary" onClick=${() => setModal({ provider: null })}>إضافة مزوّد</button>`} />`}
    </div>
    ${modal &&
    html`<${ProviderModal} provider=${modal.provider} presets=${data.presets} onClose=${() => setModal(null)}
      onDone=${(r) => {
        setModal(null);
        reload();
        if (r?.test?.ok && r.import?.length) setImporting({ provider: r.provider, items: r.import });
      }} />`}
    ${importing &&
    html`<${ImportModal} provider=${importing.provider} items=${importing.items} onClose=${() => setImporting(null)}
      onDone=${() => (setImporting(null), reload(), go('/models'))} />`}
  </div>`;
}
