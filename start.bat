@echo off
title OpenCode Free Model Bridge
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Please install it from https://nodejs.org
  echo.
  pause
  exit /b 1
)

set "NODE_USE_ENV_PROXY="
if defined HTTPS_PROXY (
  powershell -NoProfile -Command "try{$u=[uri]$env:HTTPS_PROXY;$c=New-Object Net.Sockets.TcpClient;$c.Connect($u.Host,$u.Port);$c.Close();exit 0}catch{exit 1}" >nul 2>nul
  if not errorlevel 1 set "NODE_USE_ENV_PROXY=1"
)

echo ============================================================
echo  OpenCode Free Model Bridge
if defined NODE_USE_ENV_PROXY (
  echo  Proxy   : enabled (%HTTPS_PROXY%)
) else (
  echo  Proxy   : disabled ^(direct connection^)
)
echo  Keep this window open while using other tools.
echo ============================================================
echo.

node bridge.js
pause
