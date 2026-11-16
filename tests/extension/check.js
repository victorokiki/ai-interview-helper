#!/usr/bin/env node
/*
 * Interview Helper extension: Autofill checks (ported from Autonomous Job Kit, MIT).
 *
 * Usage (from the repo root):  node tests/extension/check.js [--no-browser]
 *
 *  1. manifest.json: valid JSON, MV3, least privilege (activeTab, scripting, nativeMessaging,
 *     storage; no host_permissions, no content_scripts; optional_host_permissions = the job-site
 *     list in background.js), files exist, injection order matches the fixture harness.
 *  2. `node --check` on every extension JS file; no network APIs anywhere in extension code;
 *     nothing that submits a form.
 *  3. profile.json round trip with tests/extension/profile.example.json (unknown keys and number
 *     types survive the editor; export/parse is lossless).
 *  4. Matching-rules table: sample questions -> expected field or "left" reason.
 *  5. Service worker with a stub chrome: on-demand injection, embedded-frame detection, the
 *     optional-permission flow, and who may ask for a fill.
 *  6. Fixture forms in headless Chrome / Edge / Chrome for Testing, or Electron when no browser is
 *     found (skipped with --no-browser): each fixture-*.html must end with "JOBKIT-TEST PASS n/n".
 * Prints one line per check and exits 1 when anything fails.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const vm = require('vm');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..', '..');
const EXT = path.join(REPO, 'extension');
let failures = 0;
function ok(name) { console.log('ok    ' + name); }
function fail(name, why) { failures++; console.log('FAIL  ' + name + (why ? ' - ' + why : '')); }
function test(name, fn) { try { fn(); ok(name); } catch (e) { fail(name, e.message); } }

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? walk(p) : [p];
  });
}

/* 1. manifest */
let manifest = null;
test('manifest.json is valid JSON (MV3)', () => {
  manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.manifest_version, 3);
  assert.ok(manifest.name && manifest.version && manifest.description);
  assert.ok(manifest.description.length <= 132, 'description longer than 132 characters');
});
const BG = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const listIn = (src, name) => src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\]'))[1].match(/'([^']+)'/g).map((x) => x.slice(1, -1));
const CONTENT_FILES = listIn(BG, 'CONTENT_FILES');
const JOB_SITES = listIn(BG, 'JOB_SITES');
if (manifest) {
  test('manifest permissions are least privilege', () => {
    assert.deepStrictEqual([...manifest.permissions].sort(), ['activeTab', 'nativeMessaging', 'scripting', 'storage']);
    assert.strictEqual(manifest.host_permissions, undefined, 'no required host permissions');
    assert.strictEqual(manifest.content_scripts, undefined, 'no always-on content scripts');
  });
  test('optional host permissions are only the job-site list in background.js', () => {
    assert.deepStrictEqual(manifest.optional_host_permissions, JOB_SITES);
    assert.ok(JOB_SITES.length > 10 && JOB_SITES.every((m) => /^https:\/\/\*\.[a-z.]+\/(hcmUI\/)?\*$/.test(m)), 'unexpected match pattern');
    assert.strictEqual(manifest.optional_permissions, undefined);
  });
  test('manifest files exist', () => {
    const files = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page, 'popup.js', 'grab.js', 'lib/jobpost.js', 'options/options.js', 'shared/profile-schema.js']
      .concat(Object.values(manifest.icons), Object.values(manifest.action.default_icon), CONTENT_FILES);
    files.forEach((f) => assert.ok(fs.existsSync(path.join(EXT, f)), 'missing ' + f));
  });
  test('injection order in background.js matches the fixture harness', () => {
    const harness = fs.readFileSync(path.join(__dirname, 'harness.js'), 'utf8');
    const files = harness.match(/var FILES = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map((x) => 'content/' + x.slice(1, -1));
    assert.deepStrictEqual(CONTENT_FILES, files);
  });
  test('Alt+Shift+F command declared', () => {
    assert.strictEqual(manifest.commands['fill-page'].suggested_key.default, 'Alt+Shift+F');
  });
  test('icons are PNGs of the declared size', () => {
    Object.entries(manifest.icons).forEach(([size, f]) => {
      const b = fs.readFileSync(path.join(EXT, f));
      assert.strictEqual(b.slice(1, 4).toString(), 'PNG');
      assert.strictEqual(b.readUInt32BE(16), Number(size));
    });
  });
}

/* 2. syntax and no network */
const jsFiles = walk(EXT).filter((f) => f.endsWith('.js'));
jsFiles.concat(walk(__dirname).filter((f) => f.endsWith('.js'))).forEach((f) => {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status === 0) ok('node --check ' + path.relative(REPO, f));
  else fail('node --check ' + path.relative(REPO, f), r.stderr.trim().split('\n')[0]);
});
test('no network APIs in extension code', () => {
  jsFiles.concat(walk(EXT).filter((f) => f.endsWith('.html'))).forEach((f) => {
    const src = fs.readFileSync(f, 'utf8');
    const bad = src.match(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts\s*\(|https?:\/\/(?!\*\.)/);
    assert.ok(!bad, path.relative(REPO, f) + ' uses ' + (bad && bad[0]));
  });
});
test('nothing in the extension submits a form', () => {
  jsFiles.forEach((f) => {
    const bad = fs.readFileSync(f, 'utf8').match(/\.submit\s*\(|requestSubmit/);
    assert.ok(!bad, path.relative(REPO, f) + ' uses ' + (bad && bad[0]));
  });
});

/* 3. profile.json round trip */
const S = require(path.join(EXT, 'shared', 'profile-schema.js'));
const exampleText = fs.readFileSync(path.join(__dirname, 'profile.example.json'), 'utf8');
const example = S.parseProfileText(exampleText);
test('import -> editor -> save keeps profile.example.json identical', () => {
  const back = S.applyFormValues(example, S.formValuesFromProfile(example));
  assert.deepStrictEqual(back, example);
  assert.deepStrictEqual(Object.keys(back), Object.keys(example), 'key order changed');
});
test('export -> import is lossless', () => {
  assert.deepStrictEqual(S.parseProfileText(S.exportProfileText(example)), example);
});
test('editing one field keeps unknown keys and types', () => {
  const v = S.formValuesFromProfile(example);
  v.scalars.city = 'Dartmouth';
  v.lists.education[0].gpa = '3.9';
  v.lists.work.splice(0, 1); // remove the first job
  v.lists.savedAnswers.push({ match: 'pronouns', answer: 'they/them' });
  const out = S.applyFormValues(example, v);
  assert.strictEqual(out.city, 'Dartmouth');
  assert.strictEqual(out.education[0].gpa, '3.9');
  assert.strictEqual(out.work.length, 1);
  assert.strictEqual(out.work[0].company, 'Bluenose Outfitters');
  assert.strictEqual(out.savedAnswers.length, example.savedAnswers.length + 1);
  ['_comment', 'projects', 'writingStyle', 'extraRules', 'automationLevel', 'bulletFormula', 'coverLetterPolicy', 'letterStyle', 'combinedOrder']
    .forEach((k) => assert.deepStrictEqual(out[k], example[k], k + ' changed'));
  assert.strictEqual(out.resumeMaxPages, 2);
  assert.strictEqual(out.letterMaxWords, 250);
  assert.strictEqual(out.alwaysCombine, true);
  assert.strictEqual(out.yearsExperience, '2');
});
test('empty new fields are not added; numbers stay numbers', () => {
  const p = { firstName: 'Alex', yearsExperience: 3, custom: { a: 1 } };
  const out = S.applyFormValues(p, S.formValuesFromProfile(p));
  assert.deepStrictEqual(out, p);
});
test('bad imports are rejected with a message', () => {
  assert.throws(() => S.parseProfileText('[1,2]'), /one JSON object/);
  assert.throws(() => S.parseProfileText('{oops'), /not valid JSON/);
  assert.deepStrictEqual(S.parseProfileText('\uFEFF{"a":1}'), { a: 1 });
});

/* 4. rules table */
global.JobKit = {};
const T = require(path.join(EXT, 'content', 'text.js'));
global.JobKit.text = T;
const R = require(path.join(EXT, 'content', 'rules.js'));
const profile = Object.assign({}, example, {
  street: '123 Example Street', postalCode: 'B3H 0A1', gender: 'decline', race: 'white', veteranStatus: 'no',
  needsSponsorship: 'no', needsSponsorshipForInternship: 'yes'
});
function q(text, control, extra) {
  return Object.assign({ text: text, label: T.norm(text), context: '', control: control || 'text', inputType: 'text', quality: 'label' }, extra || {});
}
const CASES = [
  // [question, control, expected rule (or "left:<reason>"), extra]
  ['First Name *', 'text', 'first name'],
  ['Legal first name', 'text', 'first name'],
  ['Last name', 'text', 'last name'],
  ['Full name', 'text', 'full name'],
  ['Name', 'text', 'full name'],
  ['Preferred name', 'text', 'preferred name'],
  ['E-mail address', 'text', 'email'],
  ['Phone number', 'text', 'phone'],
  ['Country phone code', 'select', 'phone country code'],
  ['Address line 1', 'text', 'street'],
  ['Address line 2', 'text', 'left:unknown question'],
  ['City', 'text', 'city'],
  ['State/Province', 'select', 'province / state'],
  ['ZIP / Postal code', 'text', 'postal code'],
  ['Country', 'select', 'country'],
  ['Country of citizenship', 'select', 'left:unknown question'],
  ['LinkedIn profile', 'text', 'LinkedIn'],
  ['GitHub URL', 'text', 'GitHub'],
  ['School name', 'text', 'school'],
  ['Field of study', 'text', 'field of study'],
  ['Highest degree', 'select', 'degree'],
  ['Expected graduation date', 'text', 'graduation date'],
  ['Are you currently enrolled in a degree program?', 'radio', 'currently enrolled'],
  ['Years of experience', 'select', 'years of experience'],
  ['Are you legally authorized to work in Canada?', 'radio', 'work authorization'],
  ['Are you legally authorized to work in the United States?', 'radio', 'left:other-country'],
  ['Will you now or in the future require sponsorship?', 'radio', 'sponsorship'],
  ['Do you require visa sponsorship?', 'radio', 'left:ambiguous'],
  ['Will you require sponsorship for this internship?', 'radio', 'sponsorship'],
  ['Are you willing to relocate?', 'radio', 'relocation'],
  ['Is a member of your family employed by a government?', 'radio', 'government relative'],
  ['Have you worked for the government?', 'radio', 'government employee'],
  ['Are you able to work on-site three days a week?', 'radio', 'left:unknown question'],
  ['Desired salary', 'text', 'left:not in profile'],
  ['Gender', 'select', 'gender'],
  ['Race / Ethnicity', 'select', 'race / ethnicity'],
  ['Veteran status', 'select', 'veteran status'],
  ['Pronouns', 'select', 'left:not in profile'],
  ['How did you hear about us?', 'select', 'saved answer "how did you hear"'],
  ['How did you hear about us?', 'textarea', 'saved answer "how did you hear"'],
  ['Why do you want to work here?', 'textarea', 'left:open-ended'],
  ['Social Security Number', 'text', 'left:sensitive'],
  ['SIN', 'text', 'left:sensitive'],
  ['Date of birth', 'text', 'left:sensitive'],
  ['Have you been convicted of a crime?', 'radio', 'left:sensitive'],
  ['Marital status', 'select', 'left:sensitive'],
  ['Religion', 'select', 'left:sensitive'],
  ['Passport number', 'text', 'left:sensitive'],
  ['I agree to the terms and conditions', 'checkbox', 'left:consent'],
  ['I certify that my answers are true', 'checkbox', 'left:consent'],
  ['Emergency contact first name', 'text', 'left:not about you'],
  ['Resume/CV', 'file', 'resume'],
  ['Cover letter', 'file', 'left:file'],
  ['first name', 'text', 'first name', { quality: 'hint' }],
  ['salary', 'text', 'left:low confidence', { quality: 'hint' }],
  ['Start date', 'text', 'start date'],
  ['From', 'text', 'work start', { context: 'work experience' }],
  ['From', 'text', 'education start', { context: 'education' }],
  ['Are you willing to relocate?', 'radio', 'relocation', { context: 'education' }],
  ['Earliest start date', 'text', 'available from', { context: 'education and availability' }],
  ['Will you require sponsorship for this co-op work term?', 'radio', 'sponsorship'],
  ['Will you now or in the future require sponsorship for a visa to remain in your current location?', 'combobox', 'sponsorship'],
  ['Current location', 'combobox', 'location'],
  ['Are you currently located in the United States or Canada?', 'combobox', 'located in country'],
  ['Do you live in the United Kingdom?', 'radio', 'located in country'],
  ['Are you located in Ontario?', 'radio', 'left:not in profile'],
  ['Are you willing to relocate to Toronto?', 'radio', 'relocation'],
  ["What's the name you'd prefer us to use throughout the interview process?", 'text', 'preferred name'],
  ['Have you previously worked at or consulted for GitLab?', 'combobox', 'worked here before'],
  ['Have you ever worked for us before?', 'radio', 'left:not in profile'],
  ['Have you previously applied to Northwind?', 'radio', 'left:unknown question'],
  ['Preferred work arrangement', 'select', 'work arrangement'],
  ['Preferred start date', 'text', 'start date'],
  ["Do you have a valid driver's licence?", 'radio', 'left:unknown question'],
  ["Driver's licence number", 'text', 'left:sensitive'],
  ['Do you have relatives who are government officials?', 'radio', 'government relative'],
  ['Please tell us how you heard about this opportunity.', 'select', 'saved answer "how did you hear"'],
  ['Where did you first learn about this role?', 'select', 'saved answer "how did you hear"'],
  ['Name Pronunciation | How do you pronounce your name?', 'text', 'left:unknown question'],
  ['Pronouns', 'select', 'left:not in profile']
];
CASES.forEach(([text, control, want, extra]) => {
  const d = R.decide(q(text, control, extra), profile, {});
  const got = d.ok ? d.rule : 'left:' + d.reason;
  if (got === want) ok('rule: "' + text + '" -> ' + want);
  else fail('rule: "' + text + '"', 'expected ' + want + ', got ' + got);
});
test('located-in answers yes for a listed country and no otherwise', () => {
  const yes = R.decide(q('Are you currently located in the United States or Canada?', 'combobox'), profile, {});
  const no = R.decide(q('Are you based in the United Kingdom?', 'radio'), profile, {});
  assert.strictEqual(yes.want.value, 'yes');
  assert.strictEqual(no.want.value, 'no');
});
test('worked-here answers from the work history', () => {
  const no = R.decide(q('Have you previously worked at or consulted for GitLab?', 'combobox'), profile, {});
  const yes = R.decide(q('Have you previously worked for Harbourline Logistics?', 'radio'), profile, {});
  assert.strictEqual(no.want.value, 'no');
  assert.strictEqual(yes.want.value, 'yes');
});
test('open-to-all work arrangement prefers a flexible option, then on-site', () => {
  const P = Object.assign({}, profile, { workPreference: 'Open to remote, hybrid or on-site' });
  const d = R.decide(q('Preferred work arrangement', 'select'), P, {});
  const pick = (opts) => d.want.matchers.findIndex((m) => opts.some(m));
  assert.strictEqual(d.rule, 'work arrangement');
  assert.ok(d.want.matchers[0]('No preference'));
  assert.ok(d.want.matchers[1]('On-site') && !d.want.matchers[1]('Remote'));
  assert.strictEqual(pick(['Remote', 'Hybrid', 'On-site']), 1);
});
test('heard-about answers pick the employer careers site option', () => {
  const P = Object.assign({}, profile, { savedAnswers: [{ match: 'how did you hear', answer: 'Company careers page' }] });
  const d = R.decide(q('Please tell us how you heard about this opportunity.', 'select'), P, {});
  const opts = ['Agency or Non-Palantir Recruiter', 'Glassdoor', 'Job Board (Indeed, etc.)', 'Palantir Careers Site', 'Campus Ambassador'];
  assert.strictEqual(opts.findIndex(d.want.matchers[0]), 3);
});
test('phone splits when the form has a country-code field', () => {
  const d = R.decide(q('Phone number'), profile, { hasPhoneCode: true });
  assert.strictEqual(d.want.text, '(902) 555-0142');
});
test('option matching: yes/no, provinces, countries, ranges, self-ID', () => {
  const o = (arr) => arr.map((t) => ({ text: t, value: t }));
  assert.strictEqual(T.pickOption(o(['Select...', 'Yes', 'No']), { matcher: (t) => T.classifyYesNo(t) === 'no' }), 2);
  assert.strictEqual(T.pickOption(o(['--', 'Ontario', 'Nova Scotia']), { text: 'NS', aliases: T.regionAliases('NS') }), 2);
  assert.strictEqual(T.pickOption(o(['United States', 'Canada']), { text: 'CA', aliases: T.countryAliases('CA') }), 1);
  assert.strictEqual(T.pickOption(o(['USA', 'UK']), { text: 'United Kingdom', aliases: T.countryAliases('United Kingdom') }), 1);
  assert.strictEqual(T.pickOption(o(['Less than 1 year', '1-2 years', '3-5 years', '5+ years']), { text: '4', number: 4 }), 2);
  assert.strictEqual(T.pickOption(o(['I am a protected veteran', 'I am not a protected veteran', 'I prefer not to say']), { matcher: T.choiceMatcher('veteranStatus', 'no') }), 1);
  assert.strictEqual(T.pickOption(o(['Male', 'Female', 'Prefer not to say']), { matcher: T.choiceMatcher('gender', 'female') }), 1);
  assert.strictEqual(T.pickOption(o(['Male', 'Female', 'Prefer not to say']), { matcher: T.choiceMatcher('gender', 'male') }), 0);
  assert.strictEqual(T.pickOption(o(['Accounting', 'Finance']), { text: 'Business Analytics' }), -1);
});
test('dates format per control', () => {
  assert.strictEqual(T.formatDate('Apr 2023', 'month'), '2023-04');
  assert.strictEqual(T.formatDate('2023-04-28', 'date'), '2023-04-28');
  assert.strictEqual(T.formatDate('Apr 2023', 'date'), '');
  assert.strictEqual(T.formatDate('Jun 2024', 'mmyyyy'), '06/2024');
  assert.strictEqual(T.formatDate('September 3, 2019', 'year'), '2019');
});

/* 5. service worker with a stub chrome */
// Runs the real background.js in a vm with a fake chrome.* that plays a tab's frames.
function loadWorker(frames, opts = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => { listeners[name] = fn; } });
  const calls = { inject: [], fills: 0, badge: [], title: [], panel: [] };
  const session = {};
  const reachable = () => frames.filter((f) => f.reachable !== false);
  const chrome = {
    runtime: { id: 'ext', getURL: (p) => 'chrome-extension://ext/' + p, onMessage: on('message') },
    permissions: { onAdded: on('permAdded') },
    commands: { onCommand: on('command') },
    tabs: { query: async () => [{ id: 7 }] },
    storage: { session: {
      get: async (k) => ({ [k]: session[k] }),
      set: async (o) => { Object.assign(session, o); },
      remove: async (k) => { delete session[k]; }
    } },
    action: {
      setBadgeText: async (o) => { calls.badge.push(o.text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async (o) => { calls.title.push(o.title); }
    },
    scripting: {
      executeScript: async (inj) => {
        if (opts.forbidden) throw new Error('Cannot access contents of the page.');
        if (inj.files) {
          inj.target.frameIds.forEach((id) => { frames.find((f) => f.frameId === id).kit = true; });
          calls.inject.push(inj.target.frameIds.slice());
          return inj.target.frameIds.map((frameId) => ({ frameId, result: null }));
        }
        if (inj.target.frameIds) { calls.panel.push(inj.args[0]); return [{ frameId: 0, result: undefined }]; }
        if (inj.args) {
          calls.fills++;
          return reachable().map((f) => ({ frameId: f.frameId, result: f.kit ? { controls: f.form || 0, filled: f.form || 0, already: 0, left: 0, leftItems: [] } : null }));
        }
        return reachable().map((f) => ({ frameId: f.frameId, result: { kit: !!f.kit, href: f.href, frames: f.frames || [] } }));
      }
    }
  };
  const ctx = vm.createContext({ chrome, URL, console, setTimeout, Date });
  vm.runInContext(BG, ctx, { filename: 'background.js' });
  const send = (msg, sender) => new Promise((resolve) => {
    const isAsync = listeners.message(msg, sender, resolve);
    if (!isAsync) resolve('ignored');
  });
  return { ctx, calls, listeners, send, session };
}
const POPUP = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
const GH = 'https://boards.greenhouse.io/embed/job_app?for=contoso&token=1';
const companyPage = () => [
  { frameId: 0, href: 'https://careers.contoso.com/jobs/1', frames: [GH, 'https://www.youtube.com/embed/x', 'about:blank'], form: 0 },
  { frameId: 3, href: GH, form: 12, reachable: false }
];
const tick = () => new Promise((r) => setTimeout(r, 5));

async function workerChecks() {
  async function atest(name, fn) { try { await fn(); ok(name); } catch (e) { fail(name, e.message); } }

  await atest('worker: siteFor matches only the listed application systems', () => {
    const { ctx } = loadWorker([]);
    assert.strictEqual(ctx.siteFor('https://acme.wd5.myworkdayjobs.com/en-US/x').pattern, 'https://*.myworkdayjobs.com/*');
    assert.strictEqual(ctx.siteFor(GH).host, 'boards.greenhouse.io');
    assert.strictEqual(ctx.siteFor('https://x.oraclecloud.com/hcmUI/CandidateExperience').site, 'oraclecloud.com');
    ['https://evilgreenhouse.io/', 'http://boards.greenhouse.io/x', 'https://x.oraclecloud.com/other', 'https://greenhouse.io.evil.com/', 'not a url']
      .forEach((u) => assert.strictEqual(ctx.siteFor(u), null, u));
  });

  await atest('worker: an embedded Greenhouse frame activeTab cannot reach is reported, not requested', async () => {
    const w = loadWorker(companyPage());
    const r = await w.ctx.fillTab(7, 'popup');
    assert.strictEqual(r.frames, 0);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.blocked)), [{ pattern: 'https://*.greenhouse.io/*', site: 'greenhouse.io', host: 'boards.greenhouse.io' }]);
    assert.deepStrictEqual(w.calls.inject, [[0]], 'scripts injected only into the frame the user clicked on');
    assert.deepStrictEqual(w.calls.badge, ['!']);
    assert.strictEqual(w.calls.panel.length, 0, 'the popup explains it, not the page');
  });

  await atest('worker: Alt+Shift+F on such a page says on the page how to allow it', async () => {
    const w = loadWorker(companyPage());
    w.listeners.command('fill-page', { id: 7 });
    for (let i = 0; i < 40 && !w.calls.panel.length; i++) await tick();
    assert.match(w.calls.panel[0] || '', /frame from boards\.greenhouse\.io.*Fill this form.*Nothing was filled or submitted/);
  });

  await atest('worker: after the site is allowed (arm, then onAdded) the frame is filled once', async () => {
    const frames = companyPage();
    const w = loadWorker(frames);
    await w.ctx.fillTab(7, 'popup');
    const fillsBefore = w.calls.fills;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await w.send({ type: 'jobkit:arm-grant', tabId: 7 }, POPUP))), { ok: true });
    frames[1].reachable = true; // the browser now lets the extension into *.greenhouse.io frames
    await w.listeners.permAdded({ origins: ['https://*.greenhouse.io/*'] });
    const r = await w.send({ type: 'jobkit:fill-tab', tabId: 7, afterGrant: true }, POPUP); // the popup, if still open
    assert.strictEqual(r.frames, 1);
    assert.strictEqual(r.filled, 12);
    assert.strictEqual(r.blocked.length, 0);
    assert.strictEqual(w.calls.fills - fillsBefore, 1, 'popup and onAdded share one fill');
    assert.deepStrictEqual(w.calls.inject, [[0], [3]], 'already-injected frames are not injected again');
    assert.strictEqual(w.session.armed, undefined, 'arming is used once');
  });

  await atest('worker: onAdded without arming, or for another site, fills nothing', async () => {
    const w = loadWorker(companyPage());
    await w.listeners.permAdded({ origins: ['https://*.greenhouse.io/*'] });
    await w.send({ type: 'jobkit:arm-grant', tabId: 7 }, POPUP);
    await w.listeners.permAdded({ origins: ['https://example.com/*'] });
    assert.strictEqual(w.calls.fills, 0);
  });

  await atest('worker: a form on the application system itself needs no extra access', async () => {
    const w = loadWorker([{ frameId: 0, href: GH, form: 9 }]);
    const r = await w.ctx.fillTab(7, 'popup');
    assert.strictEqual(r.filled, 9);
    assert.strictEqual(r.blocked.length, 0);
    assert.deepStrictEqual(w.calls.badge, ['9']);
  });

  await atest('worker: only the popup may ask for a fill (not content scripts or other extensions)', async () => {
    const w = loadWorker(companyPage());
    const page = { id: 'ext', url: 'https://careers.contoso.com/', tab: { id: 7 } };
    assert.strictEqual(await w.send({ type: 'jobkit:fill-tab', tabId: 7 }, page), 'ignored');
    assert.strictEqual(await w.send({ type: 'jobkit:fill-tab', tabId: 7 }, { id: 'other', url: 'chrome-extension://other/x.html' }), 'ignored');
    assert.strictEqual(await w.send({ type: 'jobkit:arm-grant', tabId: 7 }, page), 'ignored');
    assert.strictEqual(await w.send({ type: 'jobkit:fill-tab', tabId: '7' }, POPUP), 'ignored');
    assert.strictEqual(w.calls.fills, 0);
    assert.strictEqual(w.session.armed, undefined);
  });

  await atest('worker: pages the extension may not touch give a plain message', async () => {
    const w = loadWorker([], { forbidden: true });
    assert.match((await w.ctx.fillTab(7, 'popup')).error, /can’t fill this page/);
  });
}

