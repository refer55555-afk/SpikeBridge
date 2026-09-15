@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if /I "%~1"=="setup" goto SETUP
if /I "%~1"=="panel" goto PANEL
if /I "%~1"=="status" goto STATUS
if /I "%~1"=="restart" goto RESTART
if /I "%~1"=="cutover" goto CUTOVER
node "%CD%\runtime\safe-boot\spike-home-production.g3.mjs" ensure
exit /b %ERRORLEVEL%
:SETUP
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\bootstrap\setup.ps1"
exit /b %ERRORLEVEL%
:PANEL
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\operator\scripts\Start-Panel.ps1"
exit /b %ERRORLEVEL%
:STATUS
node "%CD%\runtime\safe-boot\spike-home-production.g3.mjs" status
exit /b %ERRORLEVEL%
:RESTART
node "%CD%\runtime\safe-boot\spike-home-production.g3.mjs" restart
exit /b %ERRORLEVEL%
:CUTOVER
node "%CD%\runtime\safe-boot\spike-home-production.g3.mjs" verify
if errorlevel 1 exit /b %ERRORLEVEL%
node "%CD%\runtime\safe-boot\spike-home-production.g3.mjs" promote
exit /b %ERRORLEVEL%