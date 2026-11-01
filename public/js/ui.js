import { html, useState, useEffect, useRef, money, int, compact, dayLabel, STATES, copyText, useToasts } from './lib.js';

// ───────────── Icons (1.6px strokes, 18px) ─────────────
const P = {
  overview: 'M4 15a8 8 0 0 1 16 0 M12 15l4-5 M4 19h16',
  apps: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  plans: 'M4 7h16v10H4z M8 7v10 M12 11h4 M12 14h2',
  providers: 'M14 10a4 4 0 1 0-3.5 4L9 15.5V18H6.5V20H4v-2.5l6.2-6.2 M15 7.5h.01',
  models: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  logs: 'M5 5h14 M5 10h14 M5 15h10 M5 20h6',
  finance: 'M4 7h16v12H4z M4 11h16 M16 15h1',
  settings: 'M5 7h9 M18 7h1 M16 5v4 M5 17h2 M11 17h8 M9 15v4 M5 12h5 M14 12h5 M12 10v4',
  plus: 'M12 5v14 M5 12h14',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  back: 'M9 6l6 6-6 6',
  copy: 'M9 9h10v10H9z M5 15V5h10',
};
export function Icon({ name, size = 18 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[name]} /></svg>`;
}

export function BrandMark({ size = 28 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="var(--ink)" />
    <path d="M7 21a9 9 0 0 1 18 0" fill="none" stroke="var(--sheet)" stroke-width="2.2" stroke-linecap="round" opacity=".35" />
    <path d="M7 21a9 9 0 0 1 13.4-7.8" fill="none" stroke="var(--jade)" stroke-width="2.2" stroke-linecap="round" />
    <path d="M16 21l5-6" stroke="var(--sheet)" stroke-width="2.2" stroke-linecap="round" />
    <circle cx="16" cy="21" r="1.8" fill="var(--sheet)" />
  </svg>`;
}

// ───────────── Meter ─────────────
export function levelFor(pct, warn = 80, state) {
  if (state === 'suspended' || state === 'archived') return 'off';
  if (state === 'expired' || state === 'limit_reached' || pct >= 100) return 'over';
  if (pct >= warn) return 'warn';
  return 'ok';
}

export function Meter({ pct = 0, warn = 80, state, large = false, label }) {
  const level = levelFor(pct, warn, state);
  const shown = Math.max(0, Math.min(100, Number(pct) || 0));
  return html`<div class=${`meter ${large ? 'meter-lg' : ''}`} data-level=${level} style=${{ '--pct': shown, '--warn': warn }}
      role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(shown)} aria-label=${label || 'نسبة الاستهلاك'}>
    <div class="meter-bar">
      <div class="meter-track"><div class="meter-fill"></div></div>
      <span class="meter-warn" title=${`تنبيه عند ${warn}%`}></span>
    </div>
    ${large &&
    html`<div class="meter-scale" aria-hidden="true">
      <span style=${{ insetInlineStart: '0%' }}>0</span>
      <span style=${{ insetInlineStart: '50%' }}>50%</span>
      <span style=${{ insetInlineStart: `${warn}%` }}>${warn}%</span>
      <span class="cut" style=${{ insetInlineStart: '100%' }}>توقف</span>
    </div>`}
  </div>`;
}

export function StateBadge({ state }) {
  const s = STATES[state] || { label: state, tone: '' };
  return html`<span class=${`badge ${s.tone}`}>${s.label}</span>`;
}

export const Money = ({ v, sign }) => html`<span class="num">${money(v, { sign })}</span>`;
export const Num = ({ v, c }) => html`<span class="num">${c ? compact(v) : int(v)}</span>`;

// ───────────── Layout helpers ─────────────
export function PageHead({ title, desc, actions, crumb }) {
  return html`<header class="page-head">
    <div>
      ${crumb && html`<a class="crumb" href=${crumb.href}><${Icon} name="back" size=${16} />${crumb.label}</a>`}
      <h1>${title}</h1>
      ${desc && html`<p>${desc}</p>`}
    </div>
    ${actions && html`<div class="row">${actions}</div>`}
  </header>`;
}

export const Loading = () => html`<div class="loading">جارِ التحميل…</div>`;
export const ErrorBox = ({ error, retry }) =>
  html`<div class="sheet error-box">${error} ${retry && html` <button class="link-btn" onClick=${retry}>إعادة المحاولة</button>`}</div>`;

export function Empty({ title, text, action }) {
  return html`<div class="empty"><h3>${title}</h3>${text && html`<p>${text}</p>`}${action}</div>`;
}

export function Seg({ value, onChange, options, label }) {
  return html`<div class="seg" role="group" aria-label=${label}>
    ${options.map(
      (o) => html`<button type="button" aria-pressed=${String(value === o.value)} onClick=${() => onChange(o.value)}>
        ${o.label}${o.count != null && html`<span class="count">${o.count}</span>`}
      </button>`,
    )}
  </div>`;
}

