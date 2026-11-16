// Preload for the UI tour's extension popup: a stand-in for the Chrome API
// that answers like a connected app. Not used by the tests.
const fs = require('fs');
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const raw = JSON.parse(fs.readFileSync(arg('raw'), 'utf8'));
const version = require('../../package.json').version;
// A made-up autofill profile (the tour's demo person), for the popup and options page.
const PROFILE = {
  firstName: 'Jordan', lastName: 'Lee', email: 'jordan.lee@example.com', phone: '+1 (206) 555-0142',
  city: 'Seattle', state: 'WA', country: 'United States', linkedin: 'linkedin.com/in/jordan-lee-example',
  work: [{ title: 'Senior Site Reliability Engineer', company: 'Northwind Traders', location: 'Seattle, WA', start: 'Jan 2021', end: 'Present', highlights: 'Led the on-call redesign for 6 teams.' }],
  education: [{ school: 'University of Lagos', degree: 'BSc', field: 'Computer Science', start: '2012', end: '2016' }],
  workAuthorized: 'yes', authCountry: 'United States', needsSponsorship: 'no', willingToRelocate: 'no',
  savedAnswers: [{ match: 'notice period', answer: 'Two weeks' }, { match: 'how did you hear', answer: 'Company careers page' }],
};
const store = { profile: PROFILE, profileMeta: { source: 'imported', date: '2026-11-16' } };
const area = { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in store).map((k) => [k, store[k]])), set: async (o) => Object.assign(store, o), remove: async () => {} };
const chromeApi = {
  runtime: {
    lastError: undefined,
    id: 'tour',
    sendNativeMessage: (_h, msg, cb) => setTimeout(() => cb(msg.type === 'ping' ? { ok: true, app: 'Interview Helper', version } : { ok: true })),
    sendMessage: async () => ({ ok: true }),
    openOptionsPage: () => {},
    getURL: (p) => p,
    onMessage: { addListener: () => {} },
  },
  tabs: { query: async () => [{ id: 1, url: raw.url }] },
  scripting: { executeScript: async () => [{ result: raw }] },
  storage: { local: area, session: area, onChanged: { addListener: () => {} } },
  permissions: { request: async () => false, contains: async () => false },
};
Object.defineProperty(window, 'chrome', { value: chromeApi, configurable: true, writable: true });
