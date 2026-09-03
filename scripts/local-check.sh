#!/usr/bin/env bash
# 本地 CI：统一执行后端 lint/test 与前端 lint/typecheck/test + 设计 token 守门
# 用法：bash scripts/local-check.sh [--skip-frontend]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$PROJECT_DIR/mc_commander_server"
WEB_DIR="$PROJECT_DIR/mc_manager_web"

SKIP_FRONTEND=0
for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

echo "=== [1/2] 后端 Lint + 单元测试 ==="
if [ ! -d "$SERVER_DIR" ]; then
  echo "错误：未找到 mc_commander_server 目录"
  exit 1
fi
cd "$SERVER_DIR"
if [ ! -d node_modules ]; then
  echo "node_modules 不存在，执行 npm ci --no-audit --no-fund"
  npm ci --no-audit --no-fund
fi
npm run lint
npm test

if [ "$SKIP_FRONTEND" -eq 1 ]; then
  echo "已跳过前端检查（--skip-frontend）"
  exit 0
fi

echo "=== [2/2] 前端 Lint + 类型检查 + 设计 token 守门 + 单元测试 ==="
if [ ! -d "$WEB_DIR" ]; then
  echo "错误：未找到 mc_manager_web 目录"
  exit 1
fi
cd "$WEB_DIR"
if [ ! -d node_modules ]; then
  echo "node_modules 不存在，执行 npm ci --no-audit --no-fund"
  npm ci --no-audit --no-fund
fi
npm run lint
npx tsc --noEmit
# 设计 token 守门（与 ci.yml web-check 对齐：design-tokens + contrast；前置快检秒级失败，不等全量）
npx vitest run src/__tests__/token-integrity.test.ts
npm run check:design-tokens
npm run check:contrast
npm test

echo "=== 本地检查通过 ==="
