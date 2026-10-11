@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js or add it to PATH.
  pause
  exit /b 1
)

echo Starting cc-switch Token usage dashboard...
echo   page : http://127.0.0.1:8788/
echo   close this window to stop the service
echo.

node serve.mjs --open
pause