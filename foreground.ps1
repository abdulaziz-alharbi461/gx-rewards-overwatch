# Reports which process owns the focused window.
# Used so cleanup never closes an app the user is actively using right now.
# Output: JSON { process: "opera" } or { process: null }

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class GxForeground {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@

$name = $null
try {
  $h = [GxForeground]::GetForegroundWindow()
  $owner = 0
  [void][GxForeground]::GetWindowThreadProcessId($h, [ref]$owner)
  $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
  if ($p) { $name = $p.ProcessName }
} catch {}

@{ process = $name } | ConvertTo-Json -Compress
