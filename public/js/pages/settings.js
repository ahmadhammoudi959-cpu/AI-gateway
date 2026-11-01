import { html, useState, useEffect, api, useData, useApp, toast, date, ago } from '../lib.js';
import { PageHead, Loading, ErrorBox, Field, FormError, useAction } from '../ui.js';

function Section({ title, desc, children, onSubmit, busy, error, submitLabel = 'حفظ' }) {
  return html`<form class="sheet section-gap" onSubmit=${(e) => (e.preventDefault(), onSubmit())}>
    <div class="sheet-head"><div><h2>${title}</h2>${desc && html`<p>${desc}</p>`}</div></div>
    <div class="sheet-pad stack">
      <${FormError} error=${error} />
      ${children}
      <div class="row"><button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الحفظ…' : submitLabel}</button></div>
    </div>
  </form>`;
}

export function SettingsPage() {
  const { admin } = useApp();
  const { data, error, loading, reload } = useData('/settings');
  const [s, setS] = useState(null);
  useEffect(() => {
    if (data) setS({ ...data.settings });
  }, [data]);
  const general = useAction();
  const alerts = useAction();
  const portal = useAction();
  const adminsA = useAction();
  const pw = useAction();
  const [newAdmin, setNewAdmin] = useState({ email: '', name: '', password: '' });
  const [pwForm, setPwForm] = useState({ current: '', password: '' });
  if ((loading && !data) || !s) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`;
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = (action, keys, msg = 'تم الحفظ') =>
    action.run(async () => {
      const body = Object.fromEntries(keys.map((k) => [k, s[k]]));
      await api('/settings', { method: 'PUT', body });
      toast(msg);
      reload();
    });
  const portalUrl = `${(s.public_url || data.detected_url).replace(/\/+$/, '')}/portal`;

  return html`<div>
    <${PageHead} title="الإعدادات" />

    <${Section} title="عام" busy=${general.busy} error=${general.error}
      onSubmit=${() => save(general, ['brand_name', 'support_contact', 'timezone', 'public_url'])}>
      <div class="form-grid">
        <${Field} label="اسم المنصة" hint="يظهر في لوحة التحكم وصفحة العملاء والتنبيهات."><input class="input" required value=${s.brand_name} onInput=${set('brand_name')} /></${Field}>
        <${Field} label="رقم التواصل للعملاء (واتساب)" hint="يظهر في رسالة «انتهى الرصيد» وفي صفحة العميل للترقية."><input class="input ltr" value=${s.support_contact} onInput=${set('support_contact')} placeholder="+20 10 0000 0000" /></${Field}>
        <${Field} label="المنطقة الزمنية" hint="لبداية الأيام والشهور في التقارير."><input class="input ltr" value=${s.timezone} onInput=${set('timezone')} placeholder="Africa/Cairo" /></${Field}>
        <${Field} label="رابط المنصة العام" hint=${`يظهر في متغيرات الربط. فارغ = ${data.detected_url}`}><input class="input ltr" type="url" value=${s.public_url} onInput=${set('public_url')} placeholder="https://ai.example.com" /></${Field}>
      </div>
    </${Section}>

    <${Section} title="التنبيهات" desc="رسالة لكم عند وصول تطبيق لنسبة التنبيه أو للحد، وقبل انتهاء الاشتراكات، وعند رفض مفتاح مزوّد."
      busy=${alerts.busy} error=${alerts.error}
      onSubmit=${() => save(alerts, ['telegram_bot_token', 'telegram_chat_id', 'alert_webhook_url', 'warn_threshold'])}>
      <div class="form-grid">
        <${Field} label="توكن بوت تيليجرام" hint=${s.telegram_bot_token_set ? 'محفوظ — اكتب توكن جديداً لاستبداله.' : 'أنشئ بوتاً من @BotFather وانسخ التوكن.'}>
          <input class="input ltr" type="password" autocomplete="off" value=${s.telegram_bot_token} onInput=${set('telegram_bot_token')}
            placeholder=${s.telegram_bot_token_set ? '••••••••' : '123456:ABC…'} />
        </${Field}>
        <${Field} label="رقم المحادثة (Chat ID)" hint="أرسل رسالة للبوت ثم اعرف الرقم من @userinfobot، أو رقم مجموعة تبدأ بـ -100."><input class="input ltr" value=${s.telegram_chat_id} onInput=${set('telegram_chat_id')} /></${Field}>
        <${Field} label="نسبة التنبيه المبكر (%)" hint="يصلكم تنبيه عند هذه النسبة ثم عند 100%."><input class="input ltr" type="number" min="10" max="99" value=${s.warn_threshold} onInput=${set('warn_threshold')} /></${Field}>
        <${Field} label="Webhook إضافي (اختياري)" hint="نرسل إليه نفس التنبيهات بصيغة JSON."><input class="input ltr" type="url" value=${s.alert_webhook_url} onInput=${set('alert_webhook_url')} placeholder="https://" /></${Field}>
      </div>
      <div class="row">
        <button type="button" class="btn btn-sm" onClick=${() =>
          alerts.run(async () => (await api('/settings/test-alert', { method: 'POST' }), toast('أُرسلت رسالة التجربة')))}>إرسال رسالة تجربة</button>
        ${s.telegram_bot_token_set &&
        html`<button type="button" class="btn btn-sm btn-quiet" onClick=${() =>
          alerts.run(async () => (await api('/settings', { method: 'PUT', body: { clear_telegram_bot_token: true } }), toast('تم حذف التوكن'), reload()))}>حذف التوكن</button>`}
      </div>
    </${Section}>

    <${Section} title="صفحة العميل" busy=${portal.busy} error=${portal.error}
      desc="صفحة يفتحها صاحب التطبيق بمفتاحه ليرى استهلاكه وباقته ويطلب الترقية."
      onSubmit=${() => save(portal, ['portal_show_cost', 'log_retention_days'])}>
      <p class="small">الرابط: <a class="ltr" href=${portalUrl} target="_blank" rel="noopener">${portalUrl}</a></p>
      <label class="check"><input type="checkbox" checked=${s.portal_show_cost} onChange=${set('portal_show_cost')} />
        <span>إظهار المبالغ بالدولار للعميل<small>بدون هذا الخيار يرى العميل نسبة الاستهلاك فقط، فلا تظهر تكلفتكم الفعلية.</small></span></label>
      <${Field} label="مدة حفظ سجل الطلبات (يوم)" hint="الملخصات اليومية والمالية تبقى دائماً.">
        <input class="input ltr" type="number" min="7" max="3650" value=${s.log_retention_days} onInput=${set('log_retention_days')} style=${{ maxWidth: '160px' }} />
      </${Field}>
    </${Section}>

    <form class="sheet section-gap" onSubmit=${(e) => (
      e.preventDefault(),
      adminsA.run(async () => {
        await api('/admins', { method: 'POST', body: newAdmin });
        toast('تمت إضافة المدير');
        setNewAdmin({ email: '', name: '', password: '' });
        reload();
      })
    )}>
      <div class="sheet-head"><div><h2>المديرون</h2><p>من يستطيع الدخول للوحة التحكم.</p></div></div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th class="first">البريد</th><th>الاسم</th><th>آخر دخول</th><th class="last"></th></tr></thead>
        <tbody>${data.admins.map(
          (a) => html`<tr><td class="first ltr">${a.email}</td><td>${a.name}</td><td>${ago(a.last_login_at)}</td>
            <td class="last end">${a.id !== admin.id &&
            html`<button type="button" class="btn btn-sm btn-quiet" onClick=${() =>
              adminsA.run(async () => {
                if (!confirm(`حذف المدير ${a.email}؟`)) return;
                await api(`/admins/${a.id}`, { method: 'DELETE' });
                reload();
              })}>حذف</button>`}</td></tr>`,
        )}</tbody></table></div>
      <div class="sheet-pad stack">
        <${FormError} error=${adminsA.error} />
        <div class="form-grid" style=${{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
          <${Field} label="بريد المدير الجديد"><input class="input ltr" type="email" required value=${newAdmin.email} onInput=${(e) => setNewAdmin({ ...newAdmin, email: e.target.value })} /></${Field}>
          <${Field} label="الاسم"><input class="input" value=${newAdmin.name} onInput=${(e) => setNewAdmin({ ...newAdmin, name: e.target.value })} /></${Field}>
          <${Field} label="كلمة المرور" hint="8 أحرف على الأقل"><input class="input ltr" type="password" minlength="8" required value=${newAdmin.password} onInput=${(e) => setNewAdmin({ ...newAdmin, password: e.target.value })} /></${Field}>
        </div>
        <div class="row"><button class="btn" disabled=${adminsA.busy}>إضافة مدير</button></div>
      </div>
    </form>

    <${Section} title="كلمة المرور" desc=${`حسابك: ${admin.email}`} busy=${pw.busy} error=${pw.error} submitLabel="تغيير كلمة المرور"
      onSubmit=${() =>
        pw.run(async () => {
          await api('/admins/me/password', { method: 'POST', body: pwForm });
          setPwForm({ current: '', password: '' });
          toast('تم تغيير كلمة المرور');
        })}>
      <div class="form-grid">
        <${Field} label="كلمة المرور الحالية"><input class="input ltr" type="password" autocomplete="current-password" required value=${pwForm.current} onInput=${(e) => setPwForm({ ...pwForm, current: e.target.value })} /></${Field}>
        <${Field} label="كلمة المرور الجديدة" hint="8 أحرف على الأقل. تُسجِّل خروج الجلسات الأخرى."><input class="input ltr" type="password" autocomplete="new-password" minlength="8" required value=${pwForm.password} onInput=${(e) => setPwForm({ ...pwForm, password: e.target.value })} /></${Field}>
      </div>
    </${Section}>
  </div>`;
}
