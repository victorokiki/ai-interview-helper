# Lists the processes that have an active microphone (capture) stream right
# now, using the Windows audio session API (WASAPI). Used by src/meeting.js on
# Windows builds where the privacy consent store no longer records live use.
# Prints one line per process: <pid>`t<exe name>. Stays running and answers
# every line read from stdin (so the C# is compiled once), or runs once with -Once.
param([switch]$Once)
$ErrorActionPreference = 'Stop'
Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class MicSessions {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }
  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { int GetCount(out int count); int Item(int index, out IMMDevice device); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { int GetCount(out int n); int GetSession(int i, out IAudioSessionControl2 s); }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName(out IntPtr s); int SetDisplayName(IntPtr a, IntPtr b);
    int GetIconPath(out IntPtr s); int SetIconPath(IntPtr a, IntPtr b);
    int GetGroupingParam(out Guid g); int SetGroupingParam(IntPtr a, IntPtr b);
    int RegisterAudioSessionNotification(IntPtr a); int UnregisterAudioSessionNotification(IntPtr a);
    int GetSessionIdentifier(out IntPtr s); int GetSessionInstanceIdentifier(out IntPtr s);
    int GetProcessId(out uint pid);
  }

  // PIDs with an active session on any active capture endpoint.
  public static List<uint> ActiveCapturePids() {
    var pids = new List<uint>();
    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDeviceCollection devices;
    en.EnumAudioEndpoints(1 /* eCapture */, 1 /* ACTIVE */, out devices);
    int count; devices.GetCount(out count);
    var iid = typeof(IAudioSessionManager2).GUID;
    for (int i = 0; i < count; i++) {
      IMMDevice dev; devices.Item(i, out dev);
      object o; if (dev.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o) != 0) continue;
      var mgr = (IAudioSessionManager2)o;
      IAudioSessionEnumerator sessions; if (mgr.GetSessionEnumerator(out sessions) != 0) continue;
      int n; sessions.GetCount(out n);
      for (int k = 0; k < n; k++) {
        IAudioSessionControl2 s; sessions.GetSession(k, out s);
        int state; s.GetState(out state);
        uint pid; s.GetProcessId(out pid);
        if (state == 1 /* AudioSessionStateActive */ && pid != 0 && !pids.Contains(pid)) pids.Add(pid);
      }
    }
    return pids;
  }
}
"@

function Report {
  foreach ($procId in [MicSessions]::ActiveCapturePids()) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p) { "{0}`t{1}" -f $procId, $p.ProcessName }
  }
  'END'
}

if ($Once) { Report; exit }
while ($null -ne ($line = [Console]::In.ReadLine())) { Report }
