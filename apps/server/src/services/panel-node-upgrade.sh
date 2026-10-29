#!/usr/bin/env bash
# 运行环境（Node.js）升级：由 root 的一次性 systemd 单元执行，面板只管触发。
#
# 为什么不在面板里做：换 /usr/local/bin 下的软链需要 root，而面板以 mc-commander 身份运行。
# 交给单元执行后，面板可以先退出，失败由本脚本把软链改回旧指向并重新拉起。
#
# 只升级本脚本自己管理的软链（指向 /opt/node-v* 的那些）。指向别处的（发行版包、用户自装）
# 一律不动：改它等于改用户的系统环境，且失败时无从判断该恢复到什么状态。
set -uo pipefail

if [ -z "${MC_COMMANDER_DIR:-}" ]; then
  echo "必须通过 MC_COMMANDER_DIR 指定安装目录" >&2
  exit 2
fi

INSTALL_DIR="$MC_COMMANDER_DIR"
LOG_TAG="[panel-node]"
BIN_DIR=/usr/local/bin
STATE_FILE="$INSTALL_DIR/.node-upgrade-state"
mkdir -p "$INSTALL_DIR" 2>/dev/null || true

log() { echo "$LOG_TAG $*"; }
warn() { echo "$LOG_TAG [WARN] $*" >&2; }

panel_port() {
  local port=25566
  if [ -f "$INSTALL_DIR/.env" ]; then
    port=$(sed -n 's/^[[:space:]]*PORT=[[:space:]]*\([0-9]*\).*/\1/p' "$INSTALL_DIR/.env" | head -1)
    port="${port:-25566}"
  fi
  printf '%s' "$port"
}

# 判据取 /health 真的应答：进程崩溃重启的间隙 systemd 仍报 active
start_panel() {
  local deadline=$((SECONDS + 120)) port
  port=$(panel_port)
  systemctl reset-failed mc-commander 2>/dev/null || true
  systemctl start mc-commander 2>/dev/null || true
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -sf --max-time 3 "http://localhost:$port/health" >/dev/null 2>&1 && return 0
    sleep 3
  done
  return 1
}

