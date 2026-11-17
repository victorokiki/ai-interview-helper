# Screen-Sharing Privacy Mode — verification, 2026-11-16

What was tested: the **installed** Interview Helper 0.18.4 (merged PR #1,
`src/screen-privacy.js` → `BrowserWindow.setContentProtection`). The app ran
from `%LOCALAPPDATA%\Programs\Interview Helper\Interview Helper.exe` with a
separate, synthetic profile (`--user-data-dir`): fake local AI server, no keys,
no personal data. The user's own profile was not changed (privacy still off).
No meetings were joined and no paid APIs were called.

"Native status" means the window's display affinity, read from outside the app
with `GetWindowDisplayAffinity`. "Capture result" means what an independent
capture method actually received. The first does not prove the second.

## Environment

| Item | Version |
|---|---|
| OS | Windows 11 Pro 26H2, build 26300.9974; one display 2560×1440 at 100% |
| Interview Helper | 0.18.4 (installed), Electron 44.10.1, Chromium 152.0.7977.169 |
| Google Chrome | 157.0.8103.51 |
| Microsoft Edge | 157.0.4341.60 |
| Microsoft Teams (new) | 26015.1706.4351.4392, installed; not used (needs a meeting) |
| Zoom | not installed |
| macOS | not available |

## Method

A synthetic magenta "presentation" window (text: SYNTHETIC PRESENTATION — TEST
ONLY) sat behind the copilot window. In each state, each capture method
reported:
- **Copilot area:** the share of the copilot's area showing magenta. 0% means
  the copilot was captured; 100% means it was left out and the window behind
  it showed through.
- **Control area:** a magenta strip next to the copilot. It must be visible
  every time for the result to count.

Capture methods:
- GDI BitBlt (`Graphics.CopyFromScreen`), the legacy capture path.
- Electron 44 `desktopCapturer`: screen thumbnail, a live screen stream, and a
  live window stream.
- Chrome 157 and Edge 157 `getDisplayMedia`, as live streams. This is the API
  Google Meet uses in the browser. Each ran from a temporary profile with the
  share source chosen automatically.

The privacy setting was changed by clicking the real Settings checkbox (over a
local debugging port). Shortcuts were real key presses sent through Windows.
The harness and raw results are in the session scratchpad. Copies of the
results and three images (synthetic content only) are in
[`privacy-evidence-2026-11-16/`](privacy-evidence-2026-11-16/).

**Why the earlier diagnostic was inconclusive:** on this PC the marker
(247,13,211) is captured as roughly (228,50,206). `tests/e2e/privacy-capture.js`
only accepts a difference of ±12 per channel, so it found 0 matching pixels even
when the marker was plainly visible. That was a test bug, not a missing
baseline. With a colour-range check the baseline was visible in every capture
method. **Fixed:** the diagnostic now uses that range and passes (15,261 marker
pixels off → 11 on → 15,261 restored). Settings now also tells you to restart a
share of the copilot window itself after switching (cases 4c and 4d); that text
reaches the installed app with the next build.

## Results

