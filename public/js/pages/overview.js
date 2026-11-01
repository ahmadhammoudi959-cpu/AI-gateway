import { html, useData, useApp, money, int, compact, monthLabel, ago, daysPhrase } from '../lib.js';
import { PageHead, Loading, ErrorBox, Empty, BarChart, HBars, Icon, StateBadge } from '../ui.js';
import { AppRow } from './apps.js';

function SetupSteps({ setup }) {
  const steps = [
    { done: setup.providers > 0, title: 'أضف مفتاح مزوّد', text: 'مفتاح Anthropic أو OpenAI الذي اشتريتموه — يُحفظ مشفّراً ولا تراه التطبيقات.', href: '#/providers?new=1', cta: 'إضافة مزوّد' },
    { done: setup.models > 0, title: 'فعّل الموديلات وأسعارها', text: 'الأسعار المرجعية تُملأ تلقائياً ويمكن تعديلها.', href: '#/models', cta: 'الموديلات' },
    { done: setup.plans > 0, title: 'أنشئ الباقات', text: 'سعر الاشتراك الشهري وحد الاستهلاك لكل باقة.', href: '#/plans?new=1', cta: 'إنشاء باقة' },
    { done: setup.systems > 0, title: 'اربط أول تطبيق', text: 'تحصل على مفتاح ومتغيرين يوضعان مكان مفتاح Anthropic.', href: '#/apps?new=1', cta: 'إضافة تطبيق' },
  ];
  if (steps.every((s) => s.done)) return null;
  const next = steps.findIndex((s) => !s.done);
  return html`<section class="sheet" style=${{ marginBottom: '22px' }} aria-label="خطوات التشغيل">
    <div class="sheet-head"><div><h2>تشغيل المنصة</h2><p>أربع خطوات وتبدأ التطبيقات في استخدام مفاتيحكم.</p></div></div>
    <ol class="steps">
      ${steps.map(
        (s, i) => html`<li class=${s.done ? 'done' : ''}>
          <h3>${s.title}</h3><p>${s.text}</p>
          ${!s.done && html`<a class=${`btn btn-sm ${i === next ? 'btn-primary' : ''}`} href=${s.href} style=${{ alignSelf: 'flex-start' }}>${s.cta}</a>`}
        </li>`,
      )}
    </ol>
  </section>`;
}

function attentionText(s) {
  switch (s.state) {
    case 'warning':
      return html`استهلك <span class="num">${Math.round(s.usage_pct)}%</span> — مرشح للترقية`;
    case 'limit_reached':
      return 'متوقف: وصل للحد الشهري';
    case 'expired':
      return 'متوقف: الاشتراك منتهي';
    case 'suspended':
      return 'موقوف يدوياً';
    case 'no_plan':
      return 'بدون باقة';
    default:
      return `ينتهي ${daysPhrase(Math.max(1, s.days_left))} بدون تجديد تلقائي`;
  }
}

export function OverviewPage() {
  const { tz, warn } = useApp();
  const { data, error, loading, reload } = useData('/overview');
  if (loading && !data) return html`<${Loading} />`;
  if (error) return html`<${ErrorBox} error=${error} retry=${reload} />`;
  const d = data;
  const m = d.month;
  const month = monthLabel(d.today.slice(0, 7));
  return html`<div>
    <${PageHead} title="نظرة عامة" desc=${month}
      actions=${html`<a class="btn btn-primary" href="#/apps?new=1"><${Icon} name="plus" />إضافة تطبيق</a>`} />

    <${SetupSteps} setup=${d.setup} />

    <section class="sheet sheet-pad" aria-label="أرباح الشهر">
      <div class="equation">
        <div class="eq-result">
          <span class="label">صافي ربح ${month}</span>
          <span class=${`num display ${m.profit < 0 ? 'negative' : ''}`}>${money(m.profit)}</span>
        </div>
        <div class="eq-terms" aria-label="التحصيل ناقص تكلفة الاستهلاك">
          <span class="term"><span class="num">${money(m.revenue)}</span>تحصيل</span>
          <span class="op" aria-hidden="true">−</span>
          <span class="term"><span class="num">${money(m.cost)}</span>تكلفة الاستهلاك عند المزوّدين</span>
        </div>
      </div>
      <div class="eq-foot">
        <span>الشهر السابق <span class="num">${money(d.prev_month.profit)}</span></span>
        <span>اشتراكات شهرية فعّالة <span class="num">${money(d.mrr)}</span></span>
        <span>طلبات هذا الشهر <span class="num">${int(m.requests)}</span></span>
        <span>توكنز <span class="num">${compact(m.tokens)}</span></span>
      </div>
      <${BarChart} data=${d.daily} label="تكلفة الاستهلاك اليومية آخر 30 يوماً" extra=${(x) => `${int(x.requests)} طلب`} />
    </section>

    <div class="cols section-gap">
      <section class="sheet" aria-label="عدادات التطبيقات">
        <div class="sheet-head">
          <div><h2>عدادات التطبيقات</h2><p>الاستهلاك مقابل الحد الشهري لكل تطبيق</p></div>
          <a class="btn btn-sm btn-quiet" href="#/apps">كل التطبيقات</a>
        </div>
        ${d.systems.length
          ? html`<div class="ledger">${d.systems.slice(0, 12).map((s) => html`<${AppRow} s=${s} warn=${warn} />`)}</div>`
          : html`<${Empty} title="لا توجد تطبيقات مربوطة" text="بعد إضافة تطبيق يظهر هنا عداده واستهلاكه." />`}
      </section>

      <div class="stack" style=${{ gap: '22px' }}>
        <section class="sheet" aria-label="تحتاج متابعة">
          <div class="sheet-head"><h2>تحتاج متابعة</h2></div>
          ${d.attention.length
            ? html`<ul class="list attention">
                ${d.attention.map(
                  (s) => html`<li><div><a href=${`#/apps/${s.id}`}>${s.name}</a><div class="small muted">${attentionText(s)}</div></div>
                    <${StateBadge} state=${s.state} /></li>`,
                )}
              </ul>`
            : html`<p class="sheet-pad small muted">كل التطبيقات ضمن حدودها.</p>`}
        </section>

        <section class="sheet" aria-label="الموديلات الأعلى تكلفة">
          <div class="sheet-head"><h2>الأعلى تكلفة هذا الشهر</h2></div>
          <div class="sheet-pad">
            ${d.by_model.length
              ? html`<${HBars} items=${d.by_model.map((x) => ({ label: x.model, value: x.cost }))} />`
              : html`<p class="small muted">لا يوجد استهلاك بعد.</p>`}
          </div>
        </section>

        <section class="sheet" aria-label="آخر الأحداث">
          <div class="sheet-head"><h2>آخر الأحداث</h2></div>
          ${d.events.length
            ? html`<ul class="list feed">
                ${d.events.slice(0, 6).map(
                  (e) => html`<li><span>${e.system_name && e.system_id ? html`<a href=${`#/apps/${e.system_id}`}>${e.system_name}</a>: ` : ''}${e.message}</span>
                    <time datetime=${e.created_at} title=${new Date(e.created_at).toLocaleString('ar-EG-u-nu-latn', { timeZone: tz })}>${ago(e.created_at)}</time></li>`,
                )}
              </ul>`
            : html`<p class="sheet-pad small muted">لا توجد أحداث بعد.</p>`}
        </section>
      </div>
    </div>
  </div>`;
}
