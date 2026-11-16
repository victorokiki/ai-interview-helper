// Load test for a TypeScript/Node-style AI streaming gateway, to answer
// "is Node fast enough, or do we need Rust (Axum) for the backend?".
//
// Three processes:
//   upstream  fake LLM: 400 ms to first token, then 300 tokens at ~66 tok/s (SSE)
//   gateway   plain node:http: verifies an HMAC-signed token, builds a ~4k-token
//             prompt, streams from upstream, counts tokens (metering), relays SSE
//   load      this process: N concurrent clients, measures time to first token
//
// Usage: node tests/bench/gateway.js [concurrency levels...]
const http = require('http');
const crypto = require('crypto');
const { fork } = require('child_process');

const SECRET = 'bench-secret';
const role = process.env.BENCH_ROLE;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}
function verify(token) {
  const [body, sig] = String(token || '').split('.');
  const good = crypto.createHmac('sha256', SECRET).update(body || '').digest('base64url');
  if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString());
}

if (role === 'upstream') {
  http
    .createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        setTimeout(() => {
          let i = 0;
          const timer = setInterval(() => {
            res.write(`data: {"delta":"tok${i} "}\n\n`);
            if (++i === 300) {
              clearInterval(timer);
              res.end('data: [DONE]\n\n');
            }
          }, 15);
        }, 400);
      });
    })
    .listen(0, function () {
      process.send({ port: this.address().port });
    });
} else if (role === 'gateway') {
  const upstream = `http://127.0.0.1:${process.env.UPSTREAM_PORT}/`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  const resume = 'experience '.repeat(2500); // ~4k tokens of profile text
  let tokens = 0;
  http
    .createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const user = verify((req.headers.authorization || '').slice(7));
        if (!user) {
          res.writeHead(401).end();
          return;
        }
        const { question } = JSON.parse(body);
        const prompt = JSON.stringify({ system: `Profile:\n${resume}`, messages: [{ role: 'user', content: question }] });
        const up = http.request(upstream, { method: 'POST', agent, headers: { 'content-type': 'application/json' } }, (upRes) => {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          let buf = '';
          upRes.on('data', (chunk) => {
            buf += chunk;
            let nl;
            while ((nl = buf.indexOf('\n\n')) !== -1) {
              const event = buf.slice(0, nl);
              buf = buf.slice(nl + 2);
              if (event === 'data: [DONE]') continue;
              tokens++; // metering
              const { delta } = JSON.parse(event.slice(6));
              res.write(`event: delta\ndata: ${JSON.stringify({ text: delta })}\n\n`);
            }
          });
          upRes.on('end', () => res.end(`event: done\ndata: {"usage":{}}\n\n`));
        });
        up.end(prompt);
      });
    })
    .listen(0, function () {
      process.send({ port: this.address().port });
    });
  // Report CPU and memory on request.
  let last = { cpu: process.cpuUsage(), t: process.hrtime.bigint() };
  process.on('message', (m) => {
    if (m !== 'stats') return;
    const cpu = process.cpuUsage(last.cpu);
    const t = process.hrtime.bigint();
    const wallUs = Number(t - last.t) / 1000;
    last = { cpu: process.cpuUsage(), t };
    process.send({ cpuPct: Math.round(((cpu.user + cpu.system) / wallUs) * 100), rssMB: Math.round(process.memoryUsage().rss / 1048576), tokens });
  });
} else {
  const levels = process.argv.slice(2).map(Number).filter(Boolean);
  const LEVELS = levels.length ? levels : [100, 500, 1000, 2000];
  const start = (r, env = {}) =>
    new Promise((resolve) => {
      const child = fork(__filename, [], { env: { ...process.env, BENCH_ROLE: r, ...env } });
      child.once('message', (m) => resolve({ child, port: m.port }));
    });
  const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

  (async () => {
    const up = await start('upstream');
    const gw = await start('gateway', { UPSTREAM_PORT: up.port });
    const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
    const token = sign({ sub: 'user-1', plan: 'pro' });
    const stats = () => new Promise((resolve) => {
      gw.child.once('message', resolve);
      gw.child.send('stats');
    });

    const one = () =>
      new Promise((resolve, reject) => {
        const t0 = process.hrtime.bigint();
        let first = null;
        const req = http.request(
          { port: gw.port, method: 'POST', agent, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } },
          (res) => {
            res.on('data', () => {
              if (first === null) first = Number(process.hrtime.bigint() - t0) / 1e6;
            });
            res.on('end', () => resolve({ ttft: first, total: Number(process.hrtime.bigint() - t0) / 1e6 }));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ question: 'Tell me about a time you led a project.' }));
      });

    const results = [];
    for (const n of LEVELS) {
      await stats(); // reset the CPU window
      // Stagger starts over 1 s so it resembles real arrivals, not one burst.
      const runs = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((r) => setTimeout(r, (i / n) * 1000)).then(one)));
      const s = await stats();
      const ttft = runs.map((r) => r.ttft - 400); // remove the fake provider's own 400 ms
      const total = runs.map((r) => r.total);
      results.push({
        concurrentStreams: n,
        addedTtftMs: { p50: +pct(ttft, 50).toFixed(1), p95: +pct(ttft, 95).toFixed(1), max: +Math.max(...ttft).toFixed(1) },
        streamTotalMs: { p50: Math.round(pct(total, 50)), p95: Math.round(pct(total, 95)) },
        gatewayCpuPctOfOneCore: s.cpuPct,
        gatewayRssMB: s.rssMB,
      });
      console.log(JSON.stringify(results[results.length - 1]));
    }
    up.child.kill();
    gw.child.kill();
    require('fs').mkdirSync(require('path').join(__dirname, 'out'), { recursive: true });
    require('fs').writeFileSync(require('path').join(__dirname, 'out', 'gateway.json'), JSON.stringify({ node: process.version, results }, null, 2));
    process.exit(0);
  })();
}
