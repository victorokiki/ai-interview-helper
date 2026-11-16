// Real-network measurement of what connection prewarming saves, per provider.
// Sends unauthenticated requests (they return 401/403/404 quickly, nothing is
// billed and no key is needed) through Electron's net stack, the same one the
// app uses:
//   cold = new network session each time (DNS + TCP + TLS + request)
//   warm = second request on an already-open connection (request only)
// Usage: npx electron tests/bench/network.js [samples]
const { app, session } = require('electron');
const fs = require('fs');
const path = require('path');

const TARGETS = {
  anthropic: 'https://api.anthropic.com/v1/models',
  openai: 'https://api.openai.com/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
  deepgram: 'https://api.deepgram.com/v1/projects',
};
const SAMPLES = Number(process.argv[2]) || 8;

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function timed(ses, url) {
  const t = performance.now();
  const res = await ses.fetch(url, { cache: 'no-store' });
  const ttfb = performance.now() - t;
  await res.arrayBuffer();
  return { ttfb, status: res.status };
}

app.whenReady().then(async () => {
  const results = { at: new Date().toISOString(), samples: SAMPLES, note: 'ms to response headers; cold = fresh connection, warm = reused connection', providers: {} };
  for (const [name, url] of Object.entries(TARGETS)) {
    const cold = [];
    const warm = [];
    let status = null;
    try {
      for (let i = 0; i < SAMPLES; i++) {
        const ses = session.fromPartition(`bench-${name}-${i}-${Date.now()}`); // empty socket pool
        const c = await timed(ses, url);
        const w = await timed(ses, url);
        cold.push(c.ttfb);
        warm.push(w.ttfb);
        status = c.status;
      }
      const p50c = pct(cold, 50);
      const p50w = pct(warm, 50);
      results.providers[name] = {
        status,
        coldMs: { p50: Math.round(p50c), p95: Math.round(pct(cold, 95)) },
        warmMs: { p50: Math.round(p50w), p95: Math.round(pct(warm, 95)) },
        savedByPrewarmMs: Math.round(p50c - p50w),
      };
    } catch (err) {
      results.providers[name] = { error: err.message };
    }
    console.log(name, JSON.stringify(results.providers[name]));
  }
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'out', 'network.json'), JSON.stringify(results, null, 2));
  app.exit(0);
});
