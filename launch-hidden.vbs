' Starts an automation run with NO console flash on the primary screen.
'
' Usage (from a scheduled task):
'   wscript.exe //nologo launch-hidden.vbs "<start-console.ps1>" "<run-*.cmd>" "<window title>"
'
' Why a VBS: wscript.exe is a GUI-subsystem program, so the task itself never
' creates a console. It launches PowerShell hidden, and start-console.ps1 then
' creates the real console already on the second monitor without taking focus.
'
' The runner waits (True) so the scheduled task keeps showing "Running" for the
' whole run and its execution-time limit still applies.
Option Explicit

Dim args, cmd, sh
Set args = WScript.Arguments
If args.Count < 3 Then WScript.Quit 2

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden" & _
      " -File """ & args(0) & """" & _
      " -Script """ & args(1) & """" & _
      " -Title """ & args(2) & """"

Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run(cmd, 0, True)
