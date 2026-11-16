// Identity of the browser extension bridge, shared by the app, the native
// messaging host and the tests.
//
// The extension's manifest carries a public key ("key"), which fixes its ID
// for unpacked installs. Only these extension origins may start the host; a
// Chrome Web Store or Edge Add-ons listing adds its own ID here.
const EXTENSION_IDS = ['ggejchpcmgenioaphbobmdgohgcjlfop'];

module.exports = {
  HOST_NAME: 'com.interviewhelper.bridge',
  EXTENSION_IDS,
  ALLOWED_ORIGINS: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
  // Browsers whose native messaging hosts are registered (Windows registry
  // under HKCU\Software\<key>, macOS folder under Application Support).
  // The registry paths need a real backslash: 'Google\Chrome' in a JS string
  // is 'GoogleChrome' (fixed in 0.18.1; until then only Chromium was found).
  BROWSERS: [
    { name: 'Google Chrome', win: 'Google\\Chrome', mac: 'Google/Chrome' },
    { name: 'Microsoft Edge', win: 'Microsoft\\Edge', mac: 'Microsoft Edge' },
    { name: 'Brave', win: 'BraveSoftware\\Brave-Browser', mac: 'BraveSoftware/Brave-Browser' },
    { name: 'Chromium', win: 'Chromium', mac: 'Chromium' },
  ],
  // Where versions before 0.18.1 wrote by mistake; removed on register and
  // unregister so nothing is left behind.
  LEGACY_WIN_KEYS: ['GoogleChrome', 'MicrosoftEdge', 'BraveSoftwareBrave-Browser'],
};
