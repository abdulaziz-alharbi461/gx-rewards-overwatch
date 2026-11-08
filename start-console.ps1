# Runs a command in its own visible console window on the SECOND monitor,
# without ever taking the focus away from whatever the user is doing.
#
# Why this exists:
#   The scheduled tasks used to launch a console on the primary screen and it
#   popped over games. Windows 11 routes new consoles through Windows Terminal,
#   which ignores the position given at creation time and activates itself.
#   So we create the console HIDDEN, find its window, move it to the second
#   monitor and only then show it with SW_SHOWNOACTIVATE. Result: the window
#   appears bottom-right of the second screen and the game keeps the focus.
#
# On a single-monitor PC the console stays minimised (never shown).
#
# Examples:
#   .\start-console.ps1 -Script .\run-daily.cmd -Title "GX Rewards"
#   .\start-console.ps1 -Command "ping -n 30 127.0.0.1" -Title "test" -NoWait
#
# Output: JSON { ok, pid, window, class, rect, minimized, exitCode }

param(
  [string]$Command = '',
  [string]$Script = '',
  [string]$Title = 'Automation',
  [string]$WorkDir = '',
  [int]$WidthPercent = 45,
  [int]$HeightPercent = 55,
  [switch]$NoWait
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class GxConsole2 {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);

    public static List<string> Windows() {
        var list = new List<string>();
        EnumWindows((h, l) => {
            var t = new StringBuilder(512); GetWindowText(h, t, 512);
            var c = new StringBuilder(256); GetClassName(h, c, 256);
            uint pid; GetWindowThreadProcessId(h, out pid);
            RECT r; GetWindowRect(h, out r);
            list.Add(h.ToInt64() + "|" + pid + "|" + c.ToString() + "|" + t.ToString() + "|" +
                (IsWindowVisible(h) ? "vis" : "hid") + "|" + (IsIconic(h) ? "min" : "norm") + "|" +
                r.Left + "," + r.Top + "," + (r.Right - r.Left) + "x" + (r.Bottom - r.Top));
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

try { [void][GxConsole2]::SetProcessDPIAware() } catch {}

$CREATE_NEW_CONSOLE   = 0x00000010
$STARTF_USESHOWWINDOW = 0x00000001
$SW_HIDE              = 0
$SW_SHOWNOACTIVATE    = 4
$SW_SHOWMINNOACTIVE   = 7
$SWP_NOZORDER         = 0x0004
$SWP_NOACTIVATE       = 0x0010
$SWP_SHOWWINDOW       = 0x0040

# ---- command line ---------------------------------------------------------
if (-not $Command -and -not $Script) { throw 'either -Command or -Script is required' }
if ($Command -and $Script) { throw 'use -Command or -Script, not both' }

$comspec = if ($env:ComSpec) { $env:ComSpec } else { "$env:SystemRoot\System32\cmd.exe" }
$cmdLine = if ($Script) {
  # "call" keeps cmd from mangling paths that contain spaces / non-ASCII chars.
  '"' + $comspec + '" /d /c call "' + $Script + '"'
} else {
  '"' + $comspec + '" /c "' + $Command + '"'
}
$wd = if ($WorkDir) { $WorkDir } else { (Get-Location).Path }

# ---- target rectangle -----------------------------------------------------
$second = [System.Windows.Forms.Screen]::AllScreens |
  Where-Object { -not $_.Primary } | Select-Object -First 1

$rect = $null
if ($second) {
  $a = $second.WorkingArea
  $w = [int]($a.Width * $WidthPercent / 100)
  $h = [int]($a.Height * $HeightPercent / 100)
  if ($w -lt 640) { $w = [Math]::Min(640, $a.Width) }
  if ($h -lt 400) { $h = [Math]::Min(400, $a.Height) }
  # bottom-right corner: leaves the upper-left free for the automation windows
  $rect = @{
    left   = $a.X + $a.Width - $w
    top    = $a.Y + $a.Height - $h
    width  = $w
    height = $h
  }
}

# ---- create the console hidden (so it can never flash on the wrong screen) --
$before = @{}
[GxConsole2]::Windows() | ForEach-Object { $before[$_.Split('|')[0]] = $true }
$fgBefore = [GxConsole2]::GetForegroundWindow()

$si = New-Object GxConsole2+STARTUPINFO
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
$si.lpTitle = $Title
$si.wShowWindow = $SW_HIDE
$si.dwFlags = $STARTF_USESHOWWINDOW

$pi = New-Object GxConsole2+PROCESS_INFORMATION
$ok = [GxConsole2]::CreateProcess($comspec, $cmdLine, [IntPtr]::Zero, [IntPtr]::Zero,
  $false, $CREATE_NEW_CONSOLE, [IntPtr]::Zero, $wd, [ref]$si, [ref]$pi)

if (-not $ok) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  [pscustomobject]@{ ok = $false; error = "CreateProcess failed ($err)"; cmd = $cmdLine } |
    ConvertTo-Json -Compress
  exit 1
}
[void][GxConsole2]::CloseHandle($pi.hThread)

# ---- find the fresh console window and move it ----------------------------
# The window belongs to the cmd process itself (conhost is only the host), but
# fall back to "any new ConsoleWindowClass window" in case that changes.
$win = $null
for ($i = 0; $i -lt 50; $i++) {
  Start-Sleep -Milliseconds 120
  $all = [GxConsole2]::Windows()
  $win = $all |
    Where-Object { $_ -like "*|$($pi.dwProcessId)|ConsoleWindowClass|*" } |
    Select-Object -First 1
  if (-not $win) {
    # fallback: the console window may be owned by conhost instead of the
    # process itself, so match any *new* console window carrying our title.
    $win = $all |
      Where-Object {
        -not $before.ContainsKey($_.Split('|')[0]) -and
        $_ -like '*|ConsoleWindowClass|*' -and
        $_.Split('|')[3] -eq $Title
      } | Select-Object -First 1
  }
  if (-not $win) {
    $win = $all |
      Where-Object { -not $before.ContainsKey($_.Split('|')[0]) -and $_ -like '*|ConsoleWindowClass|*' } |
      Select-Object -First 1
  }
  if ($win) { break }
}

$hwnd = if ($win) { [IntPtr][int64]$win.Split('|')[0] } else { [IntPtr]::Zero }
$cls = if ($win) { $win.Split('|')[2] } else { '' }

if ($hwnd -ne [IntPtr]::Zero -and $rect) {
  [void][GxConsole2]::SetWindowPos($hwnd, [IntPtr]::Zero,
    $rect.left, $rect.top, $rect.width, $rect.height,
    ($SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_SHOWWINDOW))
  [void][GxConsole2]::ShowWindow($hwnd, $SW_SHOWNOACTIVATE)
  Start-Sleep -Milliseconds 250
  # Creating/showing a console may still bounce the foreground; put it back.
  $fgNow = [GxConsole2]::GetForegroundWindow()
  if ($fgBefore -ne [IntPtr]::Zero -and $fgNow -ne $fgBefore) {
    [void][GxConsole2]::SetForegroundWindow($fgBefore)
  }
} elseif ($hwnd -ne [IntPtr]::Zero) {
  # single monitor: leave it minimised, never shown
  [void][GxConsole2]::ShowWindow($hwnd, $SW_SHOWMINNOACTIVE)
}

# ---- wait for the command, so the task stays "running" --------------------
$exitCode = $null
if (-not $NoWait) {
  [void][GxConsole2]::WaitForSingleObject($pi.hProcess, [uint32]::MaxValue)
  $code = [uint32]0
  if ([GxConsole2]::GetExitCodeProcess($pi.hProcess, [ref]$code)) { $exitCode = $code }
}

[pscustomobject]@{
  ok        = $true
  pid       = $pi.dwProcessId
  window    = if ($hwnd -ne [IntPtr]::Zero) { $hwnd.ToInt64() } else { $null }
  class     = $cls
  rect      = $rect
  minimized = (-not $rect)
  exitCode  = $exitCode
} | ConvertTo-Json -Depth 4 -Compress

[void][GxConsole2]::CloseHandle($pi.hProcess)
exit $(if ($exitCode -ne $null -and $exitCode -ne 0) { 1 } else { 0 })
