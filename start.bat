@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

title 农场自动化 - 一键启动

echo.
echo  ==========================================
echo       农场自动化控制台  一键启动
echo  ==========================================
echo.

:: ── 检测 Node.js ──────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [错误] 未检测到 Node.js，请先安装 Node.js ^>= 18
    echo  下载地址：https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=1 delims=v" %%i in ('node -v') do (
    for /f "tokens=1 delims=." %%j in ("%%i") do set NODE_MAJOR=%%j
)
set NODE_MAJOR=%NODE_MAJOR:v=%
if %NODE_MAJOR% LSS 18 (
    echo  [错误] Node.js 版本过低，需要 ^>= 18
    pause
    exit /b 1
)
echo  [OK] Node.js v%NODE_MAJOR% 已就绪

:: ── 选择运行路线 ───────────────────────────────────────────────
echo.
echo  请选择运行路线：
echo.
echo    [1]  QQ 路线    WebSocket 宿主 + QQ bundle
echo    [2]  微信路线   CDP + 自动注入 button.js
echo.
set /p CHOICE="  输入数字后回车 [1/2]: "

if "%CHOICE%"=="1" (
    set RUNTIME_FLAG=--qq
    set RUNTIME_NAME=QQ
) else if "%CHOICE%"=="2" (
    set RUNTIME_FLAG=--wx
    set RUNTIME_NAME=微信
) else (
    echo  [错误] 无效选项，请输入 1 或 2
    pause
    exit /b 1
)

echo.
echo  已选择：%RUNTIME_NAME% 路线

:: ── 进入脚本目录 ──────────────────────────────────────────────
cd /d "%~dp0"

:: ── 委托 Node 完成后续（安装 + 启动）────────────────────────────
node setup.cjs %RUNTIME_FLAG%
if errorlevel 1 (
    echo.
    echo  [错误] 启动失败，请查看上方日志
    pause
    exit /b 1
)

endlocal
