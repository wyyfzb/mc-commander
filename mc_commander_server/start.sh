#!/bin/bash

echo "========================================"
echo "  MC_Commander - Minecraft 服务器管理面板"
echo "========================================"
echo ""

# 检测 Node.js
if ! command -v node &> /dev/null; then
    echo "[错误] 未检测到 Node.js！"
    echo "请先安装 Node.js 22+: https://nodejs.org/"
    exit 1
fi

# 检测 .env
if [ ! -f .env ]; then
    echo "[提示] 未找到 .env 配置文件，正在从模板创建..."
    cp .env.example .env
    echo ""
    echo "[重要] 请编辑 .env 文件，设置 API_KEY_HASH（明文 Key 的 SHA-256 摘要）后再启动！"
    echo "  命令: nano .env"
    echo ""
    exit 1
fi

# 检测 node_modules
if [ ! -d node_modules ]; then
    echo "[提示] 正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "[错误] 依赖安装失败！"
        exit 1
    fi
    echo ""
fi

echo "[启动] 正在启动服务端..."
echo ""
node index.js
