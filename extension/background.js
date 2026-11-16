// Interview Helper extension: service worker for Autofill.
//
// Add to Jobs does not use this file: the popup reads the page and talks to the
// app over native messaging itself, exactly as before.
//
// Autofill (rules from Autonomous Job Kit, MIT; see LICENSE-autonomous-job-kit.txt)
// runs only on a user gesture: the popup's "Fill this form" button or the
// Alt+Shift+F command. Both grant activeTab for the current tab. fillTab()
// injects the content scripts into the frames it may reach, runs
// JobKit.startFill() in each and adds up the results. Nothing is injected
// anywhere else, there are no always-on content scripts and no network requests.
//
// Forms embedded from an application system in a cross-origin frame (a company
// page showing a Greenhouse form, say) are out of activeTab's reach. fillTab()
// reports them; the popup then asks, on a second click, for that one site from
// optional_host_permissions (chrome.permissions.request) and fills again.
'use strict';

// Injection order. tests/extension/check.js checks this against the harness.
const CONTENT_FILES = ['content/text.js', 'content/rules.js', 'content/labels.js', 'content/setters.js', 'content/ui.js', 'content/engine.js', 'content/main.js'];

// Application systems whose embedded forms can be filled after the user allows
// that one site. Must equal manifest.json optional_host_permissions (tests check).
const JOB_SITES = [
  'https://*.greenhouse.io/*',
  'https://*.lever.co/*',
  'https://*.ashbyhq.com/*',
  'https://*.myworkdayjobs.com/*',
  'https://*.myworkday.com/*',
  'https://*.myworkdaysite.com/*',
  'https://*.smartrecruiters.com/*',
  'https://*.workable.com/*',
  'https://*.icims.com/*',
  'https://*.jobvite.com/*',
  'https://*.bamboohr.com/*',
  'https://*.oraclecloud.com/hcmUI/*',
  'https://*.rippling.com/*',
  'https://*.breezy.hr/*',
  'https://*.recruitee.com/*',
  'https://*.teamtailor.com/*',
  'https://*.jobbank.gc.ca/*',
];

// The JOB_SITES pattern a frame address falls under, or null.
function siteFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  for (const pattern of JOB_SITES) {
    const m = pattern.match(/^https:\/\/\*\.([^/]+)(\/.*)$/);
    const domain = m[1];
    const path = m[2].replace(/\*$/, '');
    if ((u.hostname === domain || u.hostname.endsWith('.' + domain)) && u.pathname.startsWith(path)) return { pattern, site: domain, host: u.hostname };
  }
  return null;
}

const CANT_RUN = 'Interview Helper can’t fill this page (browser pages, the Web Store and PDF viewers are off limits).';

async function fillTab(tabId, trigger) {
  // 1. Which frames can we reach, which already have the scripts, and what frames do they embed?
  let probe;
  try {
    probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        kit: Boolean(globalThis.JobKit && globalThis.JobKit.startFill),
        href: location.href,
        frames: Array.from(document.querySelectorAll('iframe[src], frame[src]'), (f) => f.src).slice(0, 50),
      }),
    });
  } catch {
    return { error: CANT_RUN };
  }
  const missing = probe.filter((r) => r.result && !r.result.kit).map((r) => r.frameId);
  if (missing.length) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: missing }, files: CONTENT_FILES });
    } catch {
      // Some frames may refuse injection; fill the ones we can.
    }
  }

  // 2. Fill every reachable frame.
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (t) => (globalThis.JobKit && globalThis.JobKit.startFill ? globalThis.JobKit.startFill(t) : null),
      args: [trigger || 'shortcut'],
    });
  } catch (e) {
    return { error: 'Could not fill this page: ' + (e && e.message ? e.message : e) };
  }
  const total = { frames: 0, filled: 0, already: 0, left: 0, leftItems: [], noProfile: false, blocked: [] };
  let topHasForm = false;
  for (const r of results) {
    const s = r && r.result;
    if (!s || !s.controls) {
      if (s && s.noProfile) total.noProfile = true;
      continue;
    }
    if (r.frameId === 0) topHasForm = true;
    total.frames += 1;
    total.filled += s.filled || 0;
    total.already += s.already || 0;
    total.left += s.left || 0;
    total.leftItems = total.leftItems.concat(s.leftItems || []);
    if (s.busy) total.busy = true;
  }

  // 3. Embedded application-system frames we could not reach (no host access yet).
  const reached = new Set();
  for (const r of probe) {
    try {
      reached.add(new URL(r.result.href).origin);
    } catch {
      // about:blank and similar.
    }
  }
  const seen = new Set();
  for (const r of probe) {
    for (const src of (r.result && r.result.frames) || []) {
      const hit = siteFor(src);
      if (!hit || reached.has(new URL(src).origin) || seen.has(hit.pattern)) continue;
      seen.add(hit.pattern);
      total.blocked.push(hit);
    }
  }

  if (total.frames) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#1b7f3b' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: String(total.filled) }).catch(() => {});
  } else if (total.blocked.length) {
    const sites = total.blocked.map((b) => b.site).join(', ');
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#b26b00' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: '!' }).catch(() => {});
    chrome.action.setTitle({ tabId, title: `The form is in a frame from ${sites}. Click here and press Fill this form to allow it.` }).catch(() => {});
  }
  // The shortcut can't ask for access (that needs a click in the popup): say so on the page.
  if (trigger === 'shortcut' && total.blocked.length && !topHasForm) {
    const sites = total.blocked.map((b) => b.host).join(', ');
    chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [0] },
        func: (msg) => globalThis.JobKit && globalThis.JobKit.ui && globalThis.JobKit.ui.showPanel(null, msg),
        args: [`The application form is inside a frame from ${sites}, which Interview Helper can’t reach yet. Click the Interview Helper button in the toolbar and press “Fill this form”; it will ask once to allow that site. Nothing was filled or submitted.`],
      })
      .catch(() => {});
  }
  return total;
}

// After the user allows a site from the popup, fill once, whether the popup is
// still open to ask (afterGrant) or closed when the browser showed the prompt
// (permissions.onAdded with the tab the popup armed just before asking).
let grantRun = null;
function fillAfterGrant(tabId) {
  if (grantRun && grantRun.tabId === tabId && Date.now() - grantRun.at < 15000) return grantRun.promise;
  const promise = fillTab(tabId, 'popup');
  grantRun = { tabId, at: Date.now(), promise };
  return promise;
}

chrome.permissions.onAdded.addListener(async (added) => {
  if (!added.origins || !added.origins.some((o) => JOB_SITES.includes(o))) return;
  const { armed } = await chrome.storage.session.get('armed');
  await chrome.storage.session.remove('armed');
  if (armed && typeof armed.tabId === 'number' && Date.now() - armed.at < 120000) fillAfterGrant(armed.tabId);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-page') return;
  const target = tab && tab.id ? tab : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (target && target.id) fillTab(target.id, 'shortcut');
});

// Only the extension's own pages (the popup) may ask for a fill; content
// scripts carry sender.tab, extension pages don't.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id || sender.tab || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  if (typeof msg.tabId !== 'number') return false;
  if (msg.type === 'jobkit:fill-tab') {
    (msg.afterGrant ? fillAfterGrant(msg.tabId) : fillTab(msg.tabId, 'popup')).then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === 'jobkit:arm-grant') {
    chrome.storage.session.set({ armed: { tabId: msg.tabId, at: Date.now() } }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});
