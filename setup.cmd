@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 or newer from https://nodejs.org/
  pause
  exit /b 1
)
echo Open http://127.0.0.1:8788 in your browser.
call npm run setup
pause
