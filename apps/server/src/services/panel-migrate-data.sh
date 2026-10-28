#!/usr/bin/env bash
# 数据目录迁移：由 root 的一次性 systemd 单元执行，面板只负责发起。
#
# 为什么不能由面板进程自己做：搬运期间必须停掉全部 MC 实例（否则世界存档一边被
# 写一边被复制，产物不可用），而面板一停就没法回报进度；更关键的是失败时要把旧
# 目录原样放回去，那个动作发生在面板已经不可用的时刻。
#
# 参数经请求文件传递（MIGRATE_REQUEST），不走命令行实参：实参要进 sudoers 白名单，
# 而目标路径由用户输入、无法逐字匹配。请求文件由面板写入，本脚本读完即删。
# 内容两行：第一行类别（servers|data|backups），第二行目标绝对路径。
set -uo pipefail

if [ -z "${MC_COMMANDER_DIR:-}" ]; then
  echo "必须通过 MC_COMMANDER_DIR 指定安装目录" >&2
  exit 2
fi
if [ -z "${MIGRATE_REQUEST:-}" ] || [ ! -f "$MIGRATE_REQUEST" ]; then
  echo "缺少迁移请求文件（MIGRATE_REQUEST）" >&2
  exit 2
fi

KEY=$(sed -n '1p' "$MIGRATE_REQUEST")
TARGET=$(sed -n '2p' "$MIGRATE_REQUEST")
rm -f "$MIGRATE_REQUEST"

if [ -z "$KEY" ] || [ -z "$TARGET" ]; then
  echo "迁移请求文件内容不完整" >&2
  exit 2
