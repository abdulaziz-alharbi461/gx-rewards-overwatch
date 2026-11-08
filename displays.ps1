# Lists the connected monitors as JSON (bounds + work area, in physical pixels).
# Used so the automation can put its windows on the second screen instead of
# interrupting whatever is on the primary one.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  [pscustomobject]@{
    device  = $_.DeviceName
    primary = [bool]$_.Primary
    left    = $_.Bounds.X
    top     = $_.Bounds.Y
    width   = $_.Bounds.Width
    height  = $_.Bounds.Height
    workLeft   = $_.WorkingArea.X
    workTop    = $_.WorkingArea.Y
    workWidth  = $_.WorkingArea.Width
    workHeight = $_.WorkingArea.Height
  }
})

[pscustomobject]@{ screens = $screens } | ConvertTo-Json -Depth 4
