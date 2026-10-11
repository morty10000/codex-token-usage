@echo off
cd /d "%~dp0"
if exist "%~dp0watchdog.off" del "%~dp0watchdog.off"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0widget-boot.ps1"
start "" wscript.exe "%~dp0watchdog-boot.vbs"
echo [widget] on  (serve:8788 + widgetd + watchdog)