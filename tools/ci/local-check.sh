#!/usr/bin/env bash
# 本地 CI：统一执行代码格式 / 契约包 / 后端 / 前端的检查与测试 + 设计 token 守门。
# 覆盖范围与 .github/workflows/ci.yml 对齐（覆盖率与体积门禁仍只在 CI 跑）。
# 用法：bash tools/ci/local-check.sh [--skip-frontend] [--skip-schemas]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 仓库根按 .git 向上发现：脚本换目录、包层数变化都不必改这里
find_repo_root() {
  local d="$1"
  while [ "$d" != "/" ]; do
    [ -e "$d/.git" ] && { printf '%s' "$d"; return 0; }
    d="$(dirname "$d")"
  done
  printf '%s' "$1"
}
PROJECT_DIR="$(find_repo_root "$SCRIPT_DIR")"
SCHEMAS_DIR="$PROJECT_DIR/apps/schemas"
SERVER_DIR="$PROJECT_DIR/apps/server"
WEB_DIR="$PROJECT_DIR/apps/web"

SKIP_FRONTEND=0
SKIP_SCHEMAS=0
for arg in "$@"; do
  case "$arg" in
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --skip-schemas) SKIP_SCHEMAS=1 ;;
    *) echo "未知参数: $arg"; exit 2 ;;
  esac
done

# 依赖：workspace 根一次装齐（根 lock 是唯一事实源）
ensure_deps() {
  [ -d "$PROJECT_DIR/node_modules" ] && return 0
  echo "node_modules 不存在，执行 npm ci --no-audit --no-fund"
  (cd "$PROJECT_DIR" && npm ci --no-audit --no-fund)
}

echo "=== [1/6] 目录结构门禁（顶层白名单 + 源码面无测试 + 无运行期产物入库）==="
node "$PROJECT_DIR/tools/check-layout.mjs"

echo "=== [2/6] 代码格式检查（Biome formatter；范围与排除项见 biome.jsonc）==="
# 根 = workspace 根（Biome 与三包依赖同在根一次安装）
ensure_deps
(cd "$PROJECT_DIR" && npm run format:check)

# 生产依赖漏洞门禁（与 ci.yml 的 dependency-audit job 同口径）：只判生产依赖
# （--omit=dev，devDependencies 不进产物），阈值 high。workspace 下根 lock 覆盖三包，
# 一次判定即可；npm audit 仅凭 lock 即可判定、不需要 node_modules，故不等 ensure_deps。
echo "=== [3/6] 生产依赖漏洞门禁（npm audit --omit=dev --audit-level=high）==="
if ! (cd "$PROJECT_DIR" && npm audit --omit=dev --audit-level=high); then
  echo "错误：存在 high 及以上生产依赖漏洞"
  echo "      本地执行 npm audit fix 处置后再提交（改完重建 lock 一律带 --registry=https://registry.npmjs.org）"
  exit 1
fi

echo "=== [4/6] 共享契约包 apps/schemas（lint + 测试 + 构建产物）==="
if [ ! -d "$SCHEMAS_DIR" ]; then
  echo "错误：未找到 apps/schemas 目录"
  exit 1
fi
ensure_deps
cd "$SCHEMAS_DIR"
npm run lint
npm test
# 契约包产物是消费前置：服务端经 workspace 链接解析到 dist/index.js。dist 不入库，
# 故这里构建并断言产物存在——取代原先「与提交版逐字节比对」：不再有可漂移的提交产物，
# 服务端也不可能吃到陈旧契约。
npm run build >/dev/null
if [ ! -f dist/index.js ]; then
  echo "错误：apps/schemas 构建未产出 dist/index.js"
  exit 1
fi

echo "=== [5/6] 后端 Lint + 单元测试（消费契约包构建产物）==="
if [ ! -d "$SERVER_DIR" ]; then
  echo "错误：未找到 apps/server 目录"
  exit 1
fi
ensure_deps
  # 服务端消费契约包产物：node 解析经 workspace 链接落到 apps/schemas 的 main=dist/index.js，
  # 故先建 dist。这一步取代了原先「提交版 dist 逐字节比对」——不再存在可漂移的提交产物
  (cd "$PROJECT_DIR" && npm run build -w apps/schemas)
  (cd "$PROJECT_DIR" && npm run lint -w apps/server && npm test -w apps/server)

if [ "$SKIP_FRONTEND" -eq 1 ]; then
  echo "已跳过前端检查（--skip-frontend）"
  exit 0
fi

echo "=== [6/6] 前端 Lint + 类型检查 + 设计 token 守门 + 单元测试 ==="
if [ ! -d "$WEB_DIR" ]; then
  echo "错误：未找到 apps/web 目录"
  exit 1
fi
ensure_deps
cd "$WEB_DIR"
npm run lint
# 必须带 -b：根 tsconfig 是 files:[] + references 的 solution 配置，
# 裸 `tsc --noEmit` 不展开 references，实际检查 0 个文件（空转）。
npx tsc -b --noEmit
# 设计 token 守门（与 ci.yml web-check 对齐：design-tokens + contrast；前置快检秒级失败，不等全量）
npx vitest run tests/unit/token-integrity.test.ts
npm run check:design-tokens
npm run check:contrast
npm test

echo "=== 本地检查通过 ==="