fi
# 目标必须是绝对路径：相对路径会按 root 的 cwd 解析，落到谁也找不到的地方
case "$TARGET" in
  /*) ;;
  *)
    echo "目标目录必须是绝对路径：$TARGET" >&2
    exit 2
    ;;
esac

# 一旦改过 .env 就要能退回：systemd 的 TimeoutStartSec 到点会直接 SIGTERM，
# 那条路径不经过下面的显式收尾，留下「配置指向新目录、数据只搬了一半」的现场，
# 而面板此刻已经起不来了——用户没有任何界面能改回去。
ENV_TOUCHED=0
SOURCE_ORIG=""
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

rollback_on_signal() {
  if [ "$ENV_TOUCHED" -eq 1 ] && [ -n "$SOURCE_ORIG" ] && [ -f "$ENV_FILE" ]; then
    set_env_value "$ENV_KEY" "$SOURCE_ORIG" || warn "回落 ${ENV_KEY} 失败，请手工改成 ${SOURCE_ORIG}"
    warn "被中断，已把 ${ENV_KEY} 退回 ${SOURCE_ORIG}"
    start_panel || true
  fi
  exit 143
}
trap rollback_on_signal TERM INT

INSTALL_DIR="$MC_COMMANDER_DIR"
ENV_FILE="$INSTALL_DIR/.env"
LOG_TAG="[panel-migrate]"

log() { echo "$LOG_TAG $*"; }
warn() { echo "$LOG_TAG [WARN] $*" >&2; }

case "$KEY" in
  servers) ENV_KEY="SERVERS_DIR" ;;
  data) ENV_KEY="DATA_DIR" ;;
  backups) ENV_KEY="BACKUPS_DIR" ;;
  *)
    warn "不认识的目录类别：$KEY"
    exit 2
    ;;
esac

# 目标目录必须落在已存在的挂载点上：迁移的唯一理由是换一个更大的分区，
# 指到一个不存在的路径会让 rsync 在根分区上建目录，等于没迁。
PARENT=$(dirname "$TARGET")
if [ ! -d "$PARENT" ]; then
  warn "目标父目录不存在：$PARENT（请先挂载数据盘）"
  exit 1
fi

# 写 .env 的键值。路径里可能出现 sed 分隔符（用户的数据盘叫什么名字不由我们定），
# 故把分隔符本身转义，并且**检查写入是否真的生效**——写失败却继续往下走会产出
# 「数据搬走了、配置还指向旧目录」的现场，而脚本已报成功。
set_env_value() {
  local key="$1" value="$2" escaped
  escaped=$(printf '%s' "$value" | sed 's/[|&\\]/\\&/g')
  sed -i "s|^[[:space:]]*${key}=.*|${key}=${escaped}|" "$ENV_FILE" 2>/dev/null
  # 判据取回读：sed 静默失败（分隔符冲突、权限、只读）都不会有非零退出码
  grep -qxF "${key}=${value}" "$ENV_FILE"
}

# 源目录按 .env 实际生效值解析：用户可能已经改过一次，按 ./var/* 猜会搬错东西
resolve_source() {
  local key="$1" fallback="$2" val
  val=$(sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '"'"'"'')
  if [ -z "$val" ]; then
    val="$fallback"
  fi
  case "$val" in
    /*) printf '%s' "$val" ;;
    *) printf '%s' "$INSTALL_DIR/${val#./}" ;;
  esac
}

case "$KEY" in
  servers) SOURCE=$(resolve_source SERVERS_DIR ./var/servers) ;;
  data) SOURCE=$(resolve_source DATA_DIR ./var/data) ;;
  backups) SOURCE=$(resolve_source BACKUPS_DIR ./var/backups) ;;
esac

# 归一后再比：软链与真身是同一份数据，按字面比会判成「不同目录」，
# 于是不搬东西却把 .env 改成软链路径——用户以为迁完了，数据还在原处
if command -v realpath &>/dev/null; then
  SOURCE_REAL=$(realpath -m "$SOURCE")
  TARGET_REAL=$(realpath -m "$TARGET")
else
  SOURCE_REAL="$SOURCE"
  TARGET_REAL="$TARGET"
fi
if [ "$SOURCE_REAL" = "$TARGET_REAL" ]; then
  warn "目标与当前目录是同一个位置（含软链），无需迁移：$SOURCE_REAL"
  exit 1
fi
# .env 里写归一后的路径：软链目标一旦被删，配置就指向一个不存在的位置，
# 而面板此时已经起不来，用户无法在界面里改回去
TARGET="$TARGET_REAL"
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  # 覆盖一个非空目录等于把两份数据混在一起，且无法区分哪些属于哪次迁移
  warn "目标目录已存在且非空：$TARGET"
  exit 1
fi

log "迁移 $KEY：$SOURCE → $TARGET"

# 1. 停面板与实例：搬运期间世界存档被写会让产物不可用。
# 停自己不受影响：本脚本跑在独立的 oneshot 单元里，实测停掉另一个单元不会连带
# 终止它（停面板后 is-active 仍为 activating，直到脚本自己跑完）。
systemctl stop mc-commander 2>/dev/null || true
INSTANCE_PIDS=$(pgrep -f "$INSTALL_DIR/.*\.jar" 2>/dev/null || true)
if [ -n "$INSTANCE_PIDS" ]; then
  log "停止运行中的实例..."
  echo "$INSTANCE_PIDS" | xargs -r kill -TERM 2>/dev/null || true
  sleep 3
  INSTANCE_PIDS=$(pgrep -f "$INSTALL_DIR/.*\.jar" 2>/dev/null || true)
  [ -n "$INSTANCE_PIDS" ] && echo "$INSTANCE_PIDS" | xargs -r kill -KILL 2>/dev/null || true
fi

# 2. 搬运：权限、时间戳、属主全部保留；-H 让硬链接（备份快照）不膨胀
mkdir -p "$TARGET" || {
  warn "无法创建目标目录：$TARGET"
  start_panel || true
  exit 1
}
if [ -d "$SOURCE" ]; then
  if ! rsync -aH --info=stats2 "$SOURCE/" "$TARGET/"; then
    warn "复制失败，已保留原目录未做任何改动：$SOURCE"
    start_panel || true
    exit 1
  fi
fi
chown -R mc-commander:mc-commander "$TARGET" 2>/dev/null || true

# 3. 改 .env 指向新目录（同时改 .env.example 会影响后续新装，故只改 .env）
SOURCE_ORIG="$SOURCE"
ENV_TOUCHED=1
touch "$ENV_FILE"
if grep -qE "^[[:space:]]*${ENV_KEY}=" "$ENV_FILE"; then
  set_env_value "$ENV_KEY" "$TARGET" || {
    warn "无法把 ${ENV_KEY} 写成 ${TARGET}，已中止并保留原目录"
    start_panel || true
    exit 1
  }
else
  printf '%s=%s\n' "$ENV_KEY" "$TARGET" >> "$ENV_FILE"
fi
chown mc-commander:mc-commander "$ENV_FILE" 2>/dev/null || true
chmod 600 "$ENV_FILE" 2>/dev/null || true

# 4. 起来验证：起不来就退回原配置，数据仍在原目录
start_panel || true
PORT="25566"
PORT=$(sed -n 's/^[[:space:]]*PORT=[[:space:]]*\([0-9]*\).*/\1/p' "$ENV_FILE" 2>/dev/null | tail -1)
PORT="${PORT:-25566}"
READY=0
for _ in $(seq 1 30); do
  if curl -sf --max-time 3 "http://localhost:$PORT/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" -eq 1 ]; then
  log "迁移完成，数据现在位于 $TARGET"
  # 原目录不自动删：迁移是高风险动作，留一份旧数据让用户确认无误后自行清理，
  # 面板会在下次进入时提示占用
  log "原目录 $SOURCE 已保留，确认无误后可手动删除"
  exit 0
fi

warn "新目录下服务未就绪，正在退回原配置"
if grep -qE "^[[:space:]]*${ENV_KEY}=" "$ENV_FILE"; then
  set_env_value "$ENV_KEY" "$SOURCE" || warn "退回 ${ENV_KEY} 失败，请手工改成 ${SOURCE}"
fi
if start_panel; then
  warn "已退回 $SOURCE，面板可用；新目录 $TARGET 保留未删，请检查后重试"
else
  # 回滚成功不等于服务恢复：起不来时用户点开任何页面都是白屏，
  # 只说「已退回」会让他以为问题在别处
  warn "已退回 $SOURCE，但面板仍未能启动，请查看日志：journalctl -u mc-commander -n 50"
  warn "数据在新旧两个目录里都完整：旧 $SOURCE，新 $TARGET"
fi
exit 1
