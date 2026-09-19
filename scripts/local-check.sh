#!/usr/bin/env bash
# 本地 CI：统一执行代码格式 / 契约包 / 后端 / 前端的检查与测试 + 设计 token 守门。
# 覆盖范围与 .github/workflows/ci.yml 对齐（覆盖率与体积门禁仍只在 CI 跑）。
# 用法：bash scripts/local-check.sh [--skip-frontend] [--skip-schemas]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCHEMAS_DIR="$PROJECT_DIR/mc-schemas"
SERVER_DIR="$PROJECT_DIR/mc_commander_server"
WEB_DIR="$PROJECT_DIR/mc_manager_web"

SKIP_FRONTEND=0
SKIP_SCHEMAS=0
for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --skip-schemas) SKIP_SCHEMAS=1 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

# 三个包各自独立安装依赖（无 workspace 根），缺依赖则安装
ensure_deps() {
  [ -d "$1/node_modules" ] && return 0
  echo "node_modules 不存在，执行 npm ci --no-audit --no-fund"
  (cd "$1" && npm ci --no-audit --no-fund)
}

echo "=== [1/4] 代码格式检查（Biome formatter；范围与排除项见 biome.jsonc）==="
# 仓库级工具包（根 package.json 只装 Biome，不是 workspace 根）
ensure_deps "$PROJECT_DIR"
(cd "$PROJECT_DIR" && npm run format:check)

# 契约包最先跑：服务端运行时经 file: link 消费其 dist，前端经 vite alias 直读 src，
# dist 落后于 src 时服务端会静默使用旧契约，故须先确保 dist 与 src 同步。
if [ "$SKIP_SCHEMAS" -eq 0 ]; then
  echo "=== [2/4] 共享契约包 mc-schemas（测试 + dist 同步守卫）==="
  if [ ! -d "$SCHEMAS_DIR" ]; then
    echo "错误：未找到 mc-schemas 目录"
    exit 1
  fi
  ensure_deps "$SCHEMAS_DIR"
  cd "$SCHEMAS_DIR"
  npm test
  # dist 同步守卫（与 ci.yml schemas job 同款）：重建产物与提交版 byte 级比对，
  # 漂移即失败。rolldown 输出确定，同步时本步不会改写工作区。
  DIST_COMMITTED="$(mktemp)"
  if [ ! -f dist/index.js ]; then
    # dist/index.js 是提交物（服务端运行时消费）：缺失时比对无基准，且 fail 在
    # cp 上只会得到 `cp: cannot stat`，读不出「该做什么」（工作区清理误删时会遇到）
    echo "错误：mc-schemas/dist/index.js 不存在，无法做重建比对"
    echo "      该文件是提交物（服务端运行时消费 dist），执行 npm run build 重建即可；"
    echo "      若是误删，也可用 git checkout -- mc-schemas/dist/index.js 还原"
    rm -f "$DIST_COMMITTED"
    exit 1
  fi
  cp dist/index.js "$DIST_COMMITTED"
  npm run build >/dev/null
  if ! cmp -s "$DIST_COMMITTED" dist/index.js; then
    rm -f "$DIST_COMMITTED"
    echo "错误：mc-schemas/dist/index.js 与 src 重建产物不一致"
    echo "      dist 已按 src 重建，请连同 src 改动一并提交（服务端运行时消费 dist）"
    exit 1
  fi
  rm -f "$DIST_COMMITTED"
fi

echo "=== [3/4] 后端 Lint + 单元测试 ==="
if [ ! -d "$SERVER_DIR" ]; then
  echo "错误：未找到 mc_commander_server 目录"
  exit 1
fi
ensure_deps "$SERVER_DIR"
cd "$SERVER_DIR"
npm run lint
npm test

if [ "$SKIP_FRONTEND" -eq 1 ]; then
  echo "已跳过前端检查（--skip-frontend）"
  exit 0
fi

echo "=== [4/4] 前端 Lint + 类型检查 + 设计 token 守门 + 单元测试 ==="
if [ ! -d "$WEB_DIR" ]; then
  echo "错误：未找到 mc_manager_web 目录"
  exit 1
fi
ensure_deps "$WEB_DIR"
cd "$WEB_DIR"
npm run lint
# 必须带 -b：根 tsconfig 是 files:[] + references 的 solution 配置，
# 裸 `tsc --noEmit` 不展开 references，实际检查 0 个文件（空转）。
npx tsc -b --noEmit
# 设计 token 守门（与 ci.yml web-check 对齐：design-tokens + contrast；前置快检秒级失败，不等全量）
npx vitest run src/__tests__/token-integrity.test.ts
npm run check:design-tokens
npm run check:contrast
npm test

echo "=== 本地检查通过 ==="
