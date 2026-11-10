@echo off
title sinning chat - ONLINE
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org then run this again.
  pause
  exit /b
)
if not exist cloudflared.exe (
  echo Downloading Cloudflare Tunnel, one time only...
  curl -L -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
)
if not exist cloudflared.exe (
  echo Could not download cloudflared. Get cloudflared-windows-amd64.exe from
  echo https://github.com/cloudflare/cloudflared/releases and save it in this folder as cloudflared.exe
  pause
  exit /b
)
start "sinning chat server" /min cmd /c "node server.js"
timeout /t 2 >nul
echo.
echo ============================================================
echo  In a few seconds a link ending in .trycloudflare.com
echo  appears below. That link is your site. Send it to friends.
echo  It works on any computer, phone or Wi-Fi.
echo  Keep this window open. Closing it takes the site offline.
echo ============================================================
echo.
cloudflared.exe tunnel --url http://localhost:3000
pause