| # | Case | Result | Evidence |
|---|---|---|---|
| 1 | Settings toggle OFF → ON → OFF | **PASS** | Native: `WDA_NONE` → `WDA_EXCLUDEFROMCAPTURE` (17) → `WDA_NONE`. Electron readback, Settings status text and saved `screenSharePrivacy` matched at each step. Status text: "Native protection enabled — capture exclusion is not verified." |
| 2 | Preference survives restart (ON, then OFF) | **PASS** | Quit and relaunch with ON saved: the first native reading (0.92 s, the moment the window first appeared) was already 17. With OFF saved it was `WDA_NONE`. Repeated in two runs. Capture after restart: ON gave 100% copilot area / 98% control; OFF gave 0% / 98%. |
| 3a | Entire screen, GDI BitBlt | **PASS** | Copilot area OFF 0% → ON 100% → OFF 0%; control 97.8% throughout. |
| 3b | Entire screen, Electron desktopCapturer (thumbnail and live stream) | **PASS** | 0% → 100% → 0%; control 98.0%. |
| 3c | Entire screen, Chrome 157, share already running when privacy changes | **PASS** | 0% → 100% → 0%; control 98.0%. |
| 3d | Entire screen, Edge 157, share already running | **PASS** | 0% → 100% → 0%; control 98.0%. |
| 3e | Entire screen, privacy ON before sharing starts (GDI, Electron, Chrome) | **PASS** | Copilot area 100% at the first frame. |
| 4a | Sharing a *different* window (the presentation) with the copilot over it, in Chrome 157 and Electron | **PASS**, but not because of this feature | The copilot never appeared in the shared window, with privacy OFF or ON (overlap area 100% magenta). Window capture records only the chosen window. Apps that crop the screen to a window's rectangle instead would behave like entire-screen sharing. |
| 4b | Sharing the copilot window *itself*, with privacy ON before the share starts | **PASS** | Chrome 157 delivered a black 2×2 frame; Electron a black frame. The copilot is still listed as a share source, with a blank thumbnail. |
| 4c | Sharing the copilot window itself, with privacy turned ON *during* the share | **FAIL** | Chrome 157 and Electron froze on the last frame from before protection (the Settings tab) and kept sending it. A new phrase typed afterwards (LIVECHECK 7731) did not appear. A viewer keeps seeing that stale image until the share is restarted. See image 3. |
| 4d | Sharing the copilot window itself, with privacy turned OFF during the share | **FAIL** (usability) | The stream stayed black until the share was restarted. Entire-screen sharing recovered immediately. |
| 5 | Compact view (Ctrl+Shift+Y), opacity 0.5, minimize/restore (Ctrl+Shift+U), hide/show (Ctrl+Shift+H) with privacy ON | **PASS** | Native status stayed 17 throughout, including while minimized. The copilot area was 100% excluded after each step (GDI, Electron, Chrome), including at the compact size (376×328). |
| 6 | AI answer streaming while privacy is toggled mid-stream, with compact and hide/show (fake local server) | **PASS** | 40 of 40 chunks arrived, from one request. Native status was 17 at the end, and the copilot was excluded while streaming. No paid API was called. |
| 7 | Transcription with privacy ON | **NOT TESTED** | No local Whisper model is installed (it would need a download), and Deepgram would bill. The code shows privacy only calls `setContentProtection` on the window and doesn't touch audio capture, but that is reading the code, not a test. |
| 8 | Zoom desktop, entire screen and window | **NOT TESTED** | Zoom is not installed. |
| 9 | Teams desktop, entire screen and window | **NOT TESTED** | Teams is installed, but sharing needs a meeting and a second participant. |
| 10 | Google Meet, entire screen and window | **INCONCLUSIVE** | Chrome and Edge 157's own capture passed (3c, 3d, 4b, 4c). Meet's encoding and the remote view were not tested. |
| 11 | What a second participant sees (all apps) | **NOT TESTED** | Needs a second device or person; see the guide below. Leave unverified until observed. |
| 12 | macOS | **NOT TESTED** | No Mac. See the limitation below. |
| 13 | Remote Desktop / remote-access tools, recording | **NOT TESTED** | — |

One sample was discarded: one Electron thumbnail (after streaming) had its
control area covered for a moment (1.5% magenta). GDI and the live stream at the
same moment passed.

## Remote-participant check (for you to run)

Use the synthetic phrase **LIVECHECK 7731** typed into the copilot's question
box. Use no real notes or job data. Join from a second device, or a second
browser profile as a guest, so you see exactly what the remote participant
sees. For each app (Teams desktop, Meet in Chrome or Edge, Zoom once
installed), record the app version and the result on the receiving screen:
**visible**, **gone** (background shows through), **black** or **frozen**.

1. Privacy OFF, share the **entire screen**. The receiver should see the phrase.
2. Turn privacy ON while sharing. Wait 2 seconds and type a new phrase. Record
   what the receiver sees.
3. Stop sharing. With privacy still ON, share the entire screen again. Record.
4. Share a **single other window** (for example a slide deck) and move the
   copilot over it. Record.
5. Try to share the **copilot window itself**, once with privacy ON before
   starting and once turning it ON mid-share. Expect black, or a frozen old
   frame (case 4c).
6. Turn privacy OFF and confirm the copilot is visible again in entire-screen
   sharing.
7. If you record a test call (with consent), check the recording separately.

Send me the results and I'll mark each row PASS or FAIL.

## macOS (ScreenCaptureKit)

On macOS, Electron's content protection sets `NSWindowSharingNone`. Electron's
documentation warns that apps capturing with **ScreenCaptureKit** (current
Zoom, Teams, Chrome and the macOS screenshot tools) can still capture the
window. "Native protection enabled" on a Mac therefore says nothing reliable
about what others see. Treat it as unprotected until a receiver-side test on
the exact macOS and meeting-app versions shows otherwise.

## Verdict

**Works on this PC (Windows 11 26H2, local capture):**
- The toggle sets and clears the real Windows exclusion flag, and the preference
  is applied before the window shows after a restart.
- In every entire-screen method tested (GDI, Electron/Chromium 152, Chrome 157,
  Edge 157), the copilot is left out of the capture, whether the share started
  before or after privacy was turned on.
- Compact view, opacity, shortcuts, hide/minimize and a streamed answer don't
  break it.

**Does not work:**
- If someone is already sharing the **copilot window itself** and privacy is
  turned on mid-share, the last frame stays visible (frozen) until the share is
  restarted.
- Turning privacy off mid-share keeps that window share black until it is
  restarted.

**Still needs testing:**
- What a second participant actually receives in Zoom, Teams and Meet.
- Recordings, transcription with real audio, macOS, and remote-desktop tools.

None of this means the window is invisible in general. It only describes the
capture methods listed above, and it says nothing about proctoring or
monitoring software, external cameras or hardware capture.
