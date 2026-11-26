@echo off
setlocal
set "PLAYWRIGHT_CHANNEL=chrome"
"%~dp0..\.venv\Scripts\python.exe" "%~dp0..\tests\check_delivery.py"
exit /b %ERRORLEVEL%
