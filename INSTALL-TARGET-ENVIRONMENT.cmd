@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\target-environment.ps1" %*
exit /b %ERRORLEVEL%
