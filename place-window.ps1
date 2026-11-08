# Moves the top-level Chromium windows of a process to an exact rectangle,
# without activating them (so a running game keeps the focus).
#
# Chromium's --window-position is unreliable when --restore-last-session is used,
# so the automation places its windows with the Win32 API instead.
#
# Output: JSON { ok, count, windows: [ { hwnd, title, visible, minimized,
#                                         maximized, left, top, width, height } ] }

param(
  [string]$ProcessName = '',
  [int[]]$ProcessId = @(),
  [int]$Left = 0,
  [int]$Top = 0,
  [int]$Width = 0,
  [int]$Height = 0,
  [int]$WaitSeconds = 20,
  [int]$Cascade = 0,
  [switch]$Minimize
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class GxWin {
    public delegate bool EnumProc(IntPtr h, IntPtr l);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct WINDOWPLACEMENT {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
    [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT p);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@

# physical pixels, so the coordinates from displays.ps1 always match
try { [void][GxWin]::SetProcessDPIAware() } catch {}

$SW_SHOWNORMAL    = 1
$SW_SHOWMINIMIZED = 2
$SWP_NOZORDER     = 0x0004
$SWP_NOACTIVATE   = 0x0010
$SWP_NOSENDCHANGING = 0x0400

function Get-ProcessWindows {
  param([string]$Name, [int[]]$Ids)

  $pids = @{}
  if ($Ids.Count -gt 0) {
    foreach ($id in $Ids) { $pids[[uint32]$id] = $true }
  } elseif ($Name) {
    Get-Process -Name $Name -ErrorAction SilentlyContinue |
      ForEach-Object { $pids[[uint32]$_.Id] = $true }
  }
  if ($pids.Count -eq 0) { return @() }

  $found = New-Object System.Collections.ArrayList
  $cb = [GxWin+EnumProc] {
    param($h, $l)

    $procId = 0
    [void][GxWin]::GetWindowThreadProcessId($h, [ref]$procId)
    if (-not $pids.ContainsKey([uint32]$procId)) { return $true }

    $cls = New-Object System.Text.StringBuilder 256
    [void][GxWin]::GetClassName($h, $cls, 256)
    if ($cls.ToString() -notlike 'Chrome_WidgetWin*') { return $true }

    $r = New-Object GxWin+RECT
    [void][GxWin]::GetWindowRect($h, [ref]$r)
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    $isMin = [GxWin]::IsIconic($h)
    if ($w -le 0 -or $hh -le 0) { return $true }
    # skip Chromium helper windows (tooltips/menus are ~160x28); a minimised
    # window reports that same tiny rect, so it has to be exempt
    if (-not $isMin -and ($w -lt 200 -or $hh -lt 150)) { return $true }

    $title = New-Object System.Text.StringBuilder 512
    [void][GxWin]::GetWindowText($h, $title, 512)

    [void]$found.Add([pscustomobject]@{
      Handle    = $h
      Title     = $title.ToString()
      Visible   = [GxWin]::IsWindowVisible($h)
      Minimized = $isMin
      Maximized = [GxWin]::IsZoomed($h)
      Left      = $r.Left
      Top       = $r.Top
      Width     = $w
      Height    = $hh
    })
    return $true
  }
  [void][GxWin]::EnumWindows($cb, [IntPtr]::Zero)

  # biggest first, so a small popup never becomes the "main" window
  return @($found | Sort-Object { $_.Width * $_.Height } -Descending)
}

# ---- wait for the app to show a real window -------------------------------
$deadline = (Get-Date).AddSeconds([Math]::Max(0, $WaitSeconds))
$wins = @()
do {
  $wins = Get-ProcessWindows -Name $ProcessName -Ids $ProcessId
  if (@($wins | Where-Object { $_.Visible }).Count -gt 0) { break }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 700
} while ($true)

$targets = @($wins | Where-Object { $_.Visible })
# real browser windows always have a title; this skips Chromium's invisible
# helper/owner windows that would otherwise pop up as empty rectangles
$titled = @($targets | Where-Object { $_.Title })
if ($titled.Count -gt 0) { $targets = $titled }
# a tray-only app has no visible window yet: pre-place its biggest hidden one,
# so it opens on the right screen later
if ($targets.Count -eq 0) { $targets = @($wins | Select-Object -First 1) }

if ($targets.Count -eq 0) {
  [pscustomobject]@{ ok = $false; reason = 'no-window'; proc = $ProcessName } | ConvertTo-Json -Compress
  exit 0
}

# ---- place them -----------------------------------------------------------
$placed = New-Object System.Collections.ArrayList
$i = 0
foreach ($w in $targets) {
  $l = $Left + ($i * $Cascade)
  $t = $Top + ($i * $Cascade)
  $cw = if ($Width -gt 0) { $Width - ($i * $Cascade) } else { $w.Width }
  $ch = if ($Height -gt 0) { $Height - ($i * $Cascade) } else { $w.Height }
  if ($cw -lt 480) { $cw = 480 }
  if ($ch -lt 360) { $ch = 360 }

  $wp = New-Object GxWin+WINDOWPLACEMENT
  $wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)
  $got = [GxWin]::GetWindowPlacement($w.Handle, [ref]$wp)

  if ($got) {
    $wp.rcNormalPosition.Left = $l
    $wp.rcNormalPosition.Top = $t
    $wp.rcNormalPosition.Right = $l + $cw
    $wp.rcNormalPosition.Bottom = $t + $ch
    # SetWindowPlacement is the only call here that can activate a window, so
    # only use it when the show state really has to change (hidden windows and
    # minimised ones). An already visible/normal window is moved with
    # SetWindowPos below, which never touches the focus.
    $needsState = (-not $w.Visible) -or $w.Minimized -or $Minimize
    if ($needsState) {
      # 0 = keep hidden; SW_SHOWMINIMIZED keeps the restore rectangle correct
      $wp.showCmd = if (-not $w.Visible) { 0 } else { $SW_SHOWMINIMIZED }
      [void][GxWin]::SetWindowPlacement($w.Handle, [ref]$wp)
    }
  }

  # belt and braces for windows that ignore the placement call
  $flags = $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_NOSENDCHANGING
  [void][GxWin]::SetWindowPos($w.Handle, [IntPtr]::Zero, $l, $t, $cw, $ch, $flags)

  # Chromium sometimes keeps the first window hidden while it initialises;
  # make sure it is really on screen, still without taking the focus.
  # SW_SHOWMINNOACTIVE / SW_SHOWNOACTIVATE exist exactly for this.
  if ($Minimize) {
    if ($w.Visible) { [void][GxWin]::ShowWindow($w.Handle, $SW_SHOWMINNOACTIVE) }
  } elseif (-not $w.Visible -or $w.Minimized -or $w.Maximized) {
    [void][GxWin]::ShowWindow($w.Handle, 4)  # SW_SHOWNOACTIVATE
  }

  $r = New-Object GxWin+RECT
  [void][GxWin]::GetWindowRect($w.Handle, [ref]$r)

  [void]$placed.Add([pscustomobject]@{
    hwnd      = $w.Handle.ToInt64()
    title     = $w.Title
    visible   = [GxWin]::IsWindowVisible($w.Handle)
    minimized = [GxWin]::IsIconic($w.Handle)
    maximized = [GxWin]::IsZoomed($w.Handle)
    left      = $r.Left
    top       = $r.Top
    width     = $r.Right - $r.Left
    height    = $r.Bottom - $r.Top
  })
  $i++
}

[pscustomobject]@{
  ok      = $true
  proc    = $ProcessName
  count   = $placed.Count
  windows = @($placed)
} | ConvertTo-Json -Depth 5
