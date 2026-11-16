// Popup: reads the current tab (only now, because the user clicked), fills in
// the job, and sends it to the desktop app over native messaging.
const HOST = 'com.interviewhelper.bridge';
const $ = (sel) => document.querySelector(sel);

function native(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, message, (reply) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message || String(err), transport: true });
        else resolve(reply || { ok: false, error: 'No reply from Interview Helper.' });
      });
    } catch (err) {
      resolve({ ok: false, error: err.message, transport: true });
    }
  });
}

// Plain-language versions of the browser's native messaging errors.
function explain(error) {
  if (/not found/i.test(error)) return 'Interview Helper isn’t connected yet. In the app, open Settings → Browser extension and press Turn on.';
  if (/forbidden/i.test(error)) return 'This copy of the extension isn’t allowed to talk to Interview Helper. Load the extension from the folder the app shows in Settings.';
  if (/exited|disconnected/i.test(error)) return 'Interview Helper couldn’t start its connector. Turn the browser extension off and on again in the app’s Settings.';
  return error;
}

function setStatus(kind, text) {
  $('#status').className = `status ${kind}`;
  $('#statusText').textContent = text;
}

const SOURCES = {
  structured: 'Filled in from the job details the page publishes.',
  selection: 'Description taken from the text you selected.',
  page: 'Description taken from the page text. For a cleaner import, select the job description on the page and open this again.',
};

let pageUrl = '';
let connected = false;

async function readPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/i.test(tab.url || '')) throw new Error('not a web page');
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['grab.js'] });
    const job = CoreJobPost.parseJobPage(res?.result || { url: tab.url });
    $('#company').value = job.company;
    $('#role').value = job.role;
    $('#description').value = job.description;
    pageUrl = job.url;
    $('#url').textContent = job.url;
    $('#url').title = job.url;
    $('#source').textContent = SOURCES[job.source] || '';
  } catch {
    $('#source').textContent = 'This page can’t be read. Open the job posting in a normal tab, or type the details here.';
  }
}

async function connect() {
  const r = await native({ type: 'ping' });
  connected = Boolean(r.ok);
  if (connected) setStatus('ok', `Connected to Interview Helper${r.version ? ` ${r.version}` : ''} on this computer.`);
  else setStatus('err', explain(r.error || 'Unknown error.'));
  updateButton();
}

function updateButton() {
  const filled = ['#company', '#role', '#description'].some((s) => $(s).value.trim());
  $('#send').disabled = !connected || !filled;
}

$('#form').addEventListener('input', updateButton);

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const job = { company: $('#company').value, role: $('#role').value, description: $('#description').value, url: pageUrl };
  const checked = CoreJobPost.cleanImport(job);
  const out = $('#result');
  if (!checked.ok) {
    out.className = 'result err';
    out.textContent = checked.error;
    return;
  }
  $('#send').disabled = true;
  out.className = 'result';
  out.textContent = 'Sending…';
  const r = await native({ type: 'importJob', job: checked.job });
  if (r.ok) {
    out.className = 'result ok';
    out.textContent = 'Added to Jobs ✓ It’s in the app now (or the next time you open it).';
    $('#send').textContent = 'Added';
  } else {
    out.className = 'result err';
    out.textContent = r.transport ? explain(r.error) : r.error;
    $('#send').disabled = false;
  }
});

Promise.all([readPage(), connect()]).then(updateButton);

// ---- Autofill (rules from Autonomous Job Kit, MIT) ----
// "Fill this form" asks the service worker (background.js) to fill the current
// tab; it runs there so the fill finishes even if this popup closes. Nothing
// here talks to the app, and nothing is ever submitted.
const hasApi = (path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), typeof chrome === 'undefined' ? undefined : chrome);

function fillSay(text, kind = '') {
  $('#fillStatus').className = `result ${kind}`;
  $('#fillStatus').textContent = text;
  // The popup is at most 600px tall: keep the answer in view.
  if (text) requestAnimationFrame(() => $('#fillStatus').scrollIntoView({ block: 'nearest' }));
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab.');
  return tab.id;
}

