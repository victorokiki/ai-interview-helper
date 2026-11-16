// Meeting detection (Windows): notices when a call app starts using the
// microphone, so the app can offer to start a session. Two sources, combined:
//  1. The audio session API (WASAPI, via src/mic-sessions.ps1 in one small
//     PowerShell process): which processes have a microphone stream open now.
//     Needed on current Windows 11, where the consent store below is no longer
//     updated live (entries say PersistedInDatabase). ~2-5 ms per check.
//  2. The CapabilityAccessManager consent store in the registry (older
//     Windows 10/11): an entry whose LastUsedTimeStop is 0 is using the mic.
// No admin rights; nothing leaves the PC.
// Idea from interview-copilot (meeting-detection.ts); written from scratch.
const { execFile } = require('child_process');
const path = require('path');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

// Apps that host calls. Browsers are included because Meet, Teams-web and
// Zoom-web run in them.
const CALL_APPS = [
  [/zoom/i, 'Zoom'],
  [/msteams|teams/i, 'Microsoft Teams'],
  [/webex|ciscocollab/i, 'Webex'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/skype/i, 'Skype'],
  [/whatsapp/i, 'WhatsApp'],
  [/signal/i, 'Signal'],
  [/gotomeeting|goto/i, 'GoTo'],
  [/ringcentral/i, 'RingCentral'],
  [/chrome\.exe/i, 'Chrome'],
  [/msedge\.exe/i, 'Edge'],
  [/firefox\.exe/i, 'Firefox'],
  [/brave\.exe/i, 'Brave'],
  [/opera\.exe/i, 'Opera'],
];

// Parses `reg query <KEY> /s` output into the call apps using the mic now.
function parseActive(output, ownExe = '') {
  const own = ownExe.toLowerCase();
  const active = [];
  for (const block of String(output).split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const key = lines.find((l) => l.startsWith('HKEY_'));
    if (!key) continue;
    const value = (name) => (lines.find((l) => l.trim().startsWith(`${name} `)) || '').trim().split(/\s+/).pop();
    const start = value('LastUsedTimeStart');
    const stop = value('LastUsedTimeStop');
    if (!start || start === '0x0' || stop !== '0x0') continue;
    const id = key.slice(key.lastIndexOf('\\') + 1); // package name, or a path with # for \
    const exe = id.split('#').pop();
    if (own && exe.toLowerCase() === own) continue;
    const match = CALL_APPS.find(([re]) => re.test(id));
    if (match) active.push({ id, app: match[1] });
  }
  return active;
}

function queryRegistry(ownExe) {
  return new Promise((resolve) => {
    execFile('reg', ['query', KEY, '/s'], { windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? [] : parseActive(stdout, ownExe));
    });
  });
}

// Parses mic-sessions.ps1 output ("<pid>\t<process name>" lines) into call apps.
function parseSessions(output, ownExe = '') {
  const own = ownExe.toLowerCase().replace(/\.exe$/, '');
  const active = [];
  for (const line of String(output).split(/\r?\n/)) {
    const [pid, name] = line.split('\t');
    if (!name || !/^\d+$/.test(pid)) continue;
    if (own && name.toLowerCase() === own) continue;
    const exe = `${name}.exe`;
    const match = CALL_APPS.find(([re]) => re.test(exe));
    if (match && !active.some((a) => a.app === match[1])) active.push({ id: `session:${name.toLowerCase()}`, app: match[1] });
  }
  return active;
}

// One PowerShell process, started on first use, answers each check.
let probe = null;
function sessionsScript() {
  // PowerShell can't run a file inside app.asar; the build unpacks it.
  return path.join(__dirname, 'mic-sessions.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
function querySessions(ownExe) {
  return new Promise((resolve) => {
    if (!probe) {
      try {
        const ps = execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sessionsScript()], { windowsHide: true });
        probe = { ps, buf: '', waiting: [] };
        ps.stdout.on('data', (d) => {
          probe.buf += d;
          let i;
          while (probe && (i = probe.buf.indexOf('END')) >= 0) {
            const chunk = probe.buf.slice(0, i);
            probe.buf = probe.buf.slice(i + 3);
            probe.waiting.shift()?.(chunk);
          }
        });
        const gone = () => {
          probe?.waiting.forEach((w) => w(''));
          probe = null;
        };
        ps.on('exit', gone);
        ps.on('error', gone);
      } catch {
        return resolve([]);
      }
    }
    const p = probe;
    const timer = setTimeout(() => {
      const i = p.waiting.indexOf(done);
      if (i >= 0) p.waiting.splice(i, 1);
      resolve([]);
    }, 8000);
    const done = (out) => {
      clearTimeout(timer);
      resolve(parseSessions(out, ownExe));
    };
    p.waiting.push(done);
    p.ps.stdin.write('check\n');
  });
}

function stopProbe() {
  probe?.ps.kill();
  probe = null;
}

// Call apps using the microphone now, from both sources.
async function queryActive(ownExe) {
  const [sessions, registry] = await Promise.all([querySessions(ownExe), queryRegistry(ownExe)]);
  const out = [...sessions];
  for (const r of registry) if (!out.some((a) => a.app === r.app)) out.push(r);
  return out;
}

// Polls every `intervalMs` and calls onStart({app}) when a call app newly
// starts using the microphone. Returns a stop function.
function watch(onStart, { intervalMs = 5000, enabled = () => true } = {}) {
  if (process.platform !== 'win32') return () => {};
  const ownExe = path.basename(process.execPath);
  let seen = new Set();
  let first = true;
  const tick = async () => {
    if (!enabled()) {
      seen = new Set();
      stopProbe(); // no PowerShell process while detection is off or a session runs
      return;
    }
    const active = await queryActive(ownExe);
    const now = new Set(active.map((a) => a.app));
    // The first poll only records what's already running (no popup at launch).
    if (!first) for (const a of active) if (!seen.has(a.app)) onStart(a);
    first = false;
    seen = now;
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => {
    clearInterval(timer);
    stopProbe();
  };
}

module.exports = { parseActive, parseSessions, queryActive, querySessions, stopProbe, watch, CALL_APPS };
