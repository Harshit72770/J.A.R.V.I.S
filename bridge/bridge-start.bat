@echo off
title J.A.R.V.I.S Desktop Bridge
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this laptop.
  echo   Install it from https://nodejs.org  ^(LTS version^), then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting J.A.R.V.I.S Desktop Bridge...
echo   Keep this window open. Close it to stop the bridge.
echo.

node "%~dp0server.js"

if errorlevel 1 (
  echo.
  echo   The bridge stopped. Press any key to close.
  pause
)
