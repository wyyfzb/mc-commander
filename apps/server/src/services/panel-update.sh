#!/usr/bin/env bash
# 面板自更新：由 root 的一次性 systemd 单元执行，面板只管触发。
#
# 为什么不在面板进程里做：更新要把 node_modules 清空重建，期间面板自己就是
# 那个依赖被抽走却还在服务的进程；而一旦它在中途退出，就再没有东西能执行
# 回滚——用户看到的是白屏，且盘上是「代码已换新 + 依赖残缺」。
# 交给单元执行后，面板可以放心先退出，失败时由本脚本把旧版本放回去并拉起。
#
# 目标版本经请求文件传（UPDATE_REQUEST）：单元名必须固定，而 sudoers 的 command
# 参数禁止通配符，无法按 tag 授权不同的单元实例。文件由面板写入，读完即删。
set -uo pipefail

if [ -z "${MC_COMMANDER_DIR:-}" ]; then
  echo "必须通过 MC_COMMANDER_DIR 指定安装目录" >&2
  exit 2
fi
if [ -z "${UPDATE_REQUEST:-}" ] || [ ! -f "$UPDATE_REQUEST" ]; then
  echo "缺少更新请求文件（UPDATE_REQUEST）" >&2
  exit 2
fi
TARGET_TAG=$(sed -n '1p' "$UPDATE_REQUEST" | tr -d '[:space:]')
rm -f "$UPDATE_REQUEST"
# tag 会拼进下载 URL，只接受 v<X.Y.Z>：其余形态既拼不出合法地址，也不该被接受
if ! printf '%s' "$TARGET_TAG" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "目标版本形态不正确：$TARGET_TAG" >&2
  exit 2
fi

INSTALL_DIR="$MC_COMMANDER_DIR"
BACKUP_DIR="$INSTALL_DIR/.rollback"
ENV_FILE="$INSTALL_DIR/.env"
LOG_TAG="[panel-update]"

log() { echo "$LOG_TAG $*"; }
warn() { echo "$LOG_TAG [WARN] $*" >&2; }

