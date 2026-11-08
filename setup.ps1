# One-time setup for the GX Rewards -> Overwatch automation.
#
# Usage (right-click "Run with PowerShell" also works):
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1 -RunNow
#
# What it does:
#   1. checks Node.js
#   2. checks Opera GX / Battle.net (warnings only)
#   3. installs the Node dependency (playwright-core)
#   4. creates config.json with a PRIVATE ntfy topic for this PC
#   5. registers the scheduled task (wake the PC, run at reward time)
#
# It never touches any account; sign-in stays inside Opera GX / Battle.net.

param([switch]$RunNow)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

Write-Host ''
Write-Host '=== GX Rewards - Overwatch: setup ===' -ForegroundColor Cyan

# 1) Node.js ---------------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) {
  throw 'Node.js is not installed. Install the LTS version from https://nodejs.org , then run this file again.'
}
Write-Host "Node.js     : $node  ($(& node -v))"

# 2) Apps (warnings only) --------------------------------------------------
$operaCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Opera GX\opera.exe'),
  (Join-Path $env:ProgramFiles 'Opera GX\opera.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Opera GX\opera.exe')
)
$opera = $operaCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($opera) { Write-Host "Opera GX    : $opera" }
else { Write-Warning 'Opera GX was not found in the usual folders. Install it, or edit CFG.opera in daily.js.' }

$bnetCandidates = @(
  'C:\Program Files (x86)\Battle.net\Battle.net.exe',
  'C:\Program Files\Battle.net\Battle.net.exe',
  (Join-Path $env:LOCALAPPDATA 'Battle.net\Battle.net.exe')
)
$bnet = $bnetCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($bnet) { Write-Host "Battle.net  : $bnet" }
else { Write-Warning 'Battle.net was not found. Install the desktop app and sign in once.' }

# 3) Node dependency -------------------------------------------------------
if (-not (Test-Path (Join-Path $dir 'node_modules\playwright-core'))) {
  Write-Host 'Installing dependencies (playwright-core)...'
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Check your internet connection and try again.' }
}
Write-Host 'Dependencies: OK'

# 4) Private notification topic -------------------------------------------
$cfgPath = Join-Path $dir 'config.json'
if (-not (Test-Path $cfgPath)) {
  $bytes = New-Object 'System.Byte[]' 10
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $topic = 'gxr-ow-' + (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  $cfg = [ordered]@{
    ntfy     = [ordered]@{ enabled = $true; server = 'https://ntfy.sh'; topic = $topic; token = $null }
    telegram = [ordered]@{ enabled = $false; botToken = ''; chatId = '' }
    discord  = [ordered]@{ enabled = $false; webhookUrl = '' }
  }
  $json = $cfg | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($cfgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Created a new private notification topic."
}
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
Write-Host ''
Write-Host 'Your ntfy topic (subscribe in the ntfy phone app):' -ForegroundColor Yellow
Write-Host "  $($cfg.ntfy.topic)" -ForegroundColor Yellow
Write-Host ''

# 5) Scheduled task --------------------------------------------------------
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'setup-task.ps1')
if ($LASTEXITCODE -ne 0) { throw 'The scheduled task could not be registered.' }

# 6) What to do next -------------------------------------------------------
Write-Host ''
Write-Host '=== Almost done - 3 sign-ins (one time only) ===' -ForegroundColor Cyan
Write-Host '1) Open Opera GX and sign in at  https://gx.me  (the account with Overwatch linked).'
Write-Host '2) Open the Battle.net desktop app and sign in (it stays signed in).'
Write-Host '3) Install the ntfy app on your phone and subscribe to the topic above.'
Write-Host ''
Write-Host 'Test it now with:  node daily.js --force'
Write-Host 'Logs:              .\logs\'
Write-Host ''

if ($RunNow) {
  Write-Host 'Running a first pass now...' -ForegroundColor Cyan
  & node (Join-Path $dir 'daily.js') --force
}
