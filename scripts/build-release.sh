#!/usr/bin/env bash
# ⚠️ 弃用：勿手动使用。本脚本缺少共享契约包的 staging 路径重写
# （@mc-commander/schemas 依赖 file:../mc-schemas，位于服务端目录外，直接打包
# 产出的 tarball 安装全绿但启动即崩）。完整打包流程以 .github/workflows/release.yml
# 为准（staging 组装 + file:./mc-schemas 重写 + 发布前 sanity check）；本地部署
# 打包走 .ai/tools/deploy/pack-deploy.sh（含同等重写逻辑，不入库）。
#
# 构建后端发布包（tar.gz），用于一键部署
# 用法：bash scripts/build-release.sh
# 环境变量：BUILD_WEB=0 跳过前端构建（默认构建并打入 public/）
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$PROJECT_DIR/mc_commander_server"
WEB_DIR="$PROJECT_DIR/mc_manager_web"
RELEASE_DIR="$PROJECT_DIR/release"
OUTPUT="$RELEASE_DIR/mc-commander-server.tar.gz"
if [ ! -d "$SERVER_DIR" ]; then
  echo "错误：未找到 mc_commander_server 目录"
  exit 1
fi

# M7：打包前构建前端，产物复制进 mc_commander_server/public/（随包发布，
# 部署后由 Express 同源托管；BUILD_WEB=0 跳过）
if [ "${BUILD_WEB:-1}" != "0" ]; then
  if [ ! -d "$WEB_DIR" ]; then
    echo "错误：未找到 mc_manager_web 目录（可用 BUILD_WEB=0 跳过前端构建）"
    exit 1
  fi
  echo "构建前端（BUILD_WEB=0 可跳过）..."
  (cd "$WEB_DIR" && npm run build)
  rm -rf "$SERVER_DIR/public"
  mkdir -p "$SERVER_DIR/public"
  cp -r "$WEB_DIR/dist/." "$SERVER_DIR/public/"
else
  # 跳过构建也清理旧产物：避免过期前端被打进发布包
  # （残留旧 public/ 会导致部署后静态托管展示上次构建的旧 UI）
  echo "跳过前端构建（BUILD_WEB=0），清理旧 public/ 产物"
  rm -rf "$SERVER_DIR/public"
fi

mkdir -p "$RELEASE_DIR"
echo "打包后端代码到 $OUTPUT ..."
cd "$SERVER_DIR"
rm -f "$OUTPUT"
tar -czf "$OUTPUT" \
  --exclude="node_modules" \
  --exclude=".env" \
  --exclude="data" \
  --exclude="servers" \
  --exclude="backups" \
  --exclude="*.log" \
  --exclude="*.pid" \
  --exclude=".tmp*" \
  .
SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "打包完成: $OUTPUT ($SIZE)"
echo ""
echo "文件数: $(tar -tzf "$OUTPUT" | wc -l)"
