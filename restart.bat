@echo off
REM ─── easy-wiki 重启脚本 (Windows) ─────────────────────────────
REM 作用：停止占用 82 端口的 node 进程，后台启动新的。
REM 日志：log\server.log

cd /d "%~dp0"

echo ==^> 查找并停止占用端口的 node 进程...
REM 通过 netstat 找占用 82 端口的 PID，然后 kill
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :82 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
    echo     已停止 PID %%a
)
timeout /t 1 /nobreak >nul

REM 启动
if not exist log mkdir log
start /B node server.js > log\server.log 2>&1
timeout /t 1 /nobreak >nul

echo ==^> easy-wiki 已启动
echo     端口: 82
echo     日志: log\server.log
echo     停止: 再次运行 restart.bat 或 taskkill 对应进程
pause
