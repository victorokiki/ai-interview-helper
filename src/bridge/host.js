// Native messaging host for the Interview Helper browser extension.
//
// The browser starts this (through the launcher the app registers) when the
// extension calls chrome.runtime.sendNativeMessage. Messages are JSON with a
// 4-byte length prefix on stdin/stdout. Nothing listens on the network.
//
// It only accepts the extension origins in ids.js, and only two messages:
//   { type: 'ping' }                 -> { ok, app, version }
//   { type: 'importJob', job: {...} } -> { ok } after writing the job, as a
//     validated file, into <data>/inbox/. The app picks it up from there; this
//     process never touches jobs.json or anything else.
//
// Usage (by the launcher): <app exe as Node> host.js --data <folder> <origin> [--parent-window=N]
const fs = require('fs');
const path = require('path');
const { ALLOWED_ORIGINS } = require('./ids');
const { cleanImport } = require('../../packages/core/jobpost');

const MAX_MESSAGE = 1024 * 1024;

function args(argv) {
  const out = { data: null, origin: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') out.data = argv[++i];
    else if (argv[i].startsWith('chrome-extension://')) out.origin = argv[i];
  }
  return out;
}

function version() {
  try {
    return require('../../package.json').version;
  } catch {
    return null;
  }
}

function send(obj, done) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]), done);
}

// Exits only after the reply has been flushed (pipes can be asynchronous).
const fail = (error) => send({ ok: false, error }, () => process.exit(1));

// Writes atomically (temp file, then rename) so the app never reads half a file.
function writeInbox(dir, job) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = path.join(dir, `${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ job, receivedAt: Date.now() }));
  fs.renameSync(tmp, path.join(dir, `${name}.json`));
}

function handle(msg, opts) {
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'Bad message.' };
  if (msg.type === 'ping') return { ok: true, app: 'Interview Helper', version: version() };
  if (msg.type === 'importJob') {
    const r = cleanImport(msg.job);
    if (!r.ok) return r;
    writeInbox(path.join(opts.data, 'inbox'), r.job);
    return { ok: true };
  }
  return { ok: false, error: 'Unknown message.' };
}

function main() {
  const opts = args(process.argv.slice(2));
  if (!opts.origin || !ALLOWED_ORIGINS.includes(opts.origin)) {
    return fail('This extension is not allowed to talk to Interview Helper.');
  }
  if (!opts.data || !path.isAbsolute(opts.data)) {
    return fail('Interview Helper is not set up for the browser extension. Turn it on again in Settings.');
  }

  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > MAX_MESSAGE) {
        process.stdin.pause();
        return fail('Message too large.');
      }
      if (buf.length < 4 + len) break;
      const raw = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      let reply;
      try {
        reply = handle(JSON.parse(raw), opts);
      } catch (err) {
        reply = { ok: false, error: `Could not save the job: ${err.message}` };
      }
      send(reply);
    }
  });
  process.stdin.on('end', () => process.stdout.write('', () => process.exit(0)));
}

if (require.main === module) main();

module.exports = { handle, args };