// ───────────── Forms & modal ─────────────
export function Field({ label, hint, children, full }) {
  return html`<label class=${`field ${full ? 'full' : ''}`}><span>${label}</span>${children}${hint && html`<span class="hint">${hint}</span>`}</label>`;
}

export function Modal({ title, desc, onClose, children, footer, wide, onSubmit }) {
  const ref = useRef();
  useEffect(() => {
    const prev = document.activeElement;
    const first = ref.current?.querySelector('input:not([type=hidden]):not([disabled]), select, textarea, button.btn-primary');
    first?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, []);
  const Tag = onSubmit ? 'form' : 'div';
  return html`<div class="overlay" onMouseDown=${(e) => e.target === e.currentTarget && onClose?.()}>
    <${Tag} class=${`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}
      onSubmit=${onSubmit && ((e) => (e.preventDefault(), onSubmit(e)))}>
      <div class="modal-head">
        <div><h2>${title}</h2>${desc && html`<p>${desc}</p>`}</div>
        <button type="button" class="x-btn" aria-label="إغلاق" onClick=${onClose}>×</button>
      </div>
      <div class="modal-body">${children}</div>
      ${footer && html`<div class="modal-foot">${footer}</div>`}
    </${Tag}>
  </div>`;
}

/** Wraps an async action with busy + error state for forms. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(e.message || 'حدث خطأ');
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

export const FormError = ({ error }) => (error ? html`<div class="callout bad" role="alert">${error}</div>` : null);

export function Toasts() {
  const list = useToasts();
  return html`<div class="toasts" aria-live="polite">${list.map((t) => html`<div class=${`toast ${t.kind}`}>${t.message}</div>`)}</div>`;
}

// ───────────── Charts ─────────────
/** Daily bars. Time runs with the reading direction: oldest at the start (right). */
export function BarChart({ data, value = 'cost', fmt = money, label = 'الاستهلاك اليومي', extra }) {
  const [tip, setTip] = useState(null);
  const max = Math.max(...data.map((d) => Number(d[value]) || 0), 0);
  const total = data.reduce((a, d) => a + (Number(d[value]) || 0), 0);
  return html`<div class="chart" role="img" aria-label=${`${label}: الإجمالي ${fmt(total)}`}>
    <div class="bars" onMouseLeave=${() => setTip(null)}>
      ${data.map((d, i) => {
        const v = Number(d[value]) || 0;
        const h = max > 0 ? Math.max(1.5, (v / max) * 100) : 1.5;
        const isLast = i === data.length - 1;
        return html`<div class=${`bar ${isLast ? 'today' : ''} ${v === 0 ? 'empty' : ''}`} tabindex="-1"
          onMouseEnter=${() => setTip({ i, d })}>
          <i style=${{ blockSize: `${h}%` }}></i>
        </div>`;
      })}
    </div>
    ${tip &&
    html`<div class="chart-tip" style=${{ insetInlineStart: `${((tip.i + 0.5) / data.length) * 100}%` }}>
      <div>${dayLabel(tip.d.day)}</div>
      <div><span class="num">${fmt(tip.d[value])}</span>${extra ? html` — ${extra(tip.d)}` : ''}</div>
    </div>`}
    <div class="chart-axis"><span>${data[0] && dayLabel(data[0].day)}</span><span>اليوم</span></div>
  </div>`;
}

/** Revenue vs cost per month (finance). */
export function PairChart({ data }) {
  const [tip, setTip] = useState(null);
  const max = Math.max(...data.flatMap((d) => [d.revenue, d.cost]), 0);
  const h = (v) => (max > 0 ? Math.max(1, (v / max) * 100) : 1);
  return html`<div>
    <div class="legend"><span><i style=${{ background: 'var(--jade)' }}></i>التحصيل</span>
      <span><i style=${{ background: 'color-mix(in srgb, var(--ink) 30%, var(--sheet))' }}></i>تكلفة الاستهلاك</span></div>
    <div class="chart pair-bars">
      <div class="bars" style=${{ gap: '18px', blockSize: '140px' }} onMouseLeave=${() => setTip(null)}>
        ${data.map(
          (d, i) => html`<div class="bar" onMouseEnter=${() => setTip({ i, d })}>
            <i class="rev" style=${{ blockSize: `${h(d.revenue)}%` }}></i>
            <i class="cost" style=${{ blockSize: `${h(d.cost)}%` }}></i>
          </div>`,
        )}
      </div>
      ${tip &&
      html`<div class="chart-tip" style=${{ insetInlineStart: `${((tip.i + 0.5) / data.length) * 100}%` }}>
        <div>${tip.d.label}</div>
        <div>تحصيل <span class="num">${money(tip.d.revenue)}</span></div>
        <div>تكلفة <span class="num">${money(tip.d.cost)}</span></div>
        <div>ربح <span class="num">${money(tip.d.profit)}</span></div>
      </div>`}
      <div class="chart-axis" style=${{ justifyContent: 'space-around' }}>${data.map((d) => html`<span>${d.short}</span>`)}</div>
    </div>
  </div>`;
}

export function HBars({ items, fmt = money }) {
  const max = Math.max(...items.map((i) => i.value), 0);
  return html`<div class="hbars">
    ${items.map(
      (it) => html`<div class="hbar-row">
        <span class="ltr">${it.label}</span>
        <span class="num">${fmt(it.value)}</span>
        <div class="track"><i style=${{ inlineSize: `${max > 0 ? (it.value / max) * 100 : 0}%` }}></i></div>
      </div>`,
    )}
  </div>`;
}

// ───────────── Code / env snippets ─────────────
function highlight(code) {
  return code.split('\n').map((line, i, arr) => {
    const nl = i < arr.length - 1 ? '\n' : '';
    const t = line.trim();
    if (t.startsWith('#') || t.startsWith('//')) return html`<span class="c">${line}</span>${nl}`;
    const m = /^([A-Z_]+)=(.*)$/.exec(line);
    if (m) return html`<span class="k">${m[1]}</span>=${m[2]}${nl}`;
    return line + nl;
  });
}

export function CodeTabs({ tabs, initial }) {
  const [cur, setCur] = useState(initial || tabs[0]?.id);
  const tab = tabs.find((t) => t.id === cur) || tabs[0];
  return html`<div class="code-wrap">
    <div class="code-head">
      <div class="code-tabs" role="group">
        ${tabs.map((t) => html`<button type="button" aria-pressed=${String(t.id === tab.id)} onClick=${() => setCur(t.id)}>${t.label}</button>`)}
      </div>
      <button type="button" class="btn btn-sm" onClick=${() => copyText(tab.copy ?? tab.code)}><${Icon} name="copy" size=${15} />نسخ</button>
    </div>
    <pre class="code">${highlight(tab.code)}</pre>
    ${tab.note && html`<p class="small muted">${tab.note}</p>`}
  </div>`;
}

/** The variables an app needs: drop-in replacement for the provider's own key. */
export function envTabs({ baseUrl, apiKey, model, anthropicModel }) {
  const claude = anthropicModel || 'claude-sonnet-5-5';
  const chatModel = model || claude;
  return [
    {
      id: 'anthropic',
      label: 'Claude (Anthropic SDK)',
      code: `ANTHROPIC_API_KEY=${apiKey}\nANTHROPIC_BASE_URL=${baseUrl}`,
      copy: `ANTHROPIC_API_KEY=${apiKey}\nANTHROPIC_BASE_URL=${baseUrl}`,
      note: 'مكتبات Anthropic الرسمية (Python وNode) تقرأ ANTHROPIC_BASE_URL تلقائياً، فلا يلزم تعديل الكود. إذا كان التطبيق يكتب الرابط https://api.anthropic.com داخل الكود، استبدله بالرابط أعلاه.',
    },
    {
      id: 'openai',
      label: 'OpenAI SDK / أي مكتبة متوافقة',
      code: `OPENAI_API_KEY=${apiKey}\nOPENAI_BASE_URL=${baseUrl}/v1`,
      copy: `OPENAI_API_KEY=${apiKey}\nOPENAI_BASE_URL=${baseUrl}/v1`,
      note: 'المفتاح نفسه يشغّل كل الموديلات المسموحة في باقة التطبيق — Claude وGPT وGemini وDeepSeek — عن طريق /v1/chat/completions.',
    },
    {
      id: 'curl',
      label: 'تجربة سريعة',
      code: `curl ${baseUrl}/v1/messages \\\n  -H "x-api-key: ${apiKey}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${claude}","max_tokens":200,"messages":[{"role":"user","content":"Hello"}]}'`,
      note: 'إذا وصل الرد فالربط يعمل، وسيظهر الطلب في سجل التطبيق خلال ثوانٍ.',
    },
    {
      id: 'node',
      label: 'Node.js',
      code: `// npm install openai\nimport OpenAI from 'openai';\n\nconst ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: process.env.OPENAI_BASE_URL });\nconst r = await ai.chat.completions.create({\n  model: '${chatModel}',\n  messages: [{ role: 'user', content: 'Hello' }],\n});\nconsole.log(r.choices[0].message.content);`,
    },
    {
      id: 'python',
      label: 'Python',
      code: `# pip install anthropic\nimport anthropic\n\nclient = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL\nmsg = client.messages.create(\n    model="${claude}",\n    max_tokens=500,\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(msg.content[0].text)`,
    },
  ];
}

export function KeyChip({ prefix, last4 }) {
  return html`<span class="keychip">${prefix}…${last4}</span>`;
}

export function planOptions(plans, current) {
  return plans
    .filter((p) => !p.archived || p.id === current)
    .map((p) => html`<option value=${p.id}>${p.name} — ${money(p.price_usd)} / شهر (حد ${money(p.monthly_limit_usd)})</option>`);
}
