@echo off
setlocal enabledelayedexpansion
set "BRIDGE=http://127.0.0.1:8788"
set "SETTINGS=%~dp0claude-settings.json"

where claude >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] claude not found. Install with:
  echo   npm install -g @anthropic-ai/claude-code
  echo.
  pause
  exit /b 1
)

node -e "require('http').get('http://127.0.0.1:8788/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))" >nul 2>nul
if errorlevel 1 (
  echo [bridge] not running, starting it in background...
  start "OpenCodeBridge" /min "%~dp0start.bat"
  for /l %%i in (1,1,20) do (
    timeout /t 1 /nobreak >nul 2>nul
    node -e "require('http').get('http://127.0.0.1:8788/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))" >nul 2>nul
    if !errorlevel!==0 goto bridge_ready
  )
  echo [bridge] failed to start. Please run start.bat manually.
  pause
  exit /b 1
)

:bridge_ready
echo ============================================================
echo  Claude Code via OpenCode free models
echo  Bridge  : %BRIDGE%
echo  Workdir : %CD%
echo ============================================================
echo.

claude --settings "%SETTINGS%" %*
