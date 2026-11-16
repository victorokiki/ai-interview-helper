// Native window protection is a request to the OS, not proof of capture exclusion.
// Keep this independent of Electron so unsupported platforms and failures can be tested.
function createScreenPrivacy({ platform = process.platform, release = require('os').release() } = {}) {
  let requested = false;
  let error = '';
  const supported = platform === 'win32' || platform === 'darwin';
  function status(win) {
    let enabled = false;
    let failure = error;
    if (supported && win && !win.isDestroyed()) {
      try { enabled = win.isContentProtected(); } catch (e) { failure = e.message; }
    }
    const limitations = platform === 'darwin'
      ? 'macOS: ScreenCaptureKit-based capture can still show this window, even when native protection is enabled. Do not rely on this setting for modern screen sharing.'
      : platform === 'win32'
        ? 'Windows 10 version 2004 and later request exclusion from supported capture. Older Windows may show a black rectangle. Capture software and remote-session behavior vary; changes take effect after desktop composition.'
        : 'Native window content protection is unsupported on this operating system.';
    return { requested, supported, enabled, platform, release, error: failure,
      state: !supported ? 'unsupported' : failure || enabled !== requested ? 'failed' : enabled ? 'enabled' : 'off',
      limitations,
      scope: 'Copilot window only. Coding Lab, other windows and external cameras are not protected. This does not conceal the app from monitoring software.' };
  }
  function apply(win, value) {
    if (typeof value !== 'boolean') throw new TypeError('Privacy mode must be a boolean.');
    requested = value;
    error = '';
    if (supported && win && !win.isDestroyed()) {
      try { win.setContentProtection(value); } catch (e) { error = e.message; }
    }
    return status(win);
  }
  return { apply, status };
}
module.exports = { createScreenPrivacy };
