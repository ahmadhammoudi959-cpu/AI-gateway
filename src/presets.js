// Ready-made providers and reference prices (USD per 1M tokens). Prices change — always verify on the
// provider's pricing page; every value stays editable from the dashboard.
export const PRICES_CHECKED_AT = '2026-11-01';

export const PROVIDER_PRESETS = [
  { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'anthropic', base_url: 'https://api.anthropic.com', key_placeholder: 'sk-ant-...', keys_url: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', base_url: 'https://api.openai.com/v1', key_placeholder: 'sk-proj-...', keys_url: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', name: 'Google Gemini', kind: 'openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', key_placeholder: 'AIza...', keys_url: 'https://aistudio.google.com/apikey' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', base_url: 'https://api.deepseek.com/v1', key_placeholder: 'sk-...', keys_url: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', base_url: 'https://openrouter.ai/api/v1', key_placeholder: 'sk-or-...', keys_url: 'https://openrouter.ai/keys' },
  { id: 'groq', name: 'Groq', kind: 'openai', base_url: 'https://api.groq.com/openai/v1', key_placeholder: 'gsk_...', keys_url: 'https://console.groq.com/keys' },
  { id: 'xai', name: 'xAI (Grok)', kind: 'openai', base_url: 'https://api.x.ai/v1', key_placeholder: 'xai-...', keys_url: 'https://console.x.ai' },
  { id: 'mistral', name: 'Mistral', kind: 'openai', base_url: 'https://api.mistral.ai/v1', key_placeholder: '', keys_url: 'https://console.mistral.ai/api-keys' },
  { id: 'together', name: 'Together AI', kind: 'openai', base_url: 'https://api.together.xyz/v1', key_placeholder: '', keys_url: 'https://api.together.ai/settings/api-keys' },
  { id: 'custom', name: 'مزوّد متوافق مع OpenAI', kind: 'openai', base_url: '', key_placeholder: '', keys_url: '' },
];

// in = input, cached = cache read, write = cache write, out = output; long = higher tier above a prompt size.
const m = (upstream, label, kind, p) => ({ upstream, label, kind, ...p });

export const MODEL_PRESETS = {
  anthropic: [
    m('claude-opus-5-5', 'Claude Opus 5.5', 'chat', { in: 4, cached: 0.2, write: 5, out: 20, max_tokens: 16384 }),
    m('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'chat', { in: 2, cached: 0.1, write: 2.5, out: 10, max_tokens: 16384 }),
    m('claude-haiku-5-5', 'Claude Haiku 5.5', 'chat', { in: 0.1, cached: 0.01, write: 0.125, out: 0.5, max_tokens: 16384, long: { threshold: 100000, in: 0.5, out: 2.5 } }),
    m('claude-fable-5-1', 'Claude Fable 5.1', 'chat', { in: 10, cached: 0.25, write: 12.5, out: 50, max_tokens: 16384 }),
    m('claude-opus-4-7', 'Claude Opus 4.7', 'chat', { in: 5, cached: 0.5, write: 6.25, out: 25, max_tokens: 16384 }),
    m('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'chat', { in: 3, cached: 0.3, write: 3.75, out: 15, max_tokens: 16384 }),
    m('claude-sonnet-4-5', 'Claude Sonnet 4.5', 'chat', { in: 3, cached: 0.3, write: 3.75, out: 15, max_tokens: 16384 }),
    m('claude-haiku-4-5', 'Claude Haiku 4.5', 'chat', { in: 1, cached: 0.1, write: 1.25, out: 5, max_tokens: 16384 }),
  ],
  openai: [
    m('gpt-5.5', 'GPT-5.5', 'chat', { in: 5, cached: 0.5, out: 30 }),
    m('gpt-5.4', 'GPT-5.4', 'chat', { in: 2.5, cached: 0.25, out: 15 }),
    m('gpt-5.4-mini', 'GPT-5.4 mini', 'chat', { in: 0.75, cached: 0.075, out: 4.5 }),
    m('gpt-5.4-nano', 'GPT-5.4 nano', 'chat', { in: 0.2, cached: 0.02, out: 1.25 }),
    m('gpt-4.1', 'GPT-4.1', 'chat', { in: 2, cached: 0.5, out: 8 }),
    m('gpt-4.1-mini', 'GPT-4.1 mini', 'chat', { in: 0.4, cached: 0.1, out: 1.6 }),
    m('gpt-4.1-nano', 'GPT-4.1 nano', 'chat', { in: 0.1, cached: 0.025, out: 0.4 }),
    m('gpt-4o-mini', 'GPT-4o mini', 'chat', { in: 0.15, cached: 0.075, out: 0.6 }),
    m('o4-mini', 'o4-mini', 'chat', { in: 1.1, cached: 0.275, out: 4.4 }),
    m('text-embedding-3-small', 'Embedding 3 small', 'embedding', { in: 0.02, out: 0 }),
    m('text-embedding-3-large', 'Embedding 3 large', 'embedding', { in: 0.13, out: 0 }),
    m('gpt-image-1-mini', 'GPT Image 1 mini', 'image', { in: 2, out: 8 }),
    m('gpt-image-2', 'GPT Image 2', 'image', { in: 5, out: 30 }),
  ],
  gemini: [
    m('gemini-3.5-flash', 'Gemini 3.5 Flash', 'chat', { in: 1.5, cached: 0.15, out: 9 }),
    m('gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 'chat', { in: 2, cached: 0.2, out: 12, long: { threshold: 200000, in: 4, out: 18 } }),
    m('gemini-3-flash-preview', 'Gemini 3 Flash', 'chat', { in: 0.5, cached: 0.05, out: 3 }),
    m('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 'chat', { in: 0.25, cached: 0.025, out: 1.5 }),
    m('gemini-2.5-pro', 'Gemini 2.5 Pro', 'chat', { in: 1.25, cached: 0.125, out: 10, long: { threshold: 200000, in: 2.5, out: 15 } }),
    m('gemini-2.5-flash', 'Gemini 2.5 Flash', 'chat', { in: 0.3, cached: 0.03, out: 2.5 }),
    m('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 'chat', { in: 0.1, cached: 0.01, out: 0.4 }),
    m('gemini-embedding-001', 'Gemini Embedding', 'embedding', { in: 0.15, out: 0 }),
  ],
  deepseek: [
    m('deepseek-v4-flash', 'DeepSeek V4 Flash', 'chat', { in: 0.14, cached: 0.0028, out: 0.28 }),
    m('deepseek-v4-pro', 'DeepSeek V4 Pro', 'chat', { in: 1.74, cached: 0.0145, out: 3.48 }),
  ],
};

/** Converts a preset into the fields of the `models` table. */
export function presetToModel(p) {
  return {
    alias: p.upstream,
    upstream_model: p.upstream,
    kind: p.kind,
    input_price: p.in ?? 0,
    output_price: p.out ?? 0,
    cached_input_price: p.cached ?? null,
    cache_write_price: p.write ?? null,
    request_price: p.request ?? 0,
    long_context_threshold: p.long?.threshold ?? null,
    long_input_price: p.long?.in ?? null,
    long_output_price: p.long?.out ?? null,
    default_max_tokens: p.max_tokens ?? null,
  };
}

export function guessModelKind(id) {
  const s = String(id).toLowerCase();
  if (s.includes('embed')) return 'embedding';
  if (s.includes('image') || s.includes('dall-e') || s.includes('imagen')) return 'image';
  return 'chat';
}

/** Models that cannot be served through chat/embeddings/images endpoints — hidden by default when importing. */
export const isUnsupportedModel = (id) =>
  /(tts|whisper|transcribe|audio|realtime|moderation|speech|search-preview|computer-use|veo|lyria|sora)/i.test(String(id));
