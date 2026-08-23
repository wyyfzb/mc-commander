@echo off
chcp 65001 >nul
title MC_Commander Server

echo ========================================
echo   MC_Commander - Minecraft 服务器管理面板
echo ========================================
echo.

:: 检测 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js！
    echo 请先安装 Node.js 22+: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: 检测 .env
if not exist .env (
    echo [提示] 未找到 .env 配置文件，正在从模板创建...
    copy .env.example .env >nul
    echo.
    echo [重要] 请编辑 .env 文件，设置 API_KEY 后再启动！
    echo.
    pause
    exit /b 1
)

:: 检测 node_modules
if not exist node_modules (
    echo [提示] 正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败！
        pause
        exit /b 1
    )
    echo.
)

echo [启动] 正在启动服务端...
echo.
node index.js
pause
