@echo off
setlocal
title ODE-cloud Web UI
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Windows PowerShell was not found.
  echo Run start.ps1 manually with PowerShell.
  echo.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo Server exited with code %CODE%.
  echo Try: start.bat --port 8790
  echo.
  pause
)

endlocal
exit /b %CODE%