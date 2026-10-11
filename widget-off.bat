@echo off
cd /d "%~dp0"
echo off > "%~dp0watchdog.off"
cscript //nologo "%~dp0watchdog-stop.vbs"
node "%~dp0widgetd.mjs" --remove
echo [widget] off  (watchdog stopped; widget-on.bat to resume)