# 某条链接是不是本脚本管的：解析后落在 /opt/node-v*/bin 下
managed_link() {
  local link="$1" real
  real=$(readlink -f "$link" 2>/dev/null) || return 1
  case "$real" in
    /opt/node-v*/bin/*) return 0 ;;
    *) return 1 ;;
  esac
}

arch_name() {
  case "$(uname -m)" in
    x86_64|amd64) echo x64 ;;
    aarch64|arm64) echo arm64 ;;
    *) return 1 ;;
  esac
}

# 失败收尾：把软链改回升级前的指向并重新拉起面板
restore_and_exit() {
  local code="$1"
  warn "升级失败（$code），回退软链"
  if [ -f "$STATE_FILE" ]; then
    local bin target
    while IFS=$'\t' read -r bin target; do
      [ -n "$bin" ] && [ -n "$target" ] || continue
      ln -sfn "$target" "$BIN_DIR/$bin"
    done < "$STATE_FILE"
    log "软链已还原"
  fi
  if start_panel; then
    warn "面板已恢复运行（仍使用原 Node 版本）"
  else
    warn "面板未能启动，请查看：journalctl -u mc-commander -n 50"
  fi
  exit "$code"
}

log "开始检查运行环境（安装目录：$INSTALL_DIR）"

# 1. 当前版本与目标版本
if ! command -v node >/dev/null 2>&1; then
  warn "系统上找不到 node，无法判断当前版本"
  exit 1
fi
CURRENT=$(node -v)
MAJOR="${CURRENT#v}"; MAJOR="${MAJOR%%.*}"

IDX=$(curl -fsSL --max-time 30 "https://nodejs.org/dist/index.json" 2>/dev/null) || {
  warn "取不到 Node.js 版本清单（nodejs.org 不可达），本次不动"
  exit 1
}
TARGET=$(printf '%s' "$IDX" | grep -o "\"version\":\"v${MAJOR}\.[0-9]*\.[0-9]*\"" | head -1 | sed 's/.*"\(v[^"]*\)".*/\1/')
[ -n "$TARGET" ] || { warn "在版本清单里找不到 ${MAJOR} 线的版本"; exit 1; }
log "当前 $CURRENT，${MAJOR} 线最新 $TARGET"

if [ "$CURRENT" = "$TARGET" ]; then
  log "已是最新，无需升级"
  rm -f "$STATE_FILE"
  exit 0
fi

# 2. 先证明可安全升级：所有目标链接必须由本脚本管理
UNMANAGED=""
for bin in node npm npx; do
  [ -e "$BIN_DIR/$bin" ] || continue
  managed_link "$BIN_DIR/$bin" || UNMANAGED="$UNMANAGED $bin"
done
if [ -n "$UNMANAGED" ]; then
  warn "$BIN_DIR 下的$UNMANAGED 不指向本面板管理的 Node（/opt/node-v*）"
  warn "升级会改坏这些命令的环境，故本次不动。请由安装方式来更新它们"
  exit 1
fi

ARCH=$(arch_name) || { warn "不支持的 CPU 架构: $(uname -m)"; exit 1; }
PKG="node-${TARGET}-linux-${ARCH}.tar.xz"
BASE="https://nodejs.org/dist/${TARGET}"

TMP_DIR=$(mktemp -d -t mc-commander-node.XXXXXX) || { warn "无法创建临时目录"; exit 1; }
trap 'rm -rf "$TMP_DIR"' EXIT

# 3. 下载并强校验
log "下载 $PKG"
curl -fsSL --max-time 600 -o "$TMP_DIR/$PKG" "$BASE/$PKG" || { warn "下载失败"; exit 1; }
curl -fsSL --max-time 60 -o "$TMP_DIR/SHASUMS256.txt" "$BASE/SHASUMS256.txt" || { warn "取校验文件失败"; exit 1; }
EXPECT=$(awk -v f="$PKG" '$2 == f {print $1}' "$TMP_DIR/SHASUMS256.txt")
[ -n "$EXPECT" ] || { warn "校验文件里没有 $PKG"; exit 1; }
ACTUAL=$(sha256sum "$TMP_DIR/$PKG" | awk '{print $1}')
[ "$EXPECT" = "$ACTUAL" ] || { warn "sha256 不匹配（预期 $EXPECT，实际 $ACTUAL）"; exit 1; }
log "sha256 校验通过"

# 4. 记录升级前的软链，供失败回退
: > "$STATE_FILE"
for bin in node npm npx; do
  [ -e "$BIN_DIR/$bin" ] || continue
  printf '%s\t%s\n' "$bin" "$(readlink "$BIN_DIR/$bin")" >> "$STATE_FILE"
done

# 5. 解包与切换
tar -xJf "$TMP_DIR/$PKG" -C /opt || restore_and_exit 1
NEW_DIR="/opt/node-${TARGET}-linux-${ARCH}"
[ -x "$NEW_DIR/bin/node" ] || { warn "解包后找不到 $NEW_DIR/bin/node"; restore_and_exit 1; }

# 新版本必须能加载面板的原生依赖，否则重启后必然起不来。
# 在安装目录里跑：Node 会从那里的 node_modules 解析，测的是面板真实使用的二进制。
if ! (cd "$INSTALL_DIR" && "$NEW_DIR/bin/node" -e "require('better-sqlite3')" >/dev/null 2>&1); then
  warn "$TARGET 无法加载面板的原生依赖（better-sqlite3），放弃升级"
  restore_and_exit 1
fi
log "新版本可加载面板依赖"

for bin in node npm npx; do
  ln -sfn "$NEW_DIR/bin/$bin" "$BIN_DIR/$bin"
done
hash -r 2>/dev/null || true
log "已切换到 $("$BIN_DIR/node" -v)，重启面板"

# 6. 重启并验证；失败回退
systemctl restart mc-commander
if start_panel; then
  log "面板已在新版本上运行：$("$BIN_DIR/node" -v)"
  rm -f "$STATE_FILE"
  exit 0
fi
warn "面板在新版本上未能启动"
restore_and_exit 1
