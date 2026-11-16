/*
 * Autofill - content script entry point (loaded last).
 *
 * Based on Autonomous Job Kit Autofill (MIT, see ../LICENSE-autonomous-job-kit.txt).
 *
 * Interview Helper has no always-on content scripts: background.js injects these files only when
 * the user asks for a fill (the popup's "Fill this form" button or Alt+Shift+F), then calls
 * JobKit.startFill(trigger) in each frame. There is no on-page button and no listener here.
 * Safe to inject more than once.
 *
 * Exposes JobKit.startFill(trigger) -> Promise<summary> (see engine.js).
 */
(function (root) {
  'use strict';
  var JK = root.JobKit = root.JobKit || {};
  if (JK.booted) return;
  JK.booted = true;

  var hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  function load() {
    if (!hasChrome) return Promise.resolve({});
    return chrome.storage.local.get(['profile', 'profileMeta', 'resume']).catch(function () { return {}; });
  }

  async function startFill(trigger) {
    var data = await load();
    var profile = data.profile;
    if (!profile || typeof profile !== 'object' || !Object.keys(profile).length) {
      if (!JK.labels.looksLikeForm(document)) return { controls: 0, noProfile: true };
      var msg = 'Autonomous report: no profile saved yet. Open the Interview Helper extension menu, choose Edit autofill profile and import profile.json, then fill again.';
      JK.ui.setReport(msg, []);
      JK.ui.showPanel(null, 'No autofill profile saved yet. Open the Interview Helper extension menu, choose "Edit autofill profile" and import your profile.json, then try again.');
      return { controls: 0, noProfile: true, report: msg };
    }
    return JK.engine.run({ profile: profile, profileMeta: data.profileMeta, resume: data.resume, trigger: trigger });
  }
  JK.startFill = startFill;
})(typeof globalThis !== 'undefined' ? globalThis : this);
