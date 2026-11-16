// One streaming text call per provider. Every adapter takes the same
// provider-neutral request and returns the full text:
//   { system, parts: [{type:'text', text} | {type:'image', data} | {type:'pdf', data}], effort, maxTokens }
// Claude goes through the Anthropic SDK; OpenAI and Gemini use their
// OpenAI-compatible chat endpoints; Ollama uses its native API so we can set
// the context size. HTTP goes through Electron's net.fetch (system proxy).
const { net } = require('electron');
const Anthropic = require('@anthropic-ai/sdk');

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Haiku has no server-side refusal fallback.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

const PROVIDERS = {
  anthropic: { label: 'Anthropic', keyField: 'anthropicKey', modelField: 'anthropicModel' },
  openai: { label: 'OpenAI', keyField: 'openaiKey', modelField: 'openaiModel' },
  gemini: { label: 'Google Gemini', keyField: 'geminiKey', modelField: 'geminiModel' },
  ollama: { label: 'Ollama', keyField: null, modelField: 'ollamaModel' },
};

class ProviderError extends Error {
  constructor(message, status, provider) {
    super(message);
    this.status = status;
    this.provider = provider;
  }
}

let anthropicClient = null;
let anthropicClientKey = '';

function anthropic(apiKey) {
  if (!anthropicClient || anthropicClientKey !== apiKey) {
    // Same network stack (Chromium) as the other providers, so connections
    // opened by prewarm() are reused by the first real request.
    anthropicClient = new Anthropic({ apiKey, fetch: (url, init) => net.fetch(String(url), init) });
    anthropicClientKey = apiKey;
  }
  return anthropicClient;
}

async function streamAnthropic(config, req, onText, signal) {
  const model = config.anthropicModel;
  const content = req.parts.map((p) => {
    if (p.type === 'image') return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: p.data } };
    if (p.type === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } };
    return { type: 'text', text: p.text };
  });
  const params = {
    model,
    max_tokens: req.maxTokens || 16000,
    output_config: { effort: req.effort || 'low' },
    messages: [{ role: 'user', content }],
  };
  // The profile block is identical across calls in a session, so it is cached.
  if (req.system) params.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
  if (FALLBACK_MODELS.has(model)) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  const stream = anthropic(config.anthropicKey).beta.messages.stream(params, { signal });
  stream.on('text', (text) => onText(text));
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('Claude declined to answer this request.');
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// Claude with the web search server tool (company research). Streams text as
// it arrives and returns the final content blocks, whose text blocks carry
// web_search_result_location citations. Basic web_search_20250305 works on
// every Claude model the app offers; $10 per 1,000 searches plus tokens.
// Long searches can stop with pause_turn: the paused assistant turn is sent
// back unchanged to resume (at most 3 times).
async function researchWithClaude(config, req, onText = () => {}, signal) {
  if (config.provider !== 'anthropic') {
    const err = new Error('Company research uses Claude web search with cited sources. Choose Claude (Anthropic) as the AI provider in Settings.');
    err.code = 'needs-claude';
    throw err;
  }
  if (!config.anthropicKey) throw new Error('Add your Anthropic API key in Settings.');
  const model = config.anthropicModel;
  const messages = [{ role: 'user', content: [{ type: 'text', text: req.text }] }];
  const blocks = [];
  const searchErrors = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const params = {
      model,
      max_tokens: req.maxTokens || 16000,
      output_config: { effort: req.effort || 'medium' },
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: req.maxSearches || 6 }],
      messages,
    };
    if (FALLBACK_MODELS.has(model)) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    const stream = anthropic(config.anthropicKey).beta.messages.stream(params, { signal });
    stream.on('text', (t) => onText(t));
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('Claude declined to answer this request.');
    for (const b of message.content) {
      // Search failures come back as a result block with an error object.
      if (b.type === 'web_search_tool_result' && b.content && !Array.isArray(b.content) && b.content.error_code) searchErrors.push(b.content.error_code);
    }
    blocks.push(...message.content);
    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content });
  }
  return { blocks, searchErrors };
}

async function errorFrom(res, provider) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.error || body?.[0]?.error?.message || '';
  } catch {
    // non-JSON error body
  }
  return new ProviderError(detail || `${PROVIDERS[provider].label} returned HTTP ${res.status}`, res.status, provider);
}

