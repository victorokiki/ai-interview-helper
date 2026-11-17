const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createScreenPrivacy } = require('../../src/screen-privacy');
function windowStub() {
  let enabled = false;
  return { isDestroyed: () => false, setContentProtection: (v) => { enabled = v; }, isContentProtected: () => enabled };
}
for (const platform of ['win32', 'darwin']) {
  test(`${platform}: native state follows enable/disable; limits remain visible`, () => {
    const controller = createScreenPrivacy({ platform });
    const win = windowStub();
    assert.equal(controller.status(win).state, 'off');
    assert.equal(controller.apply(win, true).state, 'enabled');
    assert.equal(controller.status(win).requested, true);
    assert.match(controller.status(win).limitations, platform === 'darwin' ? /ScreenCaptureKit/ : /black rectangle/);
    // Measured on Windows: a window share already running keeps its last frame when protection turns on.
    if (platform === 'win32') assert.match(controller.status(win).limitations, /restart that share/);
    assert.equal(controller.apply(win, false).enabled, false);
    assert.equal(controller.status(win).state, 'off');
  });
}
test('unsupported platform never calls native API, preserves preference and permits off', () => {
  const p = createScreenPrivacy({ platform: 'linux' });
  const win = { setContentProtection() { throw new Error('must not call'); } };
  assert.equal(p.apply(win, true).state, 'unsupported');
  assert.equal(p.status(win).enabled, false);
  assert.equal(p.apply(win, false).requested, false);
});
test('native rejection and readback mismatch are not reported as success', () => {
  const p = createScreenPrivacy({ platform: 'win32' });
  const win = windowStub();
  win.setContentProtection = () => { throw new Error('OS rejected request'); };
  assert.equal(p.apply(win, true).state, 'failed');
  assert.match(p.status(win).error, /OS rejected/);
  win.setContentProtection = () => {};
  assert.equal(p.apply(win, true).state, 'failed');
  assert.equal(p.apply(win, false).state, 'off');
});
test('readback failure and unavailable window do not claim protection', () => {
  const p = createScreenPrivacy({ platform: 'darwin' });
  const win = windowStub();
  win.isContentProtected = () => { throw new Error('readback failed'); };
  assert.equal(p.apply(win, true).state, 'failed');
  assert.equal(p.apply(null, true).state, 'failed');
});
test('non-boolean inputs cannot silently enable protection', () => {
  const p = createScreenPrivacy({ platform: 'win32' });
  for (const value of ['false', 1, null, {}, undefined]) assert.throws(() => p.apply(windowStub(), value), /boolean/);
});
