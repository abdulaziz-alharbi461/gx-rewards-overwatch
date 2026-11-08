# Reports system state used to decide whether to close the browser and go back to sleep.
# Output: JSON { idleSeconds, lastResumeUtc, lastWake }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SysIdle {
    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    public static uint Seconds() {
        LASTINPUTINFO li = new LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(li);
        if (!GetLastInputInfo(ref li)) return 0;
        uint t = (uint)Environment.TickCount;
        return (t >= li.dwTime) ? (t - li.dwTime) / 1000 : 0;
    }
}
"@

$idle = [SysIdle]::Seconds()

$resume = $null
try {
    $e = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; Id=1} -MaxEvents 1 -ErrorAction Stop
    $resume = $e.TimeCreated.ToUniversalTime().ToString('o')
} catch {
    try {
        $e = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; Id=107} -MaxEvents 1 -ErrorAction Stop
        $resume = $e.TimeCreated.ToUniversalTime().ToString('o')
    } catch {}
}

$wake = ''
try { $wake = (powercfg /lastwake 2>$null) -join "`n" } catch {}

@{ idleSeconds = [int]$idle; lastResumeUtc = $resume; lastWake = $wake } | ConvertTo-Json -Compress
