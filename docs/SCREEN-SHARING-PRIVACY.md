# Screen-sharing privacy controls

Settings → Screen sharing → **Screen-Sharing Privacy Mode** requests native
content protection for the copilot BrowserWindow. It defaults to off, takes
effect immediately, and is saved locally. On startup the preference is applied
before the window is first shown. Disable it to share the copilot itself.
The Coding Lab, dialogs, DevTools and other windows are outside this scope.

This is for presentations and assistance permitted by the meeting or assessment
organizer. It does not hide processes or defeat assessment/proctoring software.

## What the state means

The UI separately reports the saved preference, Electron's `isContentProtected()`
readback, and errors or mismatches. **Native protection enabled** is not a
verification of what a remote viewer receives. If the API fails, the preference
remains saved so it can be retried on restart; the UI reports the failure.
Unsupported platforms never call the native methods and show an explicit warning.

Official documentation checked on 2026-11-16:

- [Electron BrowserWindow content protection](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows)
- [Microsoft SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)

On Windows, Electron uses `WDA_EXCLUDEFROMCAPTURE`. Windows 10 version 2004+
supports exclusion; older versions can produce a black rectangle. A desktop
composition must occur before the change is reflected in capture. The preview
waits briefly, but this delay cannot guarantee any capture pipeline's behavior.
Remote Desktop and desktop-capturing remote-access products can behave differently.

On macOS, Electron sets NSWindow sharingType to NSWindowSharingNone. Electron
explicitly warns that newer applications using **ScreenCaptureKit can still
capture the protected window**. Treat this as unreliable for modern macOS
screen sharing, even when readback says enabled. Screen Recording permission
may be required for the local preview. Linux is unsupported.

Unsupported/unverified paths include external cameras, hardware capture, capture
implementations that ignore the OS restriction, and app-internal screenshots
(including Electron's own `capturePage`, which is not a protection test).

## Local preview

**Test local screen capture** uses Electron desktopCapturer on each display,
leaves protection enabled, and shows the time and native state. Toggling privacy
clears the previous images; an in-flight older capture is discarded. Images are
displayed locally and are not sent to AI providers by this workflow.
The preview does not test Zoom, Teams or Meet, nor individual-window sharing.

## Manual meeting verification

Use fictional notes and a second participant/device. For each row below, record
OS version/build, Electron version, meeting-app/browser version, capture source,
privacy setting, sender result, receiver result and recording result (if tested).
Leave a result **unverified** until observed remotely. A sender's preview alone
does not establish protection. Obtain consent before recording a test call.

| Meeting | Entire screen | Individual window |
|---|---|---|
| Zoom desktop | Share Screen → a display | Share Screen → a test presentation window, then copilot if selectable |
| Microsoft Teams desktop | Share → Screen | Share → Window → presentation, then copilot if selectable |
| Google Meet in Chrome/Edge | Present now → Your entire screen | Present now → A window → presentation, then copilot if selectable |

For each combination, on Windows and separately on macOS:

1. With privacy off, put a unique test phrase in the copilot; confirm the remote
   participant can see it during entire-screen sharing. Check a second display too.
2. Enable privacy while sharing. Wait for capture to update and ask the receiver
   whether the phrase disappeared, became black, or remained visible. Log what
   actually happens. Repeat with protection enabled before starting the share.
3. Share only the presentation window. Move the copilot over it; check the remote
   participant's view. If the copilot is selectable as a share source, test it
   explicitly too. Record whether it is absent from the picker, blank or visible.
4. Toggle privacy off again and confirm normal visibility returns. Stop/restart
   sharing and repeat. Inspect any permitted recording separately.
5. Resize, move, change opacity, compact/uncompact, pin/unpin, hide/show and
   minimize/restore via shortcuts while streaming a practice answer. Check
   microphone and call-audio transcription continue, with no missing answer text.
6. Quit and relaunch with privacy on, and then off. Confirm the preference and
   native status, and repeat the receiver-side capture checks.
7. On macOS explicitly test ScreenCaptureKit-based sharing: capture may remain
   visible. Log this as a limitation, never as a successful exclusion test.

## Automated versus manual evidence

Unit tests simulate Windows/macOS/unsupported platforms and native failures.
The window integration suite uses a real Electron window, native readback,
local screen capture, protection changes during a simulated AI stream, existing
shortcuts and fresh processes to test persisted on/off startup behavior.
These checks are not meeting-app tests and do not measure real-provider latency.
Actual Zoom, Teams, Meet, macOS and remote-session results must be recorded
separately. See the PR test report for the results from this implementation.

### Implementation run, 2026-11-16

- Windows 10.0.26300, Electron 44.10.1: syntax checks passed; 200 unit tests passed.
- Full end-to-end run: 332 passed, 4 failed. Failures were existing global
  shortcut checks (registration, compact, minimize, hide); the installed app was
  running and holding those key combinations. The new privacy checks passed.
- After closing the idle installed app normally, the affected window suite
  passed all 41 checks. Combined with the other 295 checks from the full run,
  all 336 checks passed across the full run and targeted rerun. The installed
  app was reopened afterward. This is not a claim of a clean single full run.
- Windows native readback, saved preference, fresh-process restart on/off,
  local preview, preview invalidation and simulated AI streaming passed.
- Additional `tests/e2e/privacy-capture.js` diagnostic: inconclusive. The
  synthetic marker was absent even with protection off (0 pixels off/on/off),
  so actual capture exclusion cannot be inferred. The script exits nonzero
  when this baseline is unavailable, rather than treating an empty capture as
  a successful privacy test. No screenshots were saved.
- Zoom/Teams/Meet receiver-side screen and window shares, macOS native behavior,
  remote-session capture and real audio during protection changes: unverified.
- UI review: existing primary-button contrast warnings remain outside this
  change. The new privacy controls use existing normal text/hint styles;
  no design warnings were suppressed.
