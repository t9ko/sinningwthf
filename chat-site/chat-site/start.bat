@echo off
title sinning chat
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org then run this again.
  pause
  exit /b
)
echo Starting the chat. Keep this window open. Close it to stop the site.
start "" http://localhost:3000
node server.js
pause
