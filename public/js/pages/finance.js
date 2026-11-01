import { html, useState, api, useData, useApp, toast, money, int, date, monthLabel, PAYMENT_KINDS, PAYMENT_METHODS } from '../lib.js';
import { PageHead, Loading, ErrorBox, Empty, Modal, Field, FormError, useAction, PairChart, Money, Icon } from '../ui.js';

const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

function PaymentModal({ apps, onClose, onDone }) {
  const [f, setF] = useState({ system_id: String(apps[0]?.id || ''), amount_usd: '', kind: 'subscription', method: '', note: '', paid_at: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const { busy, error, run } = useAction();
  const submit = () =>
    run(async () => {
      await api('/payments', { method: 'POST', body: { ...f, system_id: Number(f.system_id), paid_at: f.paid_at || null } });
      toast('تم تسجيل الدفعة');
      onDone();
    });
  return html`<${Modal} title="تسجيل دفعة" desc="للمبالغ المستلمة خارج التجديد والشحن (مثل دفعة مقدمة)." onClose=${onClose} onSubmit=${submit}
    footer=${html`<button class="btn btn-primary" disabled=${busy}>${busy ? 'جارِ الحفظ…' : 'تسجيل الدفعة'}</button>
      <button type="button" class="btn btn-quiet" onClick=${onClose}>إلغاء</button>`}>
    <${FormError} error=${error} />
    <div class="form-grid">
      <${Field} full label="التطبيق"><select class="select" value=${f.system_id} onChange=${set('system_id')}>
        ${apps.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select></${Field}>
      <${Field} label="المبلغ (دولار)"><input class="input ltr" type="number" min="0.01" step="0.01" required value=${f.amount_usd} onInput=${set('amount_usd')} /></${Field}>
      <${Field} label="النوع"><select class="select" value=${f.kind} onChange=${set('kind')}>
        ${Object.entries(PAYMENT_KINDS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></${Field}>
      <${Field} label="طريقة الدفع"><input class="input" list="pm-fin" value=${f.method} onInput=${set('method')} />
        <datalist id="pm-fin">${PAYMENT_METHODS.map((m) => html`<option value=${m} />`)}</datalist></${Field}>
      <${Field} label="تاريخ الدفع" hint="فارغ = الآن"><input class="input" type="date" value=${f.paid_at} onInput=${set('paid_at')} /></${Field}>
      <${Field} full label="ملاحظة"><input class="input" value=${f.note} onInput=${set('note')} /></${Field}>
    </div>
  </${Modal}>`;
}

export function FinancePage({ query = {} }) {
  const { tz } = useApp();
  const [month, setMonth] = useState(query.month || '');
  const fin = useData(`/finance${month ? `?month=${month}` : ''}`);
  const pays = useData(`/payments${month ? `?month=${month}` : ''}`);
  const apps = useData('/systems');
  const [modal, setModal] = useState(false);
  const { run } = useAction();
  if ((fin.loading && !fin.data) || (pays.loading && !pays.data)) return html`<${Loading} />`;
  if (fin.error) return html`<${ErrorBox} error=${fin.error} retry=${fin.reload} />`;
  const d = fin.data;
  const cur = d.month;
  const t = d.totals;
  const history = d.history.map((h) => ({ ...h, label: monthLabel(h.month), short: monthLabel(h.month).split(' ')[0] }));
  const reloadAll = () => (fin.reload(), pays.reload());
  const remove = (p) =>
    run(async () => {
      if (!confirm(`حذف دفعة ${money(p.amount_usd)} (${p.system_name})؟`)) return;
      await api(`/payments/${p.id}`, { method: 'DELETE' });
      toast('تم حذف الدفعة');
      reloadAll();
    });
  return html`<div>
    <${PageHead} title="المالية" desc="التحصيل من العملاء مقابل تكلفة الاستهلاك عند المزوّدين، لكل تطبيق ولكل شهر."
      actions=${html`<div class="seg" role="group" aria-label="الشهر">
          <button type="button" onClick=${() => setMonth(shiftMonth(cur, -1))}>الشهر السابق</button>
          <button type="button" aria-pressed="true">${monthLabel(cur)}</button>
          <button type="button" onClick=${() => setMonth(shiftMonth(cur, 1))}>الشهر التالي</button>
        </div>
        <button class="btn btn-primary" disabled=${!apps.data?.systems.length} onClick=${() => setModal(true)}><${Icon} name="plus" />تسجيل دفعة</button>`} />

    <div class="cols">
      <section class="sheet sheet-pad" aria-label="ربح الشهر">
        <div class="equation">
          <div class="eq-result">
            <span class="label">صافي ربح ${monthLabel(cur)}</span>
            <span class=${`num display ${t.profit < 0 ? 'negative' : ''}`}>${money(t.profit)}</span>
          </div>
          <div class="eq-terms">
            <span class="term"><span class="num">${money(t.revenue)}</span>تحصيل</span>
            <span class="op" aria-hidden="true">−</span>
            <span class="term"><span class="num">${money(t.cost)}</span>تكلفة الاستهلاك</span>
          </div>
        </div>
        <div class="eq-foot">
          <span>هامش الربح <span class="num">${t.margin == null ? '—' : `${t.margin}%`}</span></span>
          ${d.unattributed_revenue > 0 && html`<span>منها تحصيل تطبيقات محذوفة <span class="num">${money(d.unattributed_revenue)}</span></span>`}
        </div>
      </section>
      <section class="sheet sheet-pad" aria-label="آخر 6 أشهر">
        <h2 style=${{ marginBottom: '10px' }}>آخر 6 أشهر</h2>
        <${PairChart} data=${history} />
      </section>
    </div>

    <section class="sheet section-gap" aria-label="حسب التطبيق">
      <div class="sheet-head"><div><h2>حسب التطبيق</h2><p>${monthLabel(cur)}</p></div></div>
      ${d.systems.length
        ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th class="first">التطبيق</th><th>الباقة</th><th class="end">طلبات</th><th class="end">تحصيل</th><th class="end">تكلفة</th><th class="end last">ربح</th></tr></thead>
            <tbody>${d.systems.map(
              (s) => html`<tr>
                <td class="first"><a href=${`#/apps/${s.id}`}>${s.name}</a>${s.archived_at ? html` <span class="badge dim">مؤرشف</span>` : ''}</td>
                <td>${s.plan_name || '—'}</td>
                <td class="end num">${int(s.requests)}</td>
                <td class="end"><${Money} v=${s.revenue} /></td>
                <td class="end"><${Money} v=${s.cost} /></td>
                <td class="end last" style=${{ color: s.profit < 0 ? 'var(--red)' : undefined, fontWeight: 500 }}><${Money} v=${s.profit} /></td>
              </tr>`,
            )}</tbody></table></div>`
        : html`<${Empty} title="لا توجد بيانات لهذا الشهر" />`}
    </section>

    <section class="sheet section-gap" aria-label="المدفوعات">
      <div class="sheet-head"><div><h2>المدفوعات</h2><p>الإجمالي <span class="num">${money(pays.data?.total || 0)}</span></p></div></div>
      ${pays.data?.payments.length
        ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th class="first">التاريخ</th><th>التطبيق</th><th>النوع</th><th>الطريقة</th><th class="end">المبلغ</th><th>ملاحظة</th><th>بواسطة</th><th class="last"></th></tr></thead>
            <tbody>${pays.data.payments.map(
              (p) => html`<tr>
                <td class="first nowrap">${date(p.paid_at, tz)}</td>
                <td>${p.system_id ? html`<a href=${`#/apps/${p.system_id}`}>${p.system_name}</a>` : p.system_name}</td>
                <td>${PAYMENT_KINDS[p.kind] || p.kind}${p.credit_usd ? html`<div class="tiny faint">رصيد <${Money} v=${p.credit_usd} /></div>` : ''}</td>
                <td>${p.method || '—'}</td>
                <td class="end"><${Money} v=${p.amount_usd} /></td>
                <td class="small muted">${p.note}</td>
                <td class="small faint">${p.created_by}</td>
                <td class="last end"><button class="btn btn-sm btn-quiet" onClick=${() => remove(p)}>حذف</button></td>
              </tr>`,
            )}</tbody></table></div>`
        : html`<${Empty} title="لا توجد مدفوعات في هذا الشهر" text="الدفعات تُسجَّل تلقائياً عند الإضافة والتجديد والترقية والشحن إذا أدخلت المبلغ." />`}
    </section>
    ${modal && apps.data && html`<${PaymentModal} apps=${apps.data.systems} onClose=${() => setModal(false)} onDone=${() => (setModal(false), reloadAll())} />`}
  </div>`;
}
