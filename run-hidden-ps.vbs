' Runs a PowerShell script hidden, fully detached from the caller.
'
' Usage:
'   wscript.exe //nologo run-hidden-ps.vbs "<script.ps1>"
'
' WScript.Shell.Run with window style 0 gives the child its own hidden console,
' so it keeps running after the calling console/window is gone. This is how the
' hidden-desktop Battle.net launcher survives the run that started it.
Option Explicit

Dim args, cmd, sh
Set args = WScript.Arguments
If args.Count < 1 Then WScript.Quit 2

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & args(0) & """"

Set sh = CreateObject("WScript.Shell")
sh.Run cmd, 0, False
