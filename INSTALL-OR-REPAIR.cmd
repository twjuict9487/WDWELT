@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install\bootstrap.ps1" -ExistingAccounts %*
exit /b %ERRORLEVEL%
