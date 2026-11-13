@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Please create the Python environment first, see WEB_GUIDE.md.
    pause
    exit /b 1
)

rem 本地联调小程序：允许 dev:xxx 假登录，方便还没拿到 AppID 时先跑通链路。
rem 上线前必须删掉这一行，生产环境绝不要开。
set WX_DEV_LOGIN=1

".venv\Scripts\python.exe" wx_api.py --host 0.0.0.0 --port 8766
pause