// Reads a streamed body line by line.
async function* lines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

const OPENAI_COMPAT = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    // GPT-5 and o-series reject max_tokens.
    tokenField: 'max_completion_tokens',
    reasoning: (model) => /^(gpt-5|o\d)/.test(model),
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    tokenField: 'max_tokens',
    reasoning: (model) => /^gemini-(2\.5|3)/.test(model),
  },
};

async function streamOpenAICompat(provider, config, req, onText, signal) {
  const spec = OPENAI_COMPAT[provider];
  const model = config[PROVIDERS[provider].modelField];
  const user = req.parts
    .filter((p) => p.type !== 'pdf')
    .map((p) =>
      p.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:image/png;base64,${p.data}` } }
        : { type: 'text', text: p.text },
    );
  const body = {
    model,
    stream: true,
    messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: user }],
    [spec.tokenField]: req.maxTokens || 16000,
  };
  if (spec.reasoning(model)) body.reasoning_effort = req.effort || 'low';

  const res = await net.fetch(spec.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config[PROVIDERS[provider].keyField]}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorFrom(res, provider);

  let text = '';
  for await (const line of lines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    const delta = JSON.parse(data).choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      onText(delta);
    }
  }
  return text;
}

// Opens (or refreshes) the TLS connection to the selected provider before the
// first question, so the first answer doesn't pay for DNS + TCP + TLS. Uses a
// cheap authenticated metadata request (no tokens billed). For Ollama it loads
// the model into memory, which is the slow part of its first answer.
async function prewarm(config) {
  const t = Date.now();
  const key = config[PROVIDERS[config.provider]?.keyField];
  let res;
  try {
    if (config.provider === 'anthropic' && key) {
      const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
      res = await net.fetch(`${base}/v1/models?limit=1`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    } else if (config.provider === 'openai' && key) {
      res = await net.fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } });
    } else if (config.provider === 'gemini' && key) {
      res = await net.fetch('https://generativelanguage.googleapis.com/v1beta/openai/models', { headers: { authorization: `Bearer ${key}` } });
    } else if (config.provider === 'ollama') {
      const base = (config.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
      res = await net.fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.ollamaModel, messages: [], keep_alive: '30m' }),
      });
    } else {
      return { ok: false, skipped: true };
    }
    await res.arrayBuffer(); // drain so the socket returns to the pool
    return { ok: res.ok, status: res.status, ms: Date.now() - t };
  } catch (err) {
    return { ok: false, error: err.message, ms: Date.now() - t };
  }
}

async function streamOllama(config, req, onText, signal) {
  const base = (config.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, '');
  const images = req.parts.filter((p) => p.type === 'image').map((p) => p.data);
  const user = {
    role: 'user',
    content: req.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n'),
  };
  if (images.length) user.images = images;
  let res;
  try {
    res = await net.fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        stream: true,
        messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), user],
        // Ollama defaults to a small context; resume + JD + transcript need more.
        options: { num_ctx: 16384, num_predict: req.maxTokens || 4096 },
      }),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ProviderError(`Could not reach Ollama at ${base}. Is it running? (ollama serve)`, 0, 'ollama');
  }
  if (!res.ok) throw await errorFrom(res, 'ollama');

  let text = '';
  for await (const line of lines(res.body)) {
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.error) throw new ProviderError(msg.error, 500, 'ollama');
    const delta = msg.message?.content;
    if (delta) {
      text += delta;
      onText(delta);
    }
    if (msg.done) break;
  }
  return text;
}

function missingSetup(config) {
  const p = PROVIDERS[config.provider] || PROVIDERS.anthropic;
  if (p.keyField && !config[p.keyField]) return `Add your ${p.label} API key in Settings first.`;
  if (!config[p.modelField]) return `Choose a ${p.label} model in Settings first.`;
  return '';
}

async function streamText(config, req, onText = () => {}, signal) {
  const missing = missingSetup(config);
  if (missing) throw new Error(missing);
  switch (config.provider) {
    case 'openai':
    case 'gemini':
      return streamOpenAICompat(config.provider, config, req, onText, signal);
    case 'ollama':
      return streamOllama(config, req, onText, signal);
    default:
      return streamAnthropic(config, req, onText, signal);
  }
}

module.exports = {
  prewarm,
  researchWithClaude,
  PROVIDERS,
  streamText,
  missingSetup,
};
