@echo off
chcp 65001 >nul
cd /d "%~dp0"
title BookJob Meeting Bot

echo ================================================
echo  BookJob Meeting Bot
echo  Stop: press Ctrl+C or close this window.
echo  Auto-shutdown ~10 min after a meeting ends.
echo ================================================
echo.

if not exist ".venv\Scripts\python.exe" (
  echo [!] .venv not found. Run the one-time setup first: scripts\setup.md
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [!] node_modules not found. Running: npm install
  call npm install
  echo.
)

node index.js

echo.
echo Bot stopped. Press any key to close.
pause >nul
