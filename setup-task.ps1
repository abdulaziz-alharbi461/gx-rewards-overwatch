# Creates/updates the Windows scheduled task that runs the GX Rewards automation.
# Run:  powershell -ExecutionPolicy Bypass -File .\setup-task.ps1
#
# The task itself stays invisible: wscript.exe (no console) -> PowerShell hidden
# -> start-console.ps1, which creates the real CMD window on the SECOND monitor
# without stealing focus. See start-console.ps1 / launch-hidden.vbs.

$ErrorActionPreference = 'Stop'

$taskName = 'GX Rewards - Overwatch Daily'
$dir      = Split-Path -Parent $MyInvocation.MyCommand.Path
$wrapper  = Join-Path $dir 'run-daily.cmd'
$launcher = Join-Path $dir 'start-console.ps1'
$vbs      = Join-Path $dir 'launch-hidden.vbs'
$node     = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$wscript  = Join-Path $env:SystemRoot 'System32\wscript.exe'
$title    = 'GX Rewards - Overwatch'

foreach ($f in @($wrapper, $launcher, $vbs)) {
    if (-not (Test-Path $f)) { throw "missing file: $f" }
}
if (-not (Test-Path $node)) { throw "node not found: $node" }

$argLine = '//nologo "{0}" "{1}" "{2}" "{3}"' -f $vbs, $launcher, $wrapper, $title
$action  = New-ScheduledTaskAction -Execute $wscript -Argument $argLine -WorkingDirectory $dir

# single one-time trigger; daily.js moves it to the exact moment the next reward unlocks
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -WakeToRun

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Task registered: $taskName"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State | Format-Table -AutoSize
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object NextRunTime | Format-List
