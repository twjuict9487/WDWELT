@echo off
setlocal
title WDWELT One-File Setup
echo Starting WDWELT guided installation...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1" %*
set "WDWELT_EXIT=%ERRORLEVEL%"
echo.
if "%WDWELT_EXIT%"=="0" (
  echo WDWELT setup finished.
) else (
  echo WDWELT setup stopped with exit code %WDWELT_EXIT%.
)
echo.
pause
exit /b %WDWELT_EXIT%
