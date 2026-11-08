@echo off
rem Console wrapper for the GX Rewards automation.
rem Output goes to this window AND to logs\YYYY-MM-DD.log (daily.js writes both).
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
title GX Rewards - Overwatch
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"
"%NODE%" "%~dp0daily.js"
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo [exit %RC%] this window closes in 20 seconds...
  timeout /t 20 /nobreak >nul
)
exit /b %RC%