/* 6. fixtures in a headless browser */
function findBrowser() {
  const local = process.env.LOCALAPPDATA || '';
  const pw = path.join(local, 'ms-playwright');
  const cft = fs.existsSync(pw)
    ? fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => b.split('-')[1] - a.split('-')[1]).map((d) => path.join(pw, d, 'chrome-win64', 'chrome.exe'))
    : [];
  const c = [process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ...cft,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return c.find((p) => p && fs.existsSync(p));
}

function fixtureResult(f, title, pre) {
  if (/^JOBKIT-TEST PASS/.test(title)) return ok('fixture ' + f + ': ' + title.replace('JOBKIT-TEST ', ''));
  fail('fixture ' + f, title);
  console.log(pre.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').split('\n').filter((l) => /^FAIL|error|Harness/.test(l)).map((l) => '        ' + l).join('\n'));
}

function fixtures() {
  if (process.argv.includes('--no-browser')) return console.log('skip  fixture forms (--no-browser)');
  const files = fs.readdirSync(__dirname).filter((f) => /^fixture-.*\.html$/.test(f)).sort();
  const browser = !process.argv.includes('--electron') && findBrowser();
  if (browser) {
    console.log('      fixtures in ' + browser);
    const os = require('os');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ih-autofill-chrome-'));
    files.forEach((f) => {
      const url = pathToFileURL(path.join(__dirname, f)).href;
      const r = spawnSync(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--user-data-dir=' + profileDir, '--allow-file-access-from-files', '--virtual-time-budget=20000', '--dump-dom', url],
        { encoding: 'utf8', timeout: 90000 });
      const dom = r.stdout || '';
      fixtureResult(f, (dom.match(/<title>([^<]*)<\/title>/) || [])[1] || '(no title)', (dom.match(/<pre id="jk-results"[^>]*>([\s\S]*?)<\/pre>/) || [])[1] || '');
    });
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    return;
  }
  // No Chrome or Edge (or --electron): the app's own Electron (Chromium) runs the same pages.
  let electron;
  try { electron = require('electron'); } catch (e) { return console.log('skip  fixture forms (no Chrome, Edge or Electron found)'); }
  console.log('      fixtures in Electron ' + electron);
  const outFile = path.join(require('os').tmpdir(), 'ih-autofill-fixtures-' + process.pid + '.json');
  const r = spawnSync(electron, [path.join(__dirname, 'electron-fixtures.js'), '--out=' + outFile, ...files.map((f) => path.join(__dirname, f))], { encoding: 'utf8', timeout: 180000 });
  if (!fs.existsSync(outFile)) return fail('fixture forms in Electron', (r.stderr || 'no output').slice(0, 300));
  const results = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.rmSync(outFile, { force: true });
  results.forEach((x) => fixtureResult(x.file, x.title, x.pre));
}

workerChecks().then(() => {
  fixtures();
  console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
});