function showFillResult(r, tabId) {
  $('#allowBox').hidden = true;
  if (!r) return fillSay('No answer from the extension. Reload it in chrome://extensions and try again.', 'err');
  if (r.error) return fillSay(r.error, 'err');
  if (r.busy) return fillSay('Already filling; wait a moment.', 'warn');
  if (r.noProfile && !r.frames) return fillSay('No autofill profile yet. Press Edit autofill profile and import your profile.json.', 'warn');
  if (r.frames) {
    fillSay(`Filled ${r.filled}, left ${r.left} for you${r.already ? `, ${r.already} already filled` : ''}. Nothing was submitted; check every answer.`, 'ok');
  } else if (!r.blocked || !r.blocked.length) {
    fillSay('No form found on this page.', 'warn');
  } else {
    fillSay('');
  }
  if (r.blocked && r.blocked.length) offerAccess(r.blocked, tabId);
}

// The form sits in a frame from an application system this extension can't
// reach with activeTab alone. Ask for just that site, on this click.
function offerAccess(blocked, tabId) {
  const sites = blocked.map((b) => b.site);
  $('#allowText').textContent = `The form is in a frame from ${blocked.map((b) => b.host).join(', ')}. Allow Interview Helper to fill forms on ${sites.join(', ')}? Asked once; you can remove it in the extension’s details.`;
  $('#allowFrame').textContent = `Allow ${sites.join(', ')} and fill`;
  $('#allowFrame').onclick = () => {
    const origins = blocked.map((b) => b.pattern);
    // Arm first (the browser may close this popup while it asks), then ask straight away, inside this click.
    chrome.runtime.sendMessage({ type: 'jobkit:arm-grant', tabId }).catch(() => {});
    chrome.permissions.request({ origins }).then(
      async (granted) => {
        if (!granted) chrome.storage.session.remove('armed').catch(() => {});
        if (!granted) return fillSay(`Not allowed, so the form in the ${sites.join(', ')} frame was left alone. You can also open the form on its own page and fill it there.`, 'warn');
        fillSay('Filling…');
        showFillResult(await chrome.runtime.sendMessage({ type: 'jobkit:fill-tab', tabId, afterGrant: true }), tabId);
      },
      (e) => fillSay(`Could not ask for access: ${e.message || e}`, 'err')
    );
  };
  $('#allowBox').hidden = false;
  requestAnimationFrame(() => $('#allowBox').scrollIntoView({ block: 'nearest' }));
}

async function showProfile() {
  if (!hasApi('storage.local')) return;
  const { profile, resume } = await chrome.storage.local.get(['profile', 'resume']);
  const p = profile && typeof profile === 'object' ? profile : {};
  const name = [p.preferredName || p.firstName, p.lastName].filter(Boolean).join(' ');
  $('#fill').disabled = !Object.keys(p).length;
  $('#profileLine').textContent = Object.keys(p).length
    ? `Profile: ${name || 'saved'}${resume && resume.data ? ' · resume PDF saved' : ' · no resume PDF'}.`
    : 'No autofill profile yet. Press Edit autofill profile to import your profile.json.';
}

async function showShortcut() {
  if (!hasApi('commands.getAll')) return;
  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'fill-page');
  $('#shortcut').textContent = cmd && cmd.shortcut ? `Shortcut: ${cmd.shortcut}.` : 'No shortcut set (chrome://extensions/shortcuts).';
}

$('#fill').addEventListener('click', async () => {
  $('#fill').disabled = true;
  fillSay('Filling…');
  try {
    const tabId = await activeTabId();
    showFillResult(await chrome.runtime.sendMessage({ type: 'jobkit:fill-tab', tabId }), tabId);
  } catch (e) {
    fillSay(`Could not fill this page: ${e && e.message ? e.message : e}`, 'err');
  } finally {
    $('#fill').disabled = false;
  }
});

$('#editProfile').addEventListener('click', () => {
  if (hasApi('runtime.openOptionsPage')) chrome.runtime.openOptionsPage();
  window.close();
});

showProfile().catch(() => {});
showShortcut().catch(() => {});
