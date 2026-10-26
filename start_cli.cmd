@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Please follow WEB_GUIDE.md to create the Python environment first.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" main.py
pause
