@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
chcp 65001 >nul
set "PYTHONUTF8=1"
set "NPM_CONFIG_UNICODE=true"

title QQ Farm Auto - Quick Start

echo.
echo ==========================================
echo   QQ Farm Auto - Quick Start
echo ==========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Please install Node.js 22 or newer.
    echo Download: https://nodejs.org/
    pause
    exit /b 1
)

for /f %%i in ('node -p "process.versions.node.split(\".\")[0]"') do set "NODE_MAJOR=%%i"
if not defined NODE_MAJOR (
    echo [ERROR] Failed to detect Node.js version.
    pause
    exit /b 1
)

if %NODE_MAJOR% LSS 22 (
    echo [ERROR] Node.js 22 or newer is required. Current major version: %NODE_MAJOR%
    pause
    exit /b 1
)

echo [OK] Node.js v%NODE_MAJOR% detected.
echo.
echo Select runtime:
echo   [1] QQ     WebSocket host + QQ bundle
echo   [2] WeChat CDP + auto inject button.js

choice /c 12 /n /m "Choose runtime [1/2]: "
if errorlevel 2 (
    set "RUNTIME_FLAG=--wx"
    set "RUNTIME_NAME=WeChat"
) else (
    set "RUNTIME_FLAG=--qq"
    set "RUNTIME_NAME=QQ"
)

echo.
echo Selected runtime: %RUNTIME_NAME%
echo.

node setup.cjs %RUNTIME_FLAG%
if errorlevel 1 (
    echo.
    echo [ERROR] Startup failed. Please check the log above.
    pause
    exit /b 1
)

endlocal