# 启动面板并回报真的能用。
#
# 必须先 reset-failed：短时间内多次启动失败后 systemd 直接拒绝再启动
# （实测报 "Start request repeated too quickly"），此时光 start 是空操作。
start_panel() {
  local port deadline
  systemctl reset-failed mc-commander 2>/dev/null || true
  systemctl start mc-commander 2>/dev/null || true
  # 判据取 /health 真的应答，不取单元状态：进程崩溃重启的间隙 systemd 仍报 active，
  # 只查 is-active 会在面板实际不可用时给出「可用」的结论。
  port=25566
  if [ -f "$ENV_FILE" ]; then
    port=$(sed -n 's/^[[:space:]]*PORT=[[:space:]]*\([0-9]*\).*/\1/p' "$ENV_FILE" 2>/dev/null | tail -1)
    port="${port:-25566}"
  fi
  deadline=$((SECONDS + 30))
  while [ "$SECONDS" -lt "$deadline" ]; do
    curl -sf --max-time 3 "http://localhost:$port/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# 失败收尾的唯一入口：把备份放回去并重启，尽力恢复到更新前的可用状态。
restore_and_exit() {
  local code="${1:-1}"
  warn "更新失败（退出码 $code），正在回退到更新前的版本..."
  if [ ! -d "$BACKUP_DIR" ]; then
    warn "没有可用备份，无法自动回退"
    start_panel || true
    exit "$code"
  fi
  for entry in src public mc-schemas package.json package-lock.json; do
    [ -e "$BACKUP_DIR/$entry" ] || continue
    rm -rf "${INSTALL_DIR:?}/$entry"
    cp -a "$BACKUP_DIR/$entry" "$INSTALL_DIR/" 2>/dev/null || true
  done
  # 依赖也要退回去：新版本的 lock 与旧代码不匹配，直接启旧代码会缺模块
  if [ -d "$BACKUP_DIR/node_modules" ]; then
    rm -rf "${INSTALL_DIR:?}/node_modules"
    cp -a "$BACKUP_DIR/node_modules" "$INSTALL_DIR/" 2>/dev/null || true
  fi
  # 回滚只把代码放回去，服务不一定起得来：验证后再给结论
  if start_panel; then
    warn "已回退到更新前的版本，面板可用"
  else
    warn "已回退代码，但面板仍未能启动，请查看日志：journalctl -u mc-commander -n 50"
  fi
  exit "$code"
}

# 版本一致性判据：更新成功后必须能在 /health 上读到目标版本，否则等于没升上去
wait_for_version() {
  local expect="$1" deadline=$((SECONDS + 60))
  # 端口从 .env 读：用户可能改过，写死 25566 会把改过端口的部署判成失败
  local port="25566"
  if [ -f "$INSTALL_DIR/.env" ]; then
    port=$(sed -n 's/^[[:space:]]*PORT=[[:space:]]*\([0-9]*\).*/\1/p' "$INSTALL_DIR/.env" | head -1)
    port="${port:-25566}"
  fi
  while [ "$SECONDS" -lt "$deadline" ]; do
    local seen
    seen=$(curl -sf --max-time 3 "http://localhost:$port/health" 2>/dev/null \
      | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    [ "$seen" = "$expect" ] && return 0
    sleep 2
  done
  return 1
}

TMP_DIR=$(mktemp -d -t mc-commander-update.XXXXXX) || {
  warn "无法创建临时目录"
  exit 1
}
trap 'rm -rf "$TMP_DIR"' EXIT

log "开始更新到 $TARGET_TAG（安装目录：$INSTALL_DIR）"

# 1. 先备份：备份失败就不再往下走，没有退路的更新不允许开始
rm -rf "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
for entry in src public mc-schemas package.json package-lock.json node_modules; do
  [ -e "$INSTALL_DIR/$entry" ] || continue
  if ! cp -a "$INSTALL_DIR/$entry" "$BACKUP_DIR/"; then
    warn "备份 $entry 失败，中止更新"
    rm -rf "$BACKUP_DIR"
    exit 1
  fi
done
log "已备份当前版本"

# 2. 下载产物与摘要
BASE="https://github.com/wyyfzb/mc-commander/releases/download/$TARGET_TAG"
PKG="$TMP_DIR/pkg.tar.gz"
SUMS="$TMP_DIR/SHA256SUMS.txt"
for url in "$BASE/SHA256SUMS.txt" "$BASE/mc-commander-server.tar.gz"; do
  out="$SUMS"
  case "$url" in *.tar.gz) out="$PKG" ;; esac
  if ! curl -fSL --connect-timeout 15 --retry 2 --retry-all-errors \
      --speed-limit 1024 --speed-time 60 -o "$out" "$url"; then
    warn "下载失败：$url"
    restore_and_exit 1
  fi
done

# 3. 校验摘要：宁可失败也不装一个来源不明的包
want=$(grep -F 'mc-commander-server.tar.gz' "$SUMS" | awk '{print $1}' | head -1)
got=$(sha256sum "$PKG" | awk '{print $1}')
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  warn "摘要校验失败（期望 ${want:-无}，实际 $got）"
  restore_and_exit 1
fi
log "产物校验通过"

# 4. 解包并校验结构
tar -xzf "$PKG" -C "$TMP_DIR" || {
  warn "解包失败"
  restore_and_exit 1
}
for must in package.json src/index.js mc-schemas/dist/index.js; do
  if [ ! -e "$TMP_DIR/$must" ]; then
    warn "产物不完整：缺少 $must"
    restore_and_exit 1
  fi
done

# 5. 换代码：先清后铺，避免旧版本已移除的文件残留
for entry in src public mc-schemas; do
  rm -rf "${INSTALL_DIR:?}/$entry"
done
cp -rf "$TMP_DIR/." "$INSTALL_DIR/" || {
  warn "替换代码失败"
  restore_and_exit 1
}
chown -R mc-commander:mc-commander "$INSTALL_DIR" 2>/dev/null || true

# 6. 重建依赖：npm ci 会先清空 node_modules，故停面板这一步必须在它之前
cd "$INSTALL_DIR" || restore_and_exit 1
export npm_config_node_mirror="https://npmmirror.com/mirrors/node/"
if ! npm ci --omit=dev --registry=https://registry.npmmirror.com; then
  warn "依赖安装失败（国内镜像）"
  if ! npm ci --omit=dev --registry=https://registry.npmjs.org; then
    warn "依赖安装失败（官方源）"
    restore_and_exit 1
  fi
fi

# 7. 重启并验证真的升上去了
systemctl reset-failed mc-commander 2>/dev/null || true; systemctl restart mc-commander 2>/dev/null || true
if wait_for_version "${TARGET_TAG#v}"; then
  log "更新成功：当前版本 ${TARGET_TAG#v}"
  # 成功后才清备份：留着会让下次更新把更旧的代码当回退目标
  rm -rf "$BACKUP_DIR"
  exit 0
fi
warn "重启后 60 秒内未读到目标版本 ${TARGET_TAG#v}"
restore_and_exit 1
