# Launches the Battle.net app on a private (hidden) Windows desktop.
#
# Why: while the user is playing a game, the app must not appear, must not take
# the focus and must not change the game's foreground state. A hidden desktop
# gives the app a normal, fully working Chromium window that simply lives on a
# desktop nobody ever sees; the automation still drives it over CDP.
#
# The desktop handle must be held until the app is attached to it, otherwise
# Windows destroys the desktop and the app dies with it. So this script stays
# alive until every Battle.net process is gone (or the timeout), and only then
# closes the desktop.
#
# `--disable-gpu` is required: a non-visible desktop has no usable GPU surface
# for CEF and the app fails to start its UI without it.
#
# Started hidden by run-hidden-ps.vbs (wscript), so it is fully detached from
# the run's console - closing that console must not kill the app mid-redeem.
#
# Marker file: .bnet-hidden (created before the launch, removed when done).

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = @(
  'C:\Program Files (x86)\Battle.net\Battle.net.exe',
  'C:\Program Files\Battle.net\Battle.net.exe',
  (Join-Path $env:LOCALAPPDATA 'Battle.net\Battle.net.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { $exe = 'C:\Program Files (x86)\Battle.net\Battle.net.exe' }
$port = 9223
$marker = Join-Path $dir '.bnet-hidden'
$logFile = Join-Path $dir 'logs\bnet-hidden.log'

function Write-Log([string]$message) {
  try {
    $line = '[' + (Get-Date).ToString('o') + '] ' + $message
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
  } catch {}
}

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class GxHiddenDesktop {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwSizeX, dwSizeY, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr devmode, int flags, uint access, IntPtr sa);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool CloseDesktop(IntPtr h);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
      uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static IntPtr handle = IntPtr.Zero;

  public static void Create(string name) {
    handle = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, 0x000F01FF, IntPtr.Zero);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDesktop");
  }

  public static int Launch(string desktop, string exe, string args) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.lpDesktop = desktop;
    PROCESS_INFORMATION pi;
    string cmd = "\"" + exe + "\" " + args;
    if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi))
      throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess");
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return (int)pi.dwProcessId;
  }

  public static void Close() {
    if (handle != IntPtr.Zero) { CloseDesktop(handle); handle = IntPtr.Zero; }
  }
}
"@

$desktop = 'GXBattleNet-' + [guid]::NewGuid().ToString('N').Substring(0, 8)

try {
  [GxHiddenDesktop]::Create($desktop)
  New-Item -ItemType File -Force -Path $marker | Out-Null
  $appPid = [GxHiddenDesktop]::Launch($desktop, $exe, "--remote-debugging-port=$port --disable-gpu")
  Write-Log "launched pid $appPid on hidden desktop $desktop"

  # keep the desktop alive until the app is gone; the app cannot outlive it
  $deadline = (Get-Date).AddMinutes(240)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (-not (Get-Process -Name 'Battle.net' -ErrorAction SilentlyContinue)) { break }
  }
  Write-Log 'Battle.net processes are gone'
} catch {
  Write-Log ('ERROR: ' + $_.Exception.Message)
} finally {
  Remove-Item $marker -Force -ErrorAction SilentlyContinue
  [GxHiddenDesktop]::Close()
  Write-Log 'desktop closed'
}
