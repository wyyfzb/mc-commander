#!/usr/bin/env bash
# MC_Commander 一键部署脚本
#
# 用法（远程两步命令，推荐先下载再执行，便于审查脚本内容）:
#   curl -fsSL -o /tmp/deploy-mc-commander.sh https://raw.githubusercontent.com/wyyfzb/mc-commander/main/apps/server/scripts/deploy-mc-commander.sh
#   sudo bash /tmp/deploy-mc-commander.sh
#
# 用法（本地执行）:
#   sudo bash deploy-mc-commander.sh
#
# 卸载:
#   sudo bash deploy-mc-commander.sh --uninstall         移除面板（保留 var/ 下的数据）
#   sudo bash deploy-mc-commander.sh --uninstall --purge 连数据一起删（需确认，--yes 可跳过）
#   bash deploy-mc-commander.sh --help                   查看全部用法
#
# 环境变量覆盖:
#   MC_COMMANDER_DIR=/opt/mc-commander  安装目录
#   VERSION=latest                      发布版本：latest（默认）取最新发布版，或 v0.6.0 这类具体 tag。
#                                       旧名 BRANCH 仍作兼容别名生效
#   PACKAGE_URL=xxx                     后端代码包下载地址（tar.gz），默认取 Gitee Release 资产（国内链路）
#   SOURCE_PREFERENCE=github            强制首选 GitHub（默认 gitee）
#   ALLOW_SOURCE_FALLBACK=0             禁用主源失败后的自动换源
#   SHA256SUMS_URL=xxx                  摘要文件地址，默认与 PACKAGE_URL 同 Release；自定义 PACKAGE_URL 时需一并设置
#   NODE_VERSION=v22.23.2               官方二进制兜底安装时固定的 Node.js LTS 版本号
#
# 安全说明：
#   - 代码包下载后取**同一 Release** 的 SHA256SUMS.txt 比对校验，不一致立即中止并删除临时文件。
#     包与摘要恒同源：换源时两个地址一起换（跨源取摘要等于没校验）。
#     摘要与资产同源，故防的是传输损坏与单方面替换资产（Release 已开 Immutable Releases：
#     发布后资产不可增删改、tag 不可删移）；要防「发布方本身被攻陷」需另行核对 tag 签名
#   - 不使用第三方 curl|bash 引导脚本；Node.js 优先发行版官方源，兜底用官方二进制包 + SHASUMS256.txt 校验
#   - systemd 服务以专用低权限用户 mc-commander 运行（25566 高位端口无需 root）
set -euo pipefail
# 函数内的失败也要走到失败兜底：没有它，install_java 之类的函数里出错会静默退出
set -o errtrace

# 失败兜底：set -e 会让脚本在任何一步失败时立刻退出，而默认什么也不说。
# 这里回放 log 打过的最近几行，用户对着自己刚看到的输出就能知道卡在哪，
# 不必读源码；LOG_LINES 只留最近几行，安装全程的日志不驻留内存。
LOG_LINES=()
LOG_LINES_MAX=200
ERR_SHOWN=0

on_error() {
  local rc=$? i start
  # err 已经给出专门解释的失败，不再叠一套通用文案
  [ "$ERR_SHOWN" -eq 1 ] && return 0
  {
    echo ""
    echo "═══════════════════════════════════════════════════"
    echo "  安装中断：这一步没有成功"
    echo "═══════════════════════════════════════════════════"
    echo ""
    echo "最后几行进度："
    start=$((${#LOG_LINES[@]} > 3 ? ${#LOG_LINES[@]} - 3 : 0))
    for ((i = start; i < ${#LOG_LINES[@]}; i++)); do
      echo "  · ${LOG_LINES[$i]}"
    done
    echo ""
    echo "出错位置：$BASH_COMMAND（退出码 $rc）"
    echo ""
    echo "修好上面的问题后，重新运行同一条部署命令即可接着装："
    echo "已下载的代码包会续传，已生成的配置与数据都不会被覆盖。"
  } >&2
}
trap on_error ERR

# 禁止 apt/debconf 在安装过程中弹出交互式配置界面（如 needrestart 服务重启提示）
# 对非 Debian 系统无影响
export DEBIAN_FRONTEND=noninteractive
# 让 needrestart 自动重启使用旧库的服务，不再提示 "Which services should be restarted?"
export NEEDRESTART_MODE=a

MC_COMMANDER_DIR="${MC_COMMANDER_DIR:-/opt/mc-commander}"
# root 执行的删除脚本必须与面板可写目录分离：装一份只读副本，单元只认它
REMOVAL_LIB_DIR="/usr/local/lib/mc-commander"
REMOVAL_SCRIPT="$REMOVAL_LIB_DIR/panel-removal.sh"
# 安装清单：记录「本项目在系统上加了什么」。卸载要靠它精确回滚——
# 没有它就只能猜，而猜错的后果是删掉用户原有的 Java 或留下几百 MB 残留。
MANIFEST="$MC_COMMANDER_DIR/.install-manifest"
MANIFEST_STAGING="$(mktemp -t mc-commander-manifest.XXXXXX)"
# 退出收尾的唯一入口。同一时刻 bash 只保留一个 EXIT trap，后挂的会顶掉先挂的，
# 故临时清单清理与「把停掉的面板拉回来」共用这一个 trap。
# 临时清单只在装包阶段有意义：并入正式清单后或安装中断时都必须消失，
# 否则 /tmp 会留下一份写着「这台机器装了什么」的残件。
PANEL_STOPPED=0
on_exit() {
  rm -f "${MANIFEST_STAGING:-}"
  if [ "${PANEL_STOPPED:-0}" -eq 1 ]; then
    warn "升级中断，正在把面板恢复运行..."
    systemctl start mc-commander 2>/dev/null || warn "自动恢复失败，请手动执行：systemctl start mc-commander"
  fi
}
trap on_exit EXIT

# 记录一条安装痕迹；key 是类别，值逐行追加。
# 装包发生在安装目录创建之前，故先落临时文件，目录就绪后再并入——
# 早于目录创建的记录不能丢，那正是最需要回滚的那批系统包。
record_change() {
  # set -u 下必须给默认值：安装早期就有调用点，漏传会把整个安装打断
  local key="${1:-}" value="${2:-}"
  [ -n "$key" ] || return 0
  local line="$key	$value"
  if [ -d "$MC_COMMANDER_DIR" ]; then
    # 重装会对同一项重复记录，去重后清单才是「有哪些改动」而不是「改了几次」
    grep -qxF "$line" "$MANIFEST" 2>/dev/null || echo "$line" >> "$MANIFEST"
  else
    grep -qxF "$line" "$MANIFEST_STAGING" 2>/dev/null || echo "$line" >> "$MANIFEST_STAGING"
  fi
}

# 装包前记下「装之前有没有」：已存在的不能算本项目的，卸载时跳过
install_pkg_recorded() {
  local existed=""
  for pkg in "$@"; do
    if dpkg -s "$pkg" &>/dev/null 2>&1 || rpm -q "$pkg" &>/dev/null 2>&1; then
      existed="$existed $pkg"
    fi
  done
  install_pkg "$@"
  for pkg in "$@"; do
    case " $existed " in
      *" $pkg "*) record_change "pkg-preexisting" "$pkg" ;;
      *) record_change "pkg-installed" "$pkg" ;;
    esac
  done
}
# VERSION：latest（默认）总是装最新发布版，零维护；指定具体 tag（v0.6.0）则做可复现安装。
# BRANCH 是该变量的旧名，保留为兼容别名——既有 BRANCH=v1.2.0 形式的调用不能被打断。
VERSION="${VERSION:-${BRANCH:-latest}}"
# 资产名固定不含 tag：releases/latest/download/<asset> 无法预知 tag，名字不固定就用不了 latest
ASSET_NAME="mc-commander-server.tar.gz"
# latest 与显式 tag 的下载前缀不同，故分开拼
if [ "$VERSION" = "latest" ]; then
  RELEASE_BASE="https://github.com/wyyfzb/mc-commander/releases/latest/download"
else
  RELEASE_BASE="https://github.com/wyyfzb/mc-commander/releases/download/$VERSION"
fi
# GitHub Release 资产为权威来源（CI 构建）
# 先记录「用户是否显式设过」：下面的默认值赋值会让变量恒非空，
# 之后就无法区分「用户指定了 URL」与「脚本填的默认值」，报错分支会指错方向。
CUSTOM_PACKAGE_URL=0
[ -n "${PACKAGE_URL:-}" ] && CUSTOM_PACKAGE_URL=1
PACKAGE_URL="${PACKAGE_URL:-$RELEASE_BASE/$ASSET_NAME}"
SHA256SUMS_URL="${SHA256SUMS_URL:-$RELEASE_BASE/SHA256SUMS.txt}"

# Gitee 镜像源（国内网络）：同一份发布产物在校验通过后同步到 Gitee Release。
# 为什么需要它：本机实测 GitHub 资产约 5KB/s 且会静默挂死（连 --connect-timeout
# 也救不了，因为 TCP 已建连），而 Gitee 同规模下载 2.3MB/s——相差约 460 倍。
# 为什么不给用户一个开关：本项目的用户多为低代码/无代码服主，让他们先判断
# 「我的网络到 GitHub 通不通」再选参数，是把跨境的复杂度转嫁给最没能力处理的人。
# 故这里自动选路——**默认先 Gitee**（用户实际链路在国内），探测不通或下载失败则自动切
# GitHub 权威源；权威源仍是 GitHub（产物由 CI 构建、Immutable Releases 签名），镜像只是分发。
GITEE_OWNER="${GITEE_OWNER:-wyyfzb}"
GITEE_REPO="${GITEE_REPO:-mc-commander}"
GITEE_API="https://gitee.com/api/v5/repos/$GITEE_OWNER/$GITEE_REPO"
# 源顺序：gitee(默认，国内实测比 GitHub 快约 460 倍) | github(CI 构建的权威源、带 Immutable 签名)
SOURCE_PREFERENCE="${SOURCE_PREFERENCE:-gitee}"
# 主源不可达或该版本资产缺失时，是否自动切到另一源
ALLOW_SOURCE_FALLBACK="${ALLOW_SOURCE_FALLBACK:-1}"
# 兼容旧变量：ALLOW_GITEE_FALLBACK=0 的原意是「只用 GitHub、不切 Gitee」，等价于强制首选 GitHub
[ "${ALLOW_GITEE_FALLBACK:-}" = "0" ] && SOURCE_PREFERENCE="github"
# 探测超时（秒）：GitHub 挂死时 HEAD 实测在 10s 内超时，故不必等下载函数的 60s
PROBE_TIMEOUT="${PROBE_TIMEOUT:-12}"
# 当前实际使用的源，供报错文案与日志显示（先按首选值，选路后覆盖）
SOURCE="$([ "$SOURCE_PREFERENCE" = "github" ] && echo GitHub || echo Gitee)"

log()  {
  LOG_LINES+=("$*")
  # 只保留最近若干行：安装全程可能上百行，失败时用不到更早的
  [ "${#LOG_LINES[@]}" -gt "$LOG_LINES_MAX" ] && LOG_LINES=("${LOG_LINES[@]:1}")
  echo "[$(date '+%H:%M:%S')] $*"
}
warn() { echo "[WARN] $*"; }

# 软件源与密钥的合法落点：清单可被写坏，只有这几个目录下的文件允许删。
# 可注入是为了让用例在沙箱里验证同一条判定（生产环境不需要改它）
REPO_FILE_ROOTS="${REPO_FILE_ROOTS:-/etc/apt/sources.list.d /etc/yum.repos.d /usr/share/keyrings}"

# 前缀匹配挡不住 <root>/../../etc/shadow，故显式拒绝上跳段
repo_file_allowed() {
  case "$1" in ''|*/../*|*/..|../*|..) return 1 ;; esac
  local root
  for root in $REPO_FILE_ROOTS; do
    case "$1" in "$root"/*) return 0 ;; esac
  done
  return 1
}
err()  { ERR_SHOWN=1; echo "[ERROR] $*" >&2; }

# 把 $VERSION/$ASSET_NAME 解析为某源的下载前缀。
# Gitee 没有 releases/latest/download（实测 302 到 repository/archive 后 404，
# 即便该版本确实有 release），故 latest 必须先用匿名 API 解析出真实 tag。
gitee_release_base() {
  local tag="$VERSION"
  if [ "$tag" = "latest" ]; then
    # /releases/latest 可匿名调用；不能用 /releases 列表——实测其排序不可靠
    # （某仓库列表首项 v1.62.3，而真实最新为 v3.142.01）
    tag=$(curl -fsSL --max-time "$PROBE_TIMEOUT" "$GITEE_API/releases/latest" 2>/dev/null |
            sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$tag" ] || return 1
  fi
  echo "https://gitee.com/$GITEE_OWNER/$GITEE_REPO/releases/download/$tag"
}

# 切回 GitHub 权威源（Gitee 不可用时的兜底；latest 直接可用，无需解析 tag）。
# 与 use_gitee 同构：先确认该源上「产物真的在」，再同源改写两个地址。
use_github() {
  if ! source_reachable "$RELEASE_BASE/$ASSET_NAME"; then
    warn "GitHub 上该版本尚无 $ASSET_NAME 产物，保持原源重试"
    return 1
  fi
  PACKAGE_URL="$RELEASE_BASE/$ASSET_NAME"
  SHA256SUMS_URL="$RELEASE_BASE/SHA256SUMS.txt"
  SOURCE="GitHub"
  log "已切换到 GitHub 权威源：$RELEASE_BASE"
  return 0
}

# 探测某源首个字节能否在超时内到达。只读 1 字节：既验证可达，又几乎不耗流量。
# 用范围请求而非 HEAD：Gitee 的下载会 302 到带签名的 CDN，HEAD 在部分实现上不可靠；
# 而 -r 0-0 在两端实测都稳定返回。
source_reachable() {
  local url="$1"
  curl -fsSL -r 0-0 --max-time "$PROBE_TIMEOUT" -o /dev/null "$url" 2>/dev/null
}

# 切换下载源（幂等）。切换后 PACKAGE_URL/SHA256SUMS_URL 一并指向新源，
# 保证「包 + 摘要」同源——跨源取摘要会让完整性校验失去意义。
#
# 必须先确认该源上「产物真的在」再切：Gitee 的 release 可能只有元数据而无附件
# （手工占位建的、或同步尚未跑过），切过去必然 404，而留在原源重试或许能成功
# ⇒ 会把一个本来装得上的场景做成失败。故探测实际资产可达性，不可达即拒绝切换。
use_gitee() {
  local base
  base=$(gitee_release_base) || {
    warn "无法从 Gitee 解析版本信息（API 不可达或该版本尚未同步）"
    return 1
  }
  if ! source_reachable "$base/$ASSET_NAME"; then
    warn "Gitee 上该版本尚无 $ASSET_NAME 产物，保持原源重试"
    return 1
  fi
  PACKAGE_URL="$base/$ASSET_NAME"
  SHA256SUMS_URL="$base/SHA256SUMS.txt"
  SOURCE="Gitee"
  log "已切换到 Gitee 镜像源：$base"
  return 0
}

# ─────────────────────────── 卸载子命令 ───────────────────────────
# 安装会产生 4 类系统级副作用，用户想「干净重来/彻底不装了」时无从下手：
#   ① 安装目录（默认 /opt/mc-commander）  ② 专用系统用户 mc-commander
#   ③ /etc/systemd/system/mc-commander.service  ④ 已 enable 的符号链接
# 默认**保留**数据（var/servers/ 是玩家的世界，删掉不可恢复）：只停服务、
# 卸 systemd、删目录里的代码，数据目录原样留下并打印位置。
# 要连数据一起删，必须显式 --purge 且交互确认（或 --yes 跳过确认）。
uninstall_usage() {
  cat <<'USAGE'
用法：
  sudo bash deploy-mc-commander.sh                 安装 / 升级（默认，取最新发布版）
  sudo bash deploy-mc-commander.sh --uninstall     卸载（保留数据）
  sudo bash deploy-mc-commander.sh --help          显示本帮助

安装 / 升级常用环境变量（详见脚本头部注释）：
  MC_COMMANDER_DIR=/opt/mc-commander   安装目录
  VERSION=latest | v0.6.0              发布版本（latest 取最新；指定 tag 可复现安装）
  SKIP_DOWNLOAD=1                      跳过下载，用安装目录里已有的代码
  PACKAGE_URL=… / SHA256SUMS_URL=…     自定义代码包与其摘要地址

卸载选项（--uninstall 之后）：
  --purge            连安装目录一起删除（含所有世界存档，不可恢复）
  --yes              跳过交互确认（配合 --purge 做自动化；请自行确认目录无误）

卸载默认只做「移除面板本身」，Minecraft 实例目录与备份一律保留。
USAGE
}

# 停掉仍在运行的 MC 实例（按各实例目录下的 pid 文件，逐个验活后 TERM→KILL）。
#
# 实例是 detached 进程，面板停了它们还在跑。删目录前必须让它们先退出：
# 世界存档正在被写入时被 rm -rf，进程不会自己发现，玩家看到区块加载失败，
# 而存档已经找不回来了。
stop_running_instances() {
  local servers_dir="$MC_COMMANDER_DIR/var/servers"
  [ -d "$servers_dir" ] || return 0

  local pidfile pid found=0
  while IFS= read -r pidfile; do
    [ -f "$pidfile" ] || continue
    pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$pidfile" | head -1)
    [ -n "$pid" ] || continue
    # pid 可能已被复用给别的进程：只对「命令行里带这个实例目录」的进程下手
    # /proc/PID 可能刚消失（进程恰在此刻退出）：先判存在再读，
    # 否则重定向本身的报错会漏到 stderr，看起来像卸载失败
    if [ ! -r "/proc/$pid/cmdline" ] ||
      ! tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF "$(dirname "$pidfile")"; then
      continue
    fi
    found=1
    log "停止仍在运行的实例进程（pid $pid，$(basename "$(dirname "$pidfile")")）..."
    kill -TERM "$pid" 2>/dev/null || true
  done < <(find "$servers_dir" -maxdepth 2 -name '.mc-commander-pid' 2>/dev/null)

  [ "$found" -eq 1 ] || return 0

  # 给 JVM 存档时间（MC 关服要落盘区块），超时再强杀
  local waited=0
  while [ "$waited" -lt 30 ]; do
    local alive=0
    while IFS= read -r pidfile; do
      [ -f "$pidfile" ] || continue
      pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$pidfile" | head -1)
      [ -n "$pid" ] || continue
      [ -r "/proc/$pid/cmdline" ] &&
        tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF "$(dirname "$pidfile")" && alive=1
    done < <(find "$servers_dir" -maxdepth 2 -name '.mc-commander-pid' 2>/dev/null)
    [ "$alive" -eq 0 ] && break
    sleep 2
    waited=$((waited + 2))
  done

  while IFS= read -r pidfile; do
    [ -f "$pidfile" ] || continue
    pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$pidfile" | head -1)
    [ -n "$pid" ] || continue
    if [ -r "/proc/$pid/cmdline" ] &&
      tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF "$(dirname "$pidfile")"; then
      warn "实例进程 $pid 未在 30 秒内退出，强制结束"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done < <(find "$servers_dir" -maxdepth 2 -name '.mc-commander-pid' 2>/dev/null)
  log "实例进程已全部停止"
}

# 清掉没有 pidfile 的孤儿实例进程。
#
# pidfile 由面板写入，手工起过、或面板异常退出时留下的实例没有它，
# 上面按 pidfile 停实例就覆盖不到。它们继续以 mc-commander 用户运行：
# 用户删不掉、端口仍被占、存档仍在被写。
stop_orphan_instances() {
  local servers_dir="$1"
  [ -d "$servers_dir" ] || return 0
  local pids
  pids=$(pgrep -f "$servers_dir/[^/]*/server.jar" 2>/dev/null || true)
  [ -n "$pids" ] || return 0
  log "停止无 pidfile 的实例进程..."
  echo "$pids" | xargs -r kill -TERM 2>/dev/null || true
  local waited=0
  while [ "$waited" -lt 30 ]; do
    pids=$(pgrep -f "$servers_dir/[^/]*/server.jar" 2>/dev/null || true)
    [ -z "$pids" ] && return 0
    sleep 2
    waited=$((waited + 2))
  done
  pids=$(pgrep -f "$servers_dir/[^/]*/server.jar" 2>/dev/null || true)
  [ -n "$pids" ] && echo "$pids" | xargs -r kill -KILL 2>/dev/null || true
  return 0
}

do_uninstall() {
  local purge=0 assume_yes=0
  shift # 丢掉 --uninstall 本身
  while [ $# -gt 0 ]; do
    case "$1" in
      --purge) purge=1 ;;
      --yes|-y) assume_yes=1 ;;
      -h|--help) uninstall_usage; return 0 ;;
      *)
        err "未知选项：$1"
        uninstall_usage
        return 2
        ;;
    esac
    shift
  done

  if [ "$(id -u)" -ne 0 ]; then
    err "卸载需要 root（要停服务、删 systemd 单元与专用用户）"
    err "请用：sudo bash $0 --uninstall"
    return 1
  fi

  # 目录安全校验：宁可拒绝也不 rm -rf 一个危险路径。
  # 允许用户用 MC_COMMANDER_DIR 覆盖，但绝不允许 / 、/usr 、/etc 这类位置——
  # 一个手误的 MC_COMMANDER_DIR=/ 会让 --purge 抹掉整个系统。
  case "$MC_COMMANDER_DIR" in
    /|/usr|/usr/|/etc|/etc/|/var|/var/|/opt|/opt/|/home|/home/|/root|/root/|""|/)
      err "拒绝在危险路径上执行卸载：MC_COMMANDER_DIR=$MC_COMMANDER_DIR"
      err "请显式指定安装目录，例如：sudo MC_COMMANDER_DIR=/opt/mc-commander bash $0 --uninstall"
      return 1
      ;;
  esac

  log "卸载 MC_Commander（安装目录：$MC_COMMANDER_DIR）"

  # 0. 先停掉仍在运行的服务器实例。
  #
  # 实例是 detached 进程，**不随面板服务停止**：只停面板时它们继续跑、继续写存档、
  # 继续对外提供服务。用户看到「面板已卸载」，玩家却还能连进来。而且这些进程以
  # mc-commander 用户运行，留着它们会让下一步的 userdel 必然失败。
  # 先停实例再动服务与用户，顺序不能反。
  if [ -d "$MC_COMMANDER_DIR/var/servers" ]; then
    local running
    running=$(find "$MC_COMMANDER_DIR/var/servers" -maxdepth 2 -name server.jar 2>/dev/null | wc -l)
    if [ "$running" -gt 0 ]; then
      log "停止运行中的服务器实例..."
      stop_running_instances
    fi
    # pidfile 覆盖不到的（手工起过、面板异常退出留下的）单独清一遍
    stop_orphan_instances "$MC_COMMANDER_DIR/var/servers"
  fi

  # 1. 停服务并禁止开机自启（先停再删单元，否则 systemd 可能残留 failed 状态）
  #
  # systemd 单元与专用用户都是**按名字全局唯一**的，而安装目录是可覆盖的：
  # 拿另一个 MC_COMMANDER_DIR 跑 --uninstall 时，/etc/systemd/system/mc-commander.service
  # 指向的可能是**另一份安装**。故先核对单元的 WorkingDirectory 是否就是本次要卸的目录，
  # 不一致就只卸目录内容、不动全局的服务与用户（否则会误伤同一个机器上的另一套部署）。
  local unit_path=/etc/systemd/system/mc-commander.service
  local unit_matches=0
  if [ -f "$unit_path" ]; then
    local unit_dir
    unit_dir=$(sed -n 's/^[[:space:]]*WorkingDirectory=//p' "$unit_path" | head -1)
    if [ "$unit_dir" = "$MC_COMMANDER_DIR" ]; then
      unit_matches=1
    else
      warn "发现已存在的 mc-commander.service 指向 $unit_dir（不是本次的 $MC_COMMANDER_DIR）"
      warn "将保留该服务与用户 mc-commander，只卸载 $MC_COMMANDER_DIR 里的内容"
    fi
  fi

  if [ "$unit_matches" -eq 1 ] && command -v systemctl &>/dev/null; then
    log "停止并禁用 systemd 服务..."
    systemctl stop mc-commander 2>/dev/null || true
    systemctl disable mc-commander 2>/dev/null || true
    rm -f "$unit_path" \
          /etc/systemd/system/mc-commander-removal.service \
          /etc/systemd/system/mc-commander-removal-keep.service
    rm -rf "$REMOVAL_LIB_DIR"
    rm -f /etc/sudoers.d/mc-commander
    systemctl daemon-reload 2>/dev/null || true
    systemctl reset-failed mc-commander 2>/dev/null || true
    log "已删除 /etc/systemd/system/mc-commander.service"
  elif [ "$unit_matches" -eq 0 ] && [ ! -f "$unit_path" ]; then
    log "未发现 systemd 服务（可能当初以非 root 部署）"
  fi

  # 2. 删除专用用户（仅在确认单元归属本目录、或压根没有单元时）
  # 家目录就是安装目录，先删用户不影响后续 rm
  if [ "$unit_matches" -eq 1 ] && id -u mc-commander &>/dev/null; then
    # 实例已在上一步停掉，仍失败多半是还有残留进程（手工起过的实例、残留子进程）
    if userdel mc-commander 2>/dev/null; then
      log "已删除系统用户 mc-commander"
    else
      warn "未能删除系统用户 mc-commander（仍有进程以它运行）"
      warn "查看占用：ps -u mc-commander"
      warn "停掉后再删：sudo pkill -u mc-commander && sudo userdel mc-commander"
    fi
  fi

  # 清单是安装目录里的文件，--purge 的 rm -rf 会连它一起删掉，故回滚必须读这份内存副本。
  local manifest_lines=""
  [ -f "$MANIFEST" ] && manifest_lines=$(cat "$MANIFEST")

  # 3. 目录处理：默认保留数据，--purge 才整体删除
  #
  # 运行中的 MC 实例不会随面板停止（面板停机不停实例，实例是 detached 进程）。
  # 直接 rm -rf 会把正在写的世界存档从底下抽走：进程继续跑、文件已消失，
  # 玩家看到的是区块加载失败，而存档已经救不回来。故删之前必须先把实例停干净。
  if [ "$purge" -eq 1 ]; then
    stop_running_instances

    if [ "$assume_yes" -ne 1 ]; then
      echo ""
      warn "即将永久删除：$MC_COMMANDER_DIR"
      warn "其中 var/servers/ 下的每个实例都是**完整的 Minecraft 世界存档**，删掉无法恢复。"
      printf "确认删除请输入 yes："
      read -r answer
      if [ "$answer" != "yes" ]; then
        log "已取消（未删除任何数据）"
        return 0
      fi
    fi
    rm -rf "$MC_COMMANDER_DIR"
    log "已删除安装目录（含全部世界存档）"
  else
    # 只删面板自己的代码与依赖，保留三个数据目录。
    # 清单必须覆盖安装时铺下的**全部**条目：漏一项就留下几十 MB 与含凭据的 .env，
    # 用户按「已卸载」理解、实际机器上还躺着一份能用的部署
    log "保留数据目录（var/ 下的 servers/ data/ backups/）"
    for item in src public mc-schemas node_modules package.json package-lock.json .env.example; do
      [ -e "$MC_COMMANDER_DIR/$item" ] && rm -rf "${MC_COMMANDER_DIR:?}/$item"
    done

    # .env 里有 API Key 摘要与可能仍在生效的 SETUP_TOKEN，不静默删（用户可能想留档），
    # 但必须说清它还在、还敏感
    if [ -e "$MC_COMMANDER_DIR/.env" ]; then
      warn "保留 $MC_COMMANDER_DIR/.env（含 API Key 摘要与初始化令牌）"
      warn "不再需要请手动删除：sudo rm -f $MC_COMMANDER_DIR/.env"
    fi

    if [ -d "$MC_COMMANDER_DIR" ]; then
      echo ""
      # 逐项核实是否真有内容：只按目录存在与否就说「数据仍然保留」，
      # 在空目录上等于告诉用户「你的存档还在」——他可能因此不去备份就重装系统
      local kept=0
      local kept_lines=""
      for d in var/servers var/data var/backups; do
        if [ -d "$MC_COMMANDER_DIR/$d" ]; then
          local n
          n=$(find "$MC_COMMANDER_DIR/$d" -type f 2>/dev/null | wc -l)
          if [ "$n" -gt 0 ]; then
            kept=1
            kept_lines="$kept_lines"$'\n'"  - $d/（$n 个文件）"
          fi
        fi
      done
      if [ "$kept" -eq 1 ]; then
        log "面板已卸载。以下数据**仍然保留**在 $MC_COMMANDER_DIR："
        echo "$kept_lines"
        log "确认不再需要时，可手动删除整个目录：sudo rm -rf $MC_COMMANDER_DIR"
      else
        log "面板已卸载。$MC_COMMANDER_DIR 下已没有实例或备份数据，无需另外备份。"
        log "残留的只有程序文件与配置，可手动删除：sudo rm -rf $MC_COMMANDER_DIR"
      fi
    fi
  fi

  # 4. 按安装清单回滚系统改动。
  #
  # 只动清单里记过的条目：用户机器原有的 Java/Node 不能碰（他别的程序要用），
  # 本项目没加过的东西也不能碰。没有清单时退化为「只做确定安全的那几项」。
  if [ -n "$manifest_lines" ]; then
    log "回滚安装时记录的系统改动..."

    # 4a. 防火墙：只撤本项目加的那条规则
    # 清单在面板可写目录内，值会被拼进本脚本的 root 命令：只接受 1-65535 的端口号，
    # 其余一律跳过（端口段不是数字时那些命令也撤不掉任何真规则）
    while IFS=$'\t' read -r key value; do
      case "$key" in
        firewall-ufw|firewall-firewalld|firewall-iptables)
          if ! [[ "$value" =~ ^[0-9]{1,5}$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
            warn "  忽略非法防火墙端口：${value:0:40}"
            continue
          fi
          ;;
      esac
      case "$key" in
        firewall-ufw)
          if command -v ufw &>/dev/null; then
            ufw delete allow "$value"/tcp >/dev/null 2>&1 && log "  已撤销 ufw 规则 $value/tcp"
          fi
          ;;
        firewall-firewalld)
          if command -v firewall-cmd &>/dev/null; then
            firewall-cmd --permanent --remove-port="$value"/tcp >/dev/null 2>&1
            firewall-cmd --reload >/dev/null 2>&1
            log "  已撤销 firewalld 规则 $value/tcp"
          fi
          ;;
        firewall-iptables)
          if command -v iptables &>/dev/null; then
            iptables -D INPUT -p tcp --dport "$value" -j ACCEPT >/dev/null 2>&1 &&
              log "  已撤销 iptables 规则 $value/tcp"
          fi
          ;;
      esac
    done <<< "$manifest_lines"

    # 4b. 系统包：只卸「装之前不存在」的那些
    # 清单在面板可写的安装目录内，包名拼成字符串再裸展开，一个空格就多出一个包管理器参数
    local pkgs=()
    while IFS=$'\t' read -r key value; do
      [ "$key" = "pkg-installed" ] || continue
      # 以 - 开头的值会被当成选项，-o DPkg::Pre-Invoke::=<命令> 足以在本脚本的 root 权限下执行任意命令
      if [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9+._-]*$ ]]; then
        pkgs+=("$value")
      else
        # 截断再回显：清单可被写坏，原样回显一个超长值会把终端刷屏
        warn "  忽略非法包名：${value:0:40}"
      fi
    done <<< "$manifest_lines"
    # 按命令探测而不是读 $PKG_MANAGER：卸载在安装流程之前分派，那时该变量还没赋值，
    # 依赖它会让这一段恒不执行——脚本报「已卸载」而系统包全在
    if [ "${#pkgs[@]}" -gt 0 ]; then
      log "  卸载安装时新增的系统包：${pkgs[*]}"
      if command -v apt-get &>/dev/null; then
        apt-get remove -y --purge "${pkgs[@]}" >/dev/null 2>&1 ||
          warn "  部分系统包卸载失败，可手动处理：apt-get remove --purge ${pkgs[*]}"
      elif command -v dnf &>/dev/null; then
        dnf remove -y "${pkgs[@]}" >/dev/null 2>&1 ||
          warn "  部分系统包卸载失败，可手动处理：dnf remove ${pkgs[*]}"
      elif command -v yum &>/dev/null; then
        yum remove -y "${pkgs[@]}" >/dev/null 2>&1 ||
          warn "  部分系统包卸载失败，可手动处理：yum remove ${pkgs[*]}"
      elif command -v apk &>/dev/null; then
        apk del "${pkgs[@]}" >/dev/null 2>&1 ||
          warn "  部分系统包卸载失败，可手动处理：apk del ${pkgs[*]}"
      fi
    fi

    # 4c. 软件源与密钥文件：安装时新增的 corretto 源不在卸载后清理，会一直留在
    # apt/yum 的源列表里；清单可被写坏，故只认这几个目录下的源文件
    while IFS=$'\t' read -r key value; do
      [ "$key" = "repo-file" ] || continue
      if repo_file_allowed "$value"; then
        [ -f "$value" ] && rm -f "$value" && log "  已移除软件源文件 ${value##*/}"
      else
        warn "  忽略清单外路径的软件源记录：${value:0:60}"
      fi
    done <<< "$manifest_lines"

    # 4d. Node 软链：只在它们指向本项目装的 /opt/node-* 时才删
    while IFS=$'\t' read -r key value; do
      if [ "$key" = "node-symlink" ]; then
        local target
        target=$(readlink -f "$value" 2>/dev/null || true)
        case "$target" in
          /opt/node-*)
            rm -f "$value" && log "  已移除软链 $value"
            ;;
        esac
      fi
    done <<< "$manifest_lines"
  elif [ "$purge" -eq 1 ]; then
    warn "未找到安装清单，跳过系统包与防火墙回滚（无法判断哪些是本项目装的）"
  fi

  # 5. 收尾校验：逐项确认真的清干净了，不说「卸载完成」了事
  local leftover=""
  [ -f /etc/systemd/system/mc-commander.service ] && leftover="$leftover"$'\n'"  - systemd 单元仍在"
  id -u mc-commander &>/dev/null && leftover="$leftover"$'\n'"  - 用户 mc-commander 仍在"
  [ "$purge" -eq 1 ] && [ -d "$MC_COMMANDER_DIR" ] && leftover="$leftover"$'\n'"  - 安装目录仍在"

  echo ""
  if [ -n "$leftover" ]; then
    warn "卸载完成，但以下项目未能自动清理："
    echo "$leftover"
    warn "请按上面的提示手动处理后再确认卸载干净。"
  else
    log "卸载完成，系统已无本项目残留。"
  fi
  return 0
}

# 子命令分派：必须在任何安装动作之前，卸载流程不该触发 apt/npm/下载
if [ "${1:-}" = "--uninstall" ]; then
  do_uninstall "$@"
  exit $?
fi
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  uninstall_usage
  exit 0
fi

# 0. root 权限检查（systemd 注册需要）
if [ "$(id -u)" -ne 0 ]; then
  warn "当前不是 root 用户，将跳过 systemd 服务注册。"
  warn "如需注册系统服务（推荐），请使用 sudo 重新运行此脚本。"
  SKIP_SYSTEMD=1
else
  SKIP_SYSTEMD=0
fi

# 1. 检测系统包管理器
log "检测系统环境..."
if command -v apt-get &>/dev/null; then
  PKG_MANAGER="apt"
elif command -v yum &>/dev/null; then
  PKG_MANAGER="yum"
elif command -v apk &>/dev/null; then
  PKG_MANAGER="apk"
elif command -v dnf &>/dev/null; then
  PKG_MANAGER="dnf"
else
  err "不支持的系统包管理器，请手动安装 Java 17/21/25 和 Node.js 22+ 后重试。"
  exit 1
fi
log "系统包管理器: $PKG_MANAGER"

# 包管理器更新（确保软件包索引是最新的）。失败只警告：已装的包不需要索引，
# 真装不上时随后的 install 会失败并给出更准确的解释；这里中止等于把
# 「源暂时不可达」放大成「装不了」
case "$PKG_MANAGER" in
  apt) apt-get update || warn "软件包索引更新失败，继续尝试安装（已安装的包不受影响）" ;;
  yum) yum makecache || warn "软件包索引更新失败，继续尝试安装" ;;
  dnf) dnf makecache || warn "软件包索引更新失败，继续尝试安装" ;;
esac

install_pkg() {
  case "$PKG_MANAGER" in
    apt) apt-get install -y "$@" ;;
    yum) yum install -y "$@" ;;
    apk) apk add --no-cache "$@" ;;
    dnf) dnf install -y "$@" ;;
  esac
}

# 带「停滞检测 + 断点续传」的下载：跨境/弱网链路上，连接建立后可能长时间零字节
# （实测本机到 GitHub：ESTAB 但 2.5 分钟无增长，且不会自行失败）。
# --connect-timeout 只约束建连阶段，救不了这种挂起，故必须叠加：
#   --speed-limit/--speed-time  60s 内均速低于 1KB/s 即中止（比 --max-time 精准，不误杀慢但活着的下载）
#   -C -                        保留已下载字节续传，避免每次重试都从 0 开始
#   --retry-all-errors          让「读中断」也计入重试（默认只重试部分错误）
# 返回非 0 表示耗尽重试仍失败。
DOWNLOAD_RETRIES="${DOWNLOAD_RETRIES:-5}"
download_with_resume() {
  local url="$1" out="$2" label="${3:-文件}" i=0
  for i in $(seq 1 "$DOWNLOAD_RETRIES"); do
    if curl -fSL -C - \
        --connect-timeout 15 --retry 2 --retry-all-errors \
        --speed-limit 1024 --speed-time 60 \
        --progress-bar \
        -o "$out" "$url"; then
      echo "" # 进度条不换行，补一个
      return 0
    fi
    if [ "$i" -lt "$DOWNLOAD_RETRIES" ]; then
      local have=0
      [ -f "$out" ] && have=$(stat -c %s "$out" 2>/dev/null || echo 0)
      warn "$label 下载中断，1 秒后从 $((have / 1024)) KB 处续传（第 $((i + 1))/$DOWNLOAD_RETRIES 次）"
      sleep 1
    fi
  done
  return 1
}

# 公网 IP 探测：优先国内服务，其次国外，最后云厂商元数据。
# 全部失败则从本地网卡筛非私有地址，仍无则返回空串。
#
# 只探测一次并复用（写进 .env 的 PUBLIC_IP + 完成横幅共用同一个值）：
# 服务端原本自己再探一遍，且用的源与这里不同 ⇒ 同一台机器两个组件可能给出
# **互相矛盾**的公网 IP（多网卡或出口 NAT 池时必然如此）。
# 写进 .env 后服务端优先读它（mc_server.js 的 PUBLIC_IP 分支），不确定性消失。
get_public_ip() {
  local ip=""
  # 先问云厂商：元数据里的 public-ipv4 是**入站地址**（别人怎么连进来），
  # 而出口探测拿到的是**出站地址**（我从哪个 IP 出去）——NAT 出口池下两者不等，
  # 实测同一台机器出口探测在 4 个 IP 间轮换、全部入站不可达。故权威源必须排在前面。
  ip=$(curl -sf --connect-timeout 2 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null) || ip=""
  [ -n "$ip" ] && echo "$ip metadata" && return
  ip=$(curl -sf --connect-timeout 2 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null) || ip=""
  [ -n "$ip" ] && echo "$ip metadata" && return
  # 元数据为空说明这台机器没有弹性公网 IP：下面的出口探测只能给出「我从哪出去」，
  # 那是出站地址，入站通常不可达。故标记为 egress，横幅据此说清而不是当成面板地址。
  ip=$(curl -sf --connect-timeout 3 https://myip.ipip.net 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip egress" && return
  ip=$(curl -sf --connect-timeout 3 https://ip.sb 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip egress" && return
  ip=$(curl -sf --connect-timeout 3 https://ifconfig.me 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip egress" && return
  ip=$(curl -sf --connect-timeout 3 https://icanhazip.com 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip egress" && return
  ip=$(curl -sf --connect-timeout 3 https://api.ipify.org 2>/dev/null) || ip=""
  [ -n "$ip" ] && echo "$ip egress" && return
  ip=$(curl -sf --connect-timeout 3 https://ident.me 2>/dev/null) || ip=""
  [ -n "$ip" ] && echo "$ip egress" && return
  # 从本地网卡 IP 中筛选：逐个排除私网/保留段，取第一个公网 IP
  # （判据与 is_private_ip 同源，不再内联第二份排除正则）
  local candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if ! is_private_ip "$candidate"; then
      echo "$candidate nic"
      return
    fi
  done < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$')
  echo ""
}

# 是否为私网/保留 IPv4（与服务端 utils/url-guard.js 的 PRIVATE_IPV4_RANGES **逐段对应**）。
#
# 为什么不能各写一份：这里与服务端判的是同一件事（「这个地址能不能发给玩家」），
# 而两侧曾各写一份正则——脚本这份漏了 100.64.0.0/10(CGNAT)、198.18.0.0/15、
# 192.0.0.0/24、192.88.99.0/24 与三段 TEST-NET ⇒ 实测 100.64.0.1 在脚本侧被判为「公网」，
# 写进 .env 后面板按 public 展示，CGNAT 出口下的用户看不到「内网地址」警示。
#
# 段表（两侧必须一致，security.deploy.test.js 有比对守卫）：
#   0/8  10/8  100.64/10  127/8  169.254/16  172.16/12  192.0.0/24
#   192.0.2/24  192.88.99/24  192.168/16  198.18/15  198.51.100/24
#   203.0.113/24  224/3（组播+保留）
PRIVATE_IPV4_RE='^(0\.|10\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.0\.0\.|192\.0\.2\.|192\.88\.99\.|192\.168\.|198\.1[89]\.|198\.51\.100\.|203\.0\.113\.|2(2[4-9]|[3-9][0-9])\.)'
is_private_ip() {
  echo "$1" | grep -qE "$PRIVATE_IPV4_RE"
}

# 2. 安装基础工具（curl、tar、rsync、openssl）
# rsync 为备份功能依赖（目录快照 + --link-dest 硬链接增量，缺失时备份降级失败）
# openssl 为内置 HTTPS 依赖（面板启动时自签 CA 与服务端证书）：多数发行版已预装，
# 缺它时面板仍能起、只是没有 HTTPS，故这里装不上也只告警不中止
for tool in curl tar rsync openssl; do
  if ! command -v "$tool" &>/dev/null; then
    log "安装 $tool..."
    install_pkg_recorded "$tool" || warn "$tool 安装失败，相关功能将不可用"
  fi
done

# 3. 安装多版本 Java（17/21/25）以兼容不同 MC 版本
# Java 17 → MC 1.17 - 1.20.4
# Java 21 → MC 1.20.5 - 1.21.11
# Java 25 → MC 26.1+（新版本格式）
# 1.16.5 及以下需 Java 8（极少用户使用，按需在客户端提示手动安装）
# 部署时由 java-detector.js 按 MC 版本自动选择启动路径

# 检测已安装的 Java 主版本号（无 java 命令时返回 0）
get_installed_java_major() {
  if ! command -v java &>/dev/null; then
    echo 0
    return
  fi
  java -version 2>&1 | head -1 | sed 's/[^0-9.]//g' | cut -d. -f1 | grep -E '^[0-9]+$' || echo 0
}

# 判断指定主版本号是否已存在（在 PATH 或 /usr/lib/jvm 下）
java_major_exists() {
  local want="$1"
  # 优先看 /usr/lib/jvm 下的目录（更可靠，避免 PATH 指向单一版本）
  if ls -d /usr/lib/jvm/java-${want}-* 2>/dev/null | grep -q .; then
    return 0
  fi
  if ls -d /usr/lib/jvm/jdk-${want}* 2>/dev/null | grep -q .; then
    return 0
  fi
  return 1
}

# 配置 Amazon Corretto 仓库（Java 25 在部分发行版官方源不存在）
# 源配置与密钥都记进安装清单：它们落在 /etc 与 /usr/share，卸载时不在安装目录里，
# 不记就永远留在用户机器上（源仍可被 apt/yum 读到，密钥仍被信任）。
setup_corretto_repo() {
  case "$PKG_MANAGER" in
    apt)
      if [ ! -f /usr/share/keyrings/corretto-keyring.gpg ]; then
        log "添加 Amazon Corretto 仓库..."
        # 仓库配置失败不该拖垮整个安装：Java 25 只影响 MC 26.x，面板本身不依赖它
        if ! wget -qO- https://apt.corretto.aws/corretto.key | gpg --dearmor -o /usr/share/keyrings/corretto-keyring.gpg; then
          warn "Corretto 仓库密钥获取失败，跳过 Java 25 安装"
          return 1
        fi
        record_change "repo-file" "/usr/share/keyrings/corretto-keyring.gpg"
        echo "deb [signed-by=/usr/share/keyrings/corretto-keyring.gpg] https://apt.corretto.aws stable main" > /etc/apt/sources.list.d/corretto.list
        record_change "repo-file" "/etc/apt/sources.list.d/corretto.list"
        apt-get update || true
      fi
      ;;
    yum|dnf)
      if [ ! -f /etc/yum.repos.d/corretto.repo ]; then
        log "添加 Amazon Corretto 仓库..."
        curl -fsSL https://yum.corretto.aws/corretto.repo -o /etc/yum.repos.d/corretto.repo
        record_change "repo-file" "/etc/yum.repos.d/corretto.repo"
      fi
      ;;
  esac
}

install_java() {
  local need_17=0 need_21=0 need_25=0
  # 装不上时置 1：缺 Java 25 只影响 MC 26.x，面板照常可用，故不中断安装
  JAVA25_MISSING=0
  java_major_exists 17 || need_17=1
  java_major_exists 21 || need_21=1
  java_major_exists 25 || need_25=1

  # 三版本都已存在，跳过
  if [ "$need_17" -eq 0 ] && [ "$need_21" -eq 0 ] && [ "$need_25" -eq 0 ]; then
    log "Java 17/21/25 均已安装，跳过"
    return
  fi

  case "$PKG_MANAGER" in
    apt)
      # Java 17 / 21 优先使用发行版自带 openjdk
      local pkgs=()
      [ "$need_17" -eq 1 ] && pkgs+=(openjdk-17-jre-headless)
      [ "$need_21" -eq 1 ] && pkgs+=(openjdk-21-jre-headless)
      if [ "${#pkgs[@]}" -gt 0 ]; then
        log "安装 OpenJDK: ${pkgs[*]}"
        install_pkg_recorded "${pkgs[@]}" || warn "OpenJDK 安装失败（部分发行版可能缺少对应版本），将尝试 Amazon Corretto"
      fi
      # Java 25 使用 Amazon Corretto JDK（Corretto 仓库不提供 JRE-headless 变体，
      # 且 PaperMC 官方建议不使用 headless 变体以避免缺少 GUI 依赖）
      if [ "$need_25" -eq 1 ]; then
        if setup_corretto_repo; then
          install_pkg_recorded java-25-amazon-corretto-jdk || JAVA25_MISSING=1
        else
          JAVA25_MISSING=1
        fi
      fi
      ;;
    yum|dnf)
      local pkgs=()
      [ "$need_17" -eq 1 ] && pkgs+=(java-17-openjdk-headless)
      [ "$need_21" -eq 1 ] && pkgs+=(java-21-openjdk-headless)
      if [ "${#pkgs[@]}" -gt 0 ]; then
        log "安装 OpenJDK: ${pkgs[*]}"
        install_pkg_recorded "${pkgs[@]}" || warn "OpenJDK 安装失败，将尝试 Amazon Corretto"
      fi
      if [ "$need_25" -eq 1 ]; then
        if setup_corretto_repo; then
          install_pkg_recorded java-25-amazon-corretto-devel || JAVA25_MISSING=1
        else
          JAVA25_MISSING=1
        fi
      fi
      ;;
    apk)
      # Alpine 官方源已提供 openjdk17/21/25
      local pkgs=()
      [ "$need_17" -eq 1 ] && pkgs+=(openjdk17-jre-headless)
      [ "$need_21" -eq 1 ] && pkgs+=(openjdk21-jre-headless)
      [ "$need_25" -eq 1 ] && pkgs+=(openjdk25-jre-headless)
      if [ "${#pkgs[@]}" -gt 0 ]; then
        log "安装 OpenJDK: ${pkgs[*]}"
        install_pkg_recorded "${pkgs[@]}"
      fi
      ;;
  esac

  if [ "$JAVA25_MISSING" -eq 1 ]; then
    warn "Java 25 未能安装：面板可以正常使用，但 MC 26.x 及更新版本的实例将无法启动"
  fi
  # 打印已安装 Java 列表（便于排查）
  log "已安装 Java 版本："
  for v in 17 21 25; do
    if java_major_exists "$v"; then
      local p=$(ls -d /usr/lib/jvm/java-${v}-* 2>/dev/null | head -1)
      [ -z "$p" ] && p=$(ls -d /usr/lib/jvm/jdk-${v}* 2>/dev/null | head -1)
      log "  Java $v → ${p:-PATH}"
    fi
  done
}
log "检查并安装 Java 17/21/25（覆盖 MC 1.17+ 所有版本）..."
install_java

# 4. 安装 Node.js 22+
# 安全策略：不使用第三方 nodesource 的 curl|bash 引导脚本（root 直接执行未校验代码风险高）。
# 优先使用发行版官方源安装；若发行版源版本不足 22，改用 Node.js 官方二进制 tarball，
# 下载前先取官方 SHASUMS256.txt，对包做 sha256 强校验后再解压。
NODE_REQUIRED_MAJOR=22
# 固定官方 LTS 版本号（可用 NODE_VERSION 环境变量覆盖，须为 https://nodejs.org/dist/ 下真实存在的版本）
NODE_VERSION="${NODE_VERSION:-v22.23.2}"

# 从 nodejs.org 下载官方二进制包并做 sha256 校验（兜底方案，发行版源版本过旧时使用）
install_node_official() {
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      err "不支持的 CPU 架构: $(uname -m)，无法通过官方二进制包安装 Node.js"
      err "请手动安装 Node.js 22+ 后重试"
      exit 1
      ;;
  esac
  if ! command -v sha256sum &>/dev/null; then
    install_pkg_recorded coreutils
  fi
  local base="https://nodejs.org/dist/${NODE_VERSION}"
  local file="node-${NODE_VERSION}-linux-${arch}.tar.xz"
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  log "下载 Node.js 官方二进制包 ${NODE_VERSION} (linux-${arch})..."
  # 先取官方校验文件（与包同目录、同通道）
  if ! download_with_resume "$base/SHASUMS256.txt" "$tmp_dir/SHASUMS256.txt" "Node.js 官方校验文件"; then
    err "无法获取 Node.js 官方校验文件（SHASUMS256.txt），已中止安装"
    rm -rf "$tmp_dir"
    exit 1
  fi
  local expected actual
  expected=$(awk -v f="$file" '$2 == f {print $1}' "$tmp_dir/SHASUMS256.txt")
  if [ -z "$expected" ]; then
    err "SHASUMS256.txt 中未找到 ${file} 的校验值，已中止安装"
    rm -rf "$tmp_dir"
    exit 1
  fi
  if ! download_with_resume "$base/$file" "$tmp_dir/$file" "Node.js 二进制包"; then
    err "Node.js 二进制包下载失败，已中止安装"
    rm -rf "$tmp_dir"
    exit 1
  fi
  # 强校验：sha256 必须与官方 SHASUMS256.txt 一致
  actual=$(sha256sum "$tmp_dir/$file" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    err "Node.js 二进制包 sha256 校验失败（预期 $expected，实际 $actual）"
    err "下载文件可能被篡改或损坏，已中止安装"
    rm -rf "$tmp_dir"
    exit 1
  fi
  log "Node.js 二进制包 sha256 校验通过"
  # 解压到 /opt 并建立软链（不污染 /usr/local 原有内容）
  tar -xJf "$tmp_dir/$file" -C /opt
  # 只在 /usr/local/bin 原本没有同名命令时建链：覆盖用户已有的 node 会把他的环境改坏，
  # 且卸载时无从判断这条链该不该删
  for bin in node npm npx; do
    if [ ! -e "/usr/local/bin/$bin" ]; then
      ln -sfn "/opt/node-${NODE_VERSION}-linux-${arch}/bin/$bin" "/usr/local/bin/$bin"
      record_change "node-symlink" "/usr/local/bin/$bin"
    fi
  done
  rm -rf "$tmp_dir"
  log "Node.js ${NODE_VERSION} 安装完成: $(node -v)"
}

# 确保 Node.js 主版本 >= 22：优先发行版官方源，不足则走官方二进制包（含 sha256 校验）
ensure_node() {
  local cur=0
  if command -v node &>/dev/null; then
    cur=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$cur" -ge "$NODE_REQUIRED_MAJOR" ]; then
      log "Node.js $cur 已安装，跳过"
      return 0
    fi
    log "Node.js 版本过低 ($cur)，升级到 $NODE_REQUIRED_MAJOR+..."
  fi
  case "$PKG_MANAGER" in
    apt)
      # 先尝试发行版官方源（apt 安装 nodejs/npm，不引入第三方源）
      install_pkg_recorded nodejs npm >/dev/null 2>&1 || true
      local apt_ver=0
      if command -v node &>/dev/null; then
        apt_ver=$(node -v | sed 's/v//' | cut -d. -f1)
      fi
      if [ "$apt_ver" -ge "$NODE_REQUIRED_MAJOR" ]; then
        log "Node.js $apt_ver 已通过发行版官方源安装"
        return 0
      fi
      warn "发行版官方源 Node.js 版本不足 ($apt_ver)，改用官方二进制包（带 sha256 校验）"
      install_node_official
      ;;
    *)
      # yum/dnf/apk 直接使用发行版官方源安装
      install_pkg_recorded nodejs npm
      ;;
  esac
  # 最终确认版本达标，未达标直接失败（避免后续在错误版本上运行）
  local final_ver=0
  if command -v node &>/dev/null; then
    final_ver=$(node -v | sed 's/v//' | cut -d. -f1)
  fi
  if [ "$final_ver" -lt "$NODE_REQUIRED_MAJOR" ]; then
    err "Node.js 安装失败或版本仍不足 $NODE_REQUIRED_MAJOR（当前: ${final_ver:-未安装}）"
    exit 1
  fi
  log "Node.js 版本检查通过: $(node -v)"
}
ensure_node

# 5. 创建安装目录
log "创建安装目录: $MC_COMMANDER_DIR"
mkdir -p "$MC_COMMANDER_DIR/var"/{servers,data,backups}

# 安装目录就绪：把装包阶段暂存的痕迹并入清单。
# 清单文件本身必须创建，哪怕这次没有新增条目——「有清单但为空」与「没有清单」
# 对卸载是不同的信号：前者可确定无需回滚，后者只能保守跳过并提示用户。
if [ -s "$MANIFEST_STAGING" ]; then
  cat "$MANIFEST_STAGING" >> "$MANIFEST"
  rm -f "$MANIFEST_STAGING"
fi
touch "$MANIFEST"

# 5.5 校验实例目录与备份目录同文件系统：rsync --link-dest 硬链接要求
# link() 同设备（跨文件系统返回 EXDEV，退化为全量复制——磁盘节省失效、
# 耗时增加）。仅告警不阻断（退化为复制仍可用，只是非最优）
if command -v stat &>/dev/null; then
  SRC_DEV=$(stat -c %d "$MC_COMMANDER_DIR/var/servers" 2>/dev/null || echo "")
  BAK_DEV=$(stat -c %d "$MC_COMMANDER_DIR/var/backups" 2>/dev/null || echo "")
  if [ -n "$SRC_DEV" ] && [ -n "$BAK_DEV" ] && [ "$SRC_DEV" != "$BAK_DEV" ]; then
    warn "var/servers/ 与 var/backups/ 位于不同文件系统（设备号 $SRC_DEV vs $BAK_DEV）"
    warn "备份的 rsync --link-dest 硬链接增量将退化为全量复制（磁盘占用大、耗时增加）"
    warn "建议将 var/backups 与 var/servers 放置在同一磁盘分区"
  fi
fi

cd "$MC_COMMANDER_DIR"

# 5.6 探测公网 IP 并缓存（供 .env 与完成横幅共用，见 get_public_ip 头注释）
# 放在 .env 生成之前：写进 .env 的 PUBLIC_IP 是服务端的**首选**来源，
# 不写它，服务端就要自己异步探测（探测期间顶栏会退回显示局域网 IP——
# 而那是玩家连不上的地址，用户会照着复制发给朋友）。整体超时上限随探测链，
# 各源 --connect-timeout 3s、最多 8 个源，最坏约 20s，仅首次部署时发生。
log "探测服务器地址..."
# get_public_ip 回显「地址 来源」：来源决定这个地址能不能当面板地址用
read -r PUBLIC_IP_DETECTED PUBLIC_IP_SOURCE <<<"$(get_public_ip)"
PUBLIC_IP_SOURCE="${PUBLIC_IP_SOURCE:-none}"
case "$PUBLIC_IP_SOURCE" in
  metadata)
    log "服务器公网地址: $PUBLIC_IP_DETECTED（云厂商元数据，已写入 .env 的 PUBLIC_IP）"
    ;;
  nic)
    log "服务器网卡地址: $PUBLIC_IP_DETECTED（本机网卡，已写入 .env 的 PUBLIC_IP）"
    ;;
  egress)
    warn "本机没有弹性公网 IP，探测到的 $PUBLIC_IP_DETECTED 只是出口地址（入站多半连不上）"
    warn "不写入 .env 的 PUBLIC_IP；面板将按本机地址展示"
    PUBLIC_IP_DETECTED=""
    ;;
  *)
    warn "未能探测到服务器地址；面板将按局域网地址展示，可在 .env 里手动设 PUBLIC_IP"
    ;;
esac

# 6. 下载后端代码
# SKIP_DOWNLOAD=1：跳过下载、直接用安装目录里已有的代码（需 package.json + src/index.js）。
# 这是报错提示里承诺的出路——「手动放好代码再跑」必须真的能生效，
# 否则弱网用户下载反复失败后就没有任何自救手段。
SKIP_DOWNLOAD="${SKIP_DOWNLOAD:-0}"
cd "$MC_COMMANDER_DIR"

if [ "$SKIP_DOWNLOAD" = "1" ]; then
  if [ -f "$MC_COMMANDER_DIR/package.json" ] && [ -f "$MC_COMMANDER_DIR/src/index.js" ]; then
    log "SKIP_DOWNLOAD=1 且已检测到代码（package.json + src/index.js），跳过下载"
  else
    err "SKIP_DOWNLOAD=1 但 $MC_COMMANDER_DIR 下没有可用的代码（缺 package.json 或 src/index.js）"
    err "请先把后端代码解压到该目录，或在无 SKIP_DOWNLOAD 的情况下重新运行以走正常下载"
    exit 1
  fi
else
log "下载 MC_Commander 后端代码（VERSION=$VERSION）..."
TMP_TGZ="$MC_COMMANDER_DIR/.tmp_package.tar.gz"
TMP_SUMS="$MC_COMMANDER_DIR/.tmp_SHA256SUMS.txt"
TMP_EXTRACT="$MC_COMMANDER_DIR/.tmp_extract"
rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
mkdir -p "$TMP_EXTRACT"

# 自动选路（仅默认源时）：默认首选 Gitee（用户实际链路在国内），不可用则回 GitHub 权威源。
# 探测先于下载的理由：跨境链路的失败形态是「TCP 已建连但零字节」，直接进下载函数
# 要等满 60s 停滞检测才放弃；而探测实测 10s 内即超时，用户少等一分钟。
# 用户显式设过 PACKAGE_URL 时不介入（那是明确指定，尊重用户意图）。
if [ "$CUSTOM_PACKAGE_URL" -eq 0 ]; then
  if [ "$SOURCE_PREFERENCE" = "gitee" ]; then
    if use_gitee; then
      :
    elif [ "$ALLOW_SOURCE_FALLBACK" = "1" ] && source_reachable "$PACKAGE_URL"; then
      log "Gitee 源不可用，已回退 GitHub 权威源：$PACKAGE_URL"
    else
      warn "Gitee 源不可用且未启用换源，仍按 Gitee 重试"
    fi
  elif source_reachable "$PACKAGE_URL"; then
    log "GitHub 源可达，使用：$PACKAGE_URL"
  elif [ "$ALLOW_SOURCE_FALLBACK" = "1" ] && use_gitee; then
    log "GitHub 源探测超时（${PROBE_TIMEOUT}s 内未收到数据），已自动改用 Gitee 镜像"
  else
    warn "GitHub 源探测超时且未启用换源，仍按 GitHub 重试"
  fi
fi

# 下载 tar.gz（-f 失败即退出，-L 跟随重定向；停滞检测与续传见 download_with_resume）
# 用显式标志记录成败，而非事后看文件是否存在：失败会留下非空的半截文件，
# 「文件存在且非空」会把一次失败读成成功，报错文案随即被跳过（现象是用户只看到
# 后续的魔术字节/摘要错误，而真正原因「下载失败」从未打印）。
PKG_DOWNLOAD_OK=1
if ! download_with_resume "$PACKAGE_URL" "$TMP_TGZ" "代码包"; then
  # 兜底：探测说 GitHub 通、实际下载仍失败（探测只读 1 字节，之后可能才劣化）。
  # 切换源前必须删除半截文件——续传靠 -C -，而两个源的字节拼接会产出损坏的包
  # （且魔术字节检查未必能发现，因为 gzip 头来自第一个源）。
  if [ "$CUSTOM_PACKAGE_URL" -eq 0 ] && [ "$ALLOW_SOURCE_FALLBACK" = "1" ] && [ "$SOURCE" = "Gitee" ]; then
    warn "Gitee 源下载失败，改用 GitHub 权威源重试"
    rm -f "$TMP_TGZ"
    if use_github && download_with_resume "$PACKAGE_URL" "$TMP_TGZ" "代码包（GitHub）"; then
      log "已通过 GitHub 权威源获取代码包"
      PKG_DOWNLOAD_OK=0
    fi
  fi
else
  PKG_DOWNLOAD_OK=0
fi
if [ "$PKG_DOWNLOAD_OK" -ne 0 ]; then
  err "代码包下载失败：$PACKAGE_URL"
  # 判据必须是「用户是否显式设过 PACKAGE_URL」——不能用 `[ -n "$PACKAGE_URL" ]`：
  # 上面的默认值赋值会让它恒非空，使 VERSION=<tag> 那条真正有用的提示变成死代码
  # （实测：默认安装失败时，用户被告知「自定义 PACKAGE_URL 下载失败」，而他从没设过）
  if [ "$VERSION" = "latest" ]; then
    if [ "$CUSTOM_PACKAGE_URL" -eq 1 ]; then
      # 自定义 PACKAGE_URL 时，latest 那套提示会文不对题，先排除这条
      err "自定义 PACKAGE_URL 下载失败；未设置 SHA256SUMS_URL 时也无从校验完整性。"
      err "请确认 PACKAGE_URL 可达，并一并设置指向同一 Release 的 SHA256SUMS_URL"
    else
      err "从发布版下载代码包失败（已重试续传，并已在 GitHub 与 Gitee 两个源上尝试）。"
      err "可能原因：本机到两个源的网络都不通，或该版本尚无 $ASSET_NAME 产物。"
      err "可按顺序尝试："
      err "  1) 重跑本脚本（已下载的部分会续传，不必从 0 开始）"
      # 变量必须写在 sudo 之后：`VERSION=x sudo cmd` 只给 sudo 自己设了变量，
      # sudo 默认 env_reset 会丢掉它，脚本仍按 latest 跑（静默不生效）
      err "  2) 显式指定版本：  sudo VERSION=v0.6.0 bash deploy-mc-commander.sh"
      err "  3) 自行下载 $ASSET_NAME 并解压到 $MC_COMMANDER_DIR，然后："
      err "     sudo SKIP_DOWNLOAD=1 bash deploy-mc-commander.sh"
    fi
  else
    err "请检查版本号 $VERSION 是否已发布且含产物，或手动指定 PACKAGE_URL 环境变量"
    err "也可以自行下载并解压到 $MC_COMMANDER_DIR 后，用 SKIP_DOWNLOAD=1 重跑"
  fi
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
fi
# 校验文件类型：tar.gz (gzip) 魔术字节为 1f 8b
GZ_MAGIC=$(head -c 2 "$TMP_TGZ" 2>/dev/null | od -An -tx1 | tr -d ' \n')
if [ "$GZ_MAGIC" != "1f8b" ]; then
  err "下载的文件不是有效的 tar.gz 包（魔术字节: ${GZ_MAGIC:-空}）"
  err "可能是网络错误或文件不存在，请检查 URL："
  err "  $PACKAGE_URL"
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
fi
# 完整性校验：取同一 Release 的 SHA256SUMS.txt，按其中登记的值比对下载文件。
# 摘要与资产同源同 Release，Release 又已开 Immutable Releases，故这一对值不可被单方面替换。
# 校验失败立即中止并清理临时文件（fail-closed，绝不执行未经验证的代码）
if ! command -v sha256sum &>/dev/null; then
  install_pkg_recorded coreutils
fi
if ! download_with_resume "$SHA256SUMS_URL" "$TMP_SUMS" "摘要文件"; then
  # 摘要单独失败时也试另一个源：摘要只是校验输入，下面的 sha256 比对是 fail-closed 的，
  # 故跨源取摘要不会降低安全性（对不上就中止），但能救「包下完了、摘要恰好没下来」。
  SUMS_OK=1
  if [ "$CUSTOM_PACKAGE_URL" -eq 0 ] && [ "$ALLOW_SOURCE_FALLBACK" = "1" ] && [ "$SOURCE" = "Gitee" ]; then
    warn "Gitee 摘要文件下载失败，改用 GitHub 权威源重试"
    rm -f "$TMP_SUMS"
    if use_github && download_with_resume "$SHA256SUMS_URL" "$TMP_SUMS" "摘要文件（GitHub）"; then
      SUMS_OK=0
    fi
  fi
  if [ "$SUMS_OK" -ne 0 ]; then
    err "SHA256SUMS.txt 下载失败：$SHA256SUMS_URL"
    err "自定义 PACKAGE_URL 时请同时设置 SHA256SUMS_URL，否则无从校验完整性"
    rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
    exit 1
  fi
fi
# 摘要文件由 `sha256sum <file>` 生成，行格式为「<hash>  <文件名>」；
# 也可能带二进制模式前缀 `*`。按下载地址的 basename 找条目，自定义 URL 同样适用
PKG_BASENAME=$(basename "$PACKAGE_URL")
EXPECTED_SHA256=$(awk -v f="$PKG_BASENAME" '$2 == f || $2 == "*" f {print $1; exit}' "$TMP_SUMS")
if [ -z "$EXPECTED_SHA256" ]; then
  err "SHA256SUMS.txt 中未找到 $PKG_BASENAME 的摘要条目：$SHA256SUMS_URL"
  err "该 Release 的产物名与本脚本预期不一致，或摘要文件与代码包不是同一 Release"
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
fi
ACTUAL_SHA256=$(sha256sum "$TMP_TGZ" | awk '{print $1}')
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  err "代码包 sha256 校验失败！"
  err "  预期（$SHA256SUMS_URL）: $EXPECTED_SHA256"
  err "  实际（$PACKAGE_URL）: $ACTUAL_SHA256"
  err "下载文件可能已被篡改，或代码包与摘要不是同一 Release 的产物"
  err "已中止安装并删除临时文件。排查建议："
  err "  1. 重新运行脚本（latest 会取到最新发布版，可能已修正）"
  err "  2. 自定义 PACKAGE_URL 安装时，请确认 PACKAGE_URL 与 SHA256SUMS_URL 指向同一 Release"
  err "  3. 仍无法解决时，请先人工核实下载内容来源"
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
fi
log "代码包 sha256 校验通过"
# 解压到临时目录
if ! tar -xzf "$TMP_TGZ" -C "$TMP_EXTRACT"; then
  err "解压失败，tar.gz 文件可能已损坏"
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
fi
# 验证解压结果：必须存在 package.json（后端入口标识）
# 契约包产物：服务端运行时经依赖解析消费 mc-schemas/dist/index.js（main 字段）。
# 缺了它安装照样「成功」，要到启动才崩——故在解包阶段就 fail-closed。
if [ ! -f "$TMP_EXTRACT/mc-schemas/dist/index.js" ]; then
  err "解压后未找到 mc-schemas/dist/index.js：代码包缺少契约包产物，请反馈该发布包不完整"
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
fi
if [ ! -f "$TMP_EXTRACT/package.json" ]; then
  err "解压后未找到 package.json，代码包结构异常"
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
fi
# 复制代码到安装目录（首次部署与更新共用此逻辑）
# 注意：不会覆盖 .env（配置文件）、var/（运行时数据）、node_modules/（已安装依赖）
cp -rf "$TMP_EXTRACT/." "$MC_COMMANDER_DIR/"
# 复制 .env.example（如果不存在 .env 时作为模板）
if [ ! -f "$MC_COMMANDER_DIR/.env" ] && [ -f "$TMP_EXTRACT/.env.example" ]; then
  cp -f "$TMP_EXTRACT/.env.example" "$MC_COMMANDER_DIR/"
fi
# 清理临时文件
rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
log "代码下载完成"
fi  # SKIP_DOWNLOAD

# 7. 安装编译工具（better-sqlite3 等原生模块需要）
log "安装编译工具..."
case "$PKG_MANAGER" in
  apt) install_pkg build-essential python3 ;;
  yum) install_pkg gcc-c++ make python3 ;;
  dnf) install_pkg gcc-c++ make python3 ;;
  apk) install_pkg build-base python3 ;;
esac

# 8. 安装 npm 依赖（配置国内镜像加速）
#
# 先停面板再动依赖：npm ci 的语义是先 rm -rf node_modules 再重建，
# 期间旧进程还在服务，任何一次运行期懒加载（升级/部署服务里的 await import）
# 都会撞上不存在的模块而崩掉——用户在升级窗口里正好点了那个功能就中招。
# 只在「升级」时停（首次安装还没有服务在跑），装完由后面的启动步骤拉起。
log "安装 npm 依赖..."
# 为 node-gyp 配置国内镜像源，避免从 nodejs.org 下载头文件超时
export npm_config_node_mirror="https://npmmirror.com/mirrors/node/"

# 升级路径：停掉正在跑的面板，给 npm ci 一个没有读者的窗口。
# 服务由 systemd/pm2 托管，停掉不会影响已运行的 MC 实例（KillMode=process）。
if [ -f "$MC_COMMANDER_DIR/package.json" ] && command -v systemctl &>/dev/null; then
  if systemctl is-active --quiet mc-commander 2>/dev/null; then
    log "停止面板服务（升级期间不对外服务，MC 实例不受影响）..."
    systemctl stop mc-commander 2>/dev/null || true
    # 升级中途失败时由 on_exit 把面板拉回来：停在停机状态等于「升级失败 = 面板消失」，
    # 而用户看到的只是一条报错，不知道服务已经不再监听
    PANEL_STOPPED=1
  fi
fi
# 用 npm ci 而非 npm install：严格按 lock 重建依赖树；升级时先清旧 node_modules，
# 避免「半新半旧」的依赖树被 systemd 拉起来（可复现是产物带 lock 的全部意义）
npm ci --omit=dev

# 9. 生成/读取 .env 配置（API Key 首次部署自动生成，更新时保留原有Key）
# .env 只落 API_KEY_HASH（SHA-256 摘要），明文仅在完成横幅一次性展示
# SETUP_TOKEN：首访设密所有权证明。未作废的令牌留在 .env 里，重跑脚本时读回并
# 再次展示——用户「装完把终端关了 / 没记住」是常态，重跑是他唯一会想到的动作，
# 而 sudo 读 .env 不是低代码用户做得到的事。设密成功即被服务端删除，故重跑不会
# 复活已用过的令牌。
SETUP_TOKEN=""
API_KEY=""
if [ ! -f .env ]; then
  log "首次部署，生成 API Key 和 .env 配置文件..."
  # 32 字节（256 位）CSPRNG：与文档对「自填 Key」的要求同一把尺子，
  # 也避免出现「要求部署方 32 字节、脚本自己发 16 字节」的不一致
  API_KEY=$(openssl rand -hex 32)
  # 一次性令牌：浏览器首访设密时需粘贴（服务端校验 Authorization: SetupToken <token>），
  # 设密成功立即作废（内存清空 + .env 移除，重启后同样失效）
  SETUP_TOKEN=$(openssl rand -hex 32)
  cat > .env <<EOF
API_KEY_HASH=$(printf '%s' "$API_KEY" | sha256sum | awk '{print $1}')
SETUP_TOKEN=$SETUP_TOKEN
# 脚本会开放 25566 并在完成横幅里给出公网访问地址，故显式对外监听：
# 服务端默认 127.0.0.1（仅本机），不写这一行会让「部署完成」的地址打不开
HOST=0.0.0.0
PORT=25566
SERVERS_DIR=./var/servers
DATA_DIR=./var/data
BACKUPS_DIR=./var/backups
LOG_LEVEL=info
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100
EOF
  # PUBLIC_IP 单独追加（仅探测成功时）：不确定的公网 IP 不如不写——
  # 写空值会让服务端以为「已显式配置」而短路掉整条探测链
  if [ -n "$PUBLIC_IP_DETECTED" ] && ! is_private_ip "$PUBLIC_IP_DETECTED"; then
    {
      echo "# 服务端展示给玩家的服务器地址用它（见 mc_server.js 的 PUBLIC_IP 分支）。"
      echo "# 云服务器换弹性 IP、或探测值不对时，改这里后重启面板即可。"
      echo "PUBLIC_IP=$PUBLIC_IP_DETECTED"
    } >> .env
  fi
  # 明文不入日志（日志会长期留存）：浏览器走会话鉴权用不到它，
  # 要接自动化工具的人在面板「设置 → 连接设置」重新生成即可
  log "已生成 API Key（浏览器不需要；要接自动化工具时在面板里重新生成）"
  log "已生成一次性 SETUP_TOKEN（首访设密时需粘贴，用后作废）"
else
  log ".env 已存在，保留现有 API_KEY_HASH（不重新生成）..."
  # 令牌行只可能存在于「还没设过密」的机器上：设密成功时服务端会删掉它
  SETUP_TOKEN=$(sed -n 's/^SETUP_TOKEN=//p' .env | head -1)
  if [ -n "$SETUP_TOKEN" ]; then
    log "首访尚未设密，沿用 .env 里的 SETUP_TOKEN（完成横幅会再次展示）"
  fi
  # 补齐新版脚本才有的键：老 .env 缺 HOST 会让面板只监听 127.0.0.1，
  # 用户重装后「看起来装好了」却打不开——比报错更难查。只补缺的键，已有值一律不动。
  ENV_ADDED=""
  env_backfill() {
    local key="$1" value="$2"
    if ! grep -qE "^[[:space:]]*${key}=" .env; then
      printf '%s=%s\n' "$key" "$value" >> .env
      ENV_ADDED="${ENV_ADDED}${key} "
    fi
  }
  env_backfill HOST 0.0.0.0
  env_backfill PORT 25566
  env_backfill SERVERS_DIR ./var/servers
  env_backfill DATA_DIR ./var/data
  env_backfill BACKUPS_DIR ./var/backups
  env_backfill LOG_LEVEL info
  if [ -n "$ENV_ADDED" ]; then
    log "已补齐 .env 缺失的配置项：${ENV_ADDED}"
  fi
fi

# 9.5 开放防火墙端口（默认 25566）
#
# 端口只有一个事实源：.env 里的 PORT。用户改过端口后，就绪检查、防火墙放行、
# 完成横幅的地址都必须跟着变——写死 25566 会让「面板明明起来了」被判成
# 「部署未完成」，用户于是去修一个根本不存在的问题。
SERVER_PORT=$(sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p' "$MC_COMMANDER_DIR/.env" 2>/dev/null | head -1)
SERVER_PORT="${SERVER_PORT:-25566}"
# 就绪等待预算（秒）：慢盘/低配机上首次启动可能超过 30 秒
READY_TIMEOUT="${READY_TIMEOUT:-30}"
# 防火墙状态记下来给完成横幅用：ufw 未启用时 `ufw allow` 照样返回 0 并打印
# 「Skipping adding existing rule」，据此说「已开放端口」是假的——端口从来没被拦过。
FIREWALL_STATE="unknown"
log "检查防火墙端口 $SERVER_PORT ..."
if command -v ufw &>/dev/null; then
  if ufw status 2>/dev/null | head -1 | grep -qi 'inactive'; then
    FIREWALL_STATE="ufw-inactive"
  elif ufw allow "$SERVER_PORT"/tcp >/dev/null 2>&1; then
    FIREWALL_STATE="opened-ufw"
    record_change "firewall-ufw" "$SERVER_PORT"
  else
    FIREWALL_STATE="failed"
  fi
elif command -v firewall-cmd &>/dev/null; then
  if firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="$SERVER_PORT"/tcp >/dev/null 2>&1
    firewall-cmd --reload >/dev/null 2>&1
    FIREWALL_STATE="opened-firewalld"
    record_change "firewall-firewalld" "$SERVER_PORT"
  else
    FIREWALL_STATE="firewalld-inactive"
  fi
elif command -v iptables &>/dev/null; then
  if iptables -I INPUT -p tcp --dport "$SERVER_PORT" -j ACCEPT >/dev/null 2>&1; then
    FIREWALL_STATE="opened-iptables"
    record_change "firewall-iptables" "$SERVER_PORT"
  else
    FIREWALL_STATE="failed"
  fi
else
  FIREWALL_STATE="none"
fi
# 注意：云服务器（阿里云/腾讯云/华为云等）还需在控制台安全组中手动放行 25566 端口

# 10. 启动后端服务
log "启动 MC_Commander 后端..."

if [ "$SKIP_SYSTEMD" -eq 0 ] && command -v systemctl &>/dev/null; then
  # 创建专用低权限运行用户（服务以 mc-commander 身份运行而非 root；25566 高位端口无需 root 权限）
  if ! id -u mc-commander &>/dev/null; then
    log "创建专用低权限用户 mc-commander..."
    # --system 创建系统用户；--shell nologin 禁止交互登录
    useradd --system --home-dir "$MC_COMMANDER_DIR" --shell "$(command -v nologin || echo /usr/sbin/nologin)" mc-commander
    record_change "user-created" "mc-commander"
  fi
  # 安装目录/数据目录属主交给该用户（服务运行需要读写 var/ 下的数据目录）
  chown -R mc-commander:mc-commander "$MC_COMMANDER_DIR"
  # .env 含 API Key，收紧权限为仅属主可读写
  [ -f "$MC_COMMANDER_DIR/.env" ] && chmod 600 "$MC_COMMANDER_DIR/.env"
  cat > /etc/systemd/system/mc-commander.service <<EOF
[Unit]
Description=MC_Commander Server
After=network.target

[Service]
Type=simple
User=mc-commander
# 生产模式：启用 NODE_ENV 门控行为（严格错误掩码等），避免环境不一致
Environment=NODE_ENV=production
# 只向面板主进程发停止信号，不波及同 cgroup 的 MC 实例——面板停机不停实例，
# 实例由下次启动的 pid 文件接管。默认 control-group
# 会把实例一并 SIGTERM 杀掉，使该语义失效
KillMode=process
WorkingDirectory=$MC_COMMANDER_DIR
ExecStart=$(which node) src/index.js
Restart=always
RestartSec=3
# 起不来时不要无限重试：默认 10 秒窗口内允许 5 次，而 3 秒间隔下永远够不着这个额度，
# 结果是每 3 秒重试一次、永不进入 failed，用户既看不到「它坏了」也等不到它自己好。
# 收紧到 5 分钟内 5 次，超出即停在 failed 并保留日志供排查。
StartLimitIntervalSec=300
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
EOF
  record_change "systemd-unit" "/etc/systemd/system/mc-commander.service"

  # 彻底删除的执行单元：面板以 mc-commander 低权限运行，删不掉自己，
  # 故预置一个 root 权限、不自启、只能由面板触发的一次性单元。
  # 面板经 sudoers 白名单只允许 start 这一个单元，不能执行任意命令。
  #
  # 脚本副本装到 root 独占目录：安装目录整体 chown 给了面板用户，root 执行的
  # 脚本留在那儿就等于「面板只要能写文件就能改掉 root 要跑的代码」。
  install -d -o root -g root -m 0755 "$REMOVAL_LIB_DIR"
  install -o root -g root -m 0755 \
    "$MC_COMMANDER_DIR/src/services/panel-removal.sh" "$REMOVAL_SCRIPT"
  record_change "removal-lib" "$REMOVAL_SCRIPT"
  cat > /etc/systemd/system/mc-commander-removal.service <<EOF
[Unit]
Description=MC Commander panel removal
After=network.target

[Service]
Type=oneshot
# 以 root 运行：清理要删专用用户与系统单元，低权限做不到。
# 该单元只能由面板经 sudoers 白名单触发，不接受其它调用路径。
User=root
Environment=MC_COMMANDER_DIR=$MC_COMMANDER_DIR
ExecStart=/bin/bash $REMOVAL_SCRIPT --purge
EOF
  record_change "systemd-unit" "/etc/systemd/system/mc-commander-removal.service"

  # 保留数据版本：面板上「保留存档」走这条
  cat > /etc/systemd/system/mc-commander-removal-keep.service <<EOF
[Unit]
Description=MC Commander panel removal (keep data)
After=network.target

[Service]
Type=oneshot
User=root
Environment=MC_COMMANDER_DIR=$MC_COMMANDER_DIR
ExecStart=/bin/bash $REMOVAL_SCRIPT --keep-data
EOF
  record_change "systemd-unit" "/etc/systemd/system/mc-commander-removal-keep.service"

  # sudoers 白名单：只放行启动这两个单元，面板拿不到任何其它 root 能力。
  # 必须带 --no-block：sudoers 按完整参数序列匹配，面板用别的形态调用一律不匹配。
  cat > /etc/sudoers.d/mc-commander <<EOF
mc-commander ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block mc-commander-removal.service, /usr/bin/systemctl start --no-block mc-commander-removal-keep.service
EOF
  chmod 440 /etc/sudoers.d/mc-commander
  record_change "sudoers" "/etc/sudoers.d/mc-commander"

  systemctl daemon-reload
  systemctl enable mc-commander
  # 面板停机不停实例：重启后面板按 pid 文件接管运行态，
  # 但接管实例的控制台管道不可恢复——命令需 RCON，无 RCON 的实例只能强制终止
  if pgrep -f 'servers/.*/server\.jar' >/dev/null 2>&1; then
    warn "检测到运行中的 MC 实例：面板重启后将自动接管（运行态恢复，日志从接管时刻起）"
    warn "接管实例的命令需启用 RCON；未启用 RCON 的实例将只能强制终止"
  fi
  systemctl restart mc-commander
  # 服务已重新拉起，升级窗口结束：清掉中断恢复钩子，避免正常退出时再动一次服务
  PANEL_STOPPED=0
  log "已注册并启动 systemd 服务: mc-commander（以专用低权限用户 mc-commander 运行）"
elif command -v pm2 &>/dev/null; then
  # pm2 分支同样显式设置 NODE_ENV=production，使错误掩码/密钥校验等门控行为确定化
  NODE_ENV=production pm2 start src/index.js --name mc-commander
  pm2 save
  log "已通过 pm2 启动服务（NODE_ENV=production）"
else
  warn "未检测到 systemd/pm2，使用 nohup 后台运行（重启后需手动启动）"
  warn "当前将以 root 运行服务，建议改用 systemd 并配置专用低权限用户后重新启动"
  NODE_ENV=production nohup node src/index.js > "$MC_COMMANDER_DIR/server.log" 2>&1 &
  echo "$!" > "$MC_COMMANDER_DIR/server.pid"
  log "已通过 nohup 启动，PID: $(cat "$MC_COMMANDER_DIR/server.pid")"
fi

# 判断本次安装的面板是否真的在服务：成功返回 0，并把「端口实际答出的版本」写进 SEEN_VERSION。
# 只判 2xx 会把旧版本面板、或任何占住该端口的进程认成本次安装成功。
wait_until_ready() {
  local body seen deadline
  SEEN_VERSION=""
  RESPONDED=0
  SERVICE_STATE=""
  INSTALLED_VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$MC_COMMANDER_DIR/package.json" 2>/dev/null | head -1 || true)
  deadline=$((SECONDS + ${READY_TIMEOUT:-30}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    # --max-time：对端 accept 却不回包时，无超时的 curl 会让整个等待卡在第 1 轮
    if body=$(curl -sf --max-time 3 "http://localhost:$SERVER_PORT/health" 2>/dev/null); then
      RESPONDED=1
      seen=$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)
      SEEN_VERSION="$seen"
      # 磁盘读不到版本号时退回「有响应即就绪」：此时没有可比对的基准
      if [ -z "$INSTALLED_VERSION" ] || [ "$seen" = "$INSTALLED_VERSION" ]; then
        # 版本对上了还不够：unit 崩溃重启期间旧进程照样答这个端口，此时「重启成功」是假的
        if [ "${SKIP_SYSTEMD:-0}" -ne 0 ] || ! command -v systemctl &>/dev/null; then
          return 0
        fi
        SERVICE_STATE=$(systemctl is-active mc-commander 2>/dev/null || true)
        if [ "$SERVICE_STATE" = "active" ]; then
          return 0
        fi
      fi
    fi
    sleep 1
  done
  return 1
}

# 11. 等待服务就绪（判据见 wait_until_ready）
log "等待服务启动..."
# 就绪失败必须阻断：继续走下去会打出「部署完成」横幅并退出 0，
# 而服务可能正在崩溃重启——用户会拿着一个打不开的地址去排查面板内部
if ! wait_until_ready; then
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  部署未完成：面板没有在 $READY_TIMEOUT 秒内就绪"
  echo "═══════════════════════════════════════════════════"
  echo ""
  if [ "$RESPONDED" -eq 1 ] && [ -n "$SEEN_VERSION" ] && [ "$SEEN_VERSION" != "$INSTALLED_VERSION" ]; then
    echo "端口 $SERVER_PORT 上此刻响应的是 v$SEEN_VERSION，而本次安装的是 v${INSTALLED_VERSION:-未知}。"
    echo "说明该端口被另一个程序占着——通常是之前装过的旧版本面板还在运行。"
  elif [ "$RESPONDED" -eq 1 ] && [ -z "$SEEN_VERSION" ]; then
    echo "端口 $SERVER_PORT 上有程序应答，但读不出版本号，无法确认它就是本次安装的面板。"
  elif [ "$RESPONDED" -eq 1 ]; then
    echo "端口 $SERVER_PORT 上确实是本次安装的面板（v$SEEN_VERSION），但它没有稳定运行。"
    echo "面板服务此刻的状态是「${SERVICE_STATE:-未知}」——正在反复崩溃重启。"
  else
    echo "端口 $SERVER_PORT 上没有任何程序响应。"
  fi
  echo ""
  if command -v ss &>/dev/null; then
    PORT_LINE=$(ss -ltnp "sport = :$SERVER_PORT" 2>/dev/null | tail -n +2 | head -1 || true)
    if [ -n "$PORT_LINE" ]; then
      OWNER_PID=$(printf '%s' "$PORT_LINE" | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)
      OWNER_CMD=$(printf '%s' "$PORT_LINE" | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1 || true)
      echo "占用端口的进程：${OWNER_CMD:-未知}（PID ${OWNER_PID:-未知}）"
    fi
  fi
  if [ "$SKIP_SYSTEMD" -eq 0 ] && command -v systemctl &>/dev/null; then
    SVC_STATE=$(systemctl is-active mc-commander 2>/dev/null || true)
    echo "面板服务状态：${SVC_STATE:-未知}"
  fi
  echo ""
  echo "下一步："
  if [ "${SKIP_SYSTEMD:-0}" -eq 0 ] && command -v systemctl &>/dev/null; then
    echo "  1. 让开端口：停掉上面那个占用的进程。面板服务每 3 秒重试一次，端口腾出来会自己起来"
  else
    echo "  1. 让开端口后手动启动：cd $MC_COMMANDER_DIR && node src/index.js"
  fi
  echo "  2. 也可以重新运行同一条部署命令，已下载的代码与配置都会保留"
  if [ "$SKIP_SYSTEMD" -eq 0 ] && command -v journalctl &>/dev/null; then
    echo "  3. 需要更多线索时看日志：sudo journalctl -u mc-commander -n 50 --no-pager"
  else
    echo "  3. 需要更多线索时看日志：$MC_COMMANDER_DIR/server.log"
  fi
  # 只交付 SETUP_TOKEN：面板能起来后，API Key 在面板里随时可重新生成
  # （浏览器本来也用不到它），而令牌丢了就只能重跑脚本
  if [ -n "$SETUP_TOKEN" ]; then
    echo ""
    echo "SETUP_TOKEN 已生成，设密时仍需粘贴，请先保存："
    echo "  $SETUP_TOKEN"
  fi
  echo ""
  exit 1
fi
log "服务已就绪（端口 $SERVER_PORT，版本 $SEEN_VERSION）"

# 12. 输出部署信息
# 用户在自己电脑的浏览器里打开面板，故 localhost 对他无意义（那指向他自己的电脑）。
# 探测不到公网地址时宁可留空让他去控制台看，也不给一条他必然打不开的链接。
#
# PUBLIC_URL：部署方已知对外地址时（典型是前面挂了反向代理/域名）由他给出，
# 此时脚本探测到的 IP 与真实入口不是一回事，硬拼出来的链接必然打不开。
PANEL_URL=""
if [ -n "${PUBLIC_URL:-}" ]; then
  PANEL_URL="${PUBLIC_URL%/}/"
elif [ -n "${PUBLIC_IP_DETECTED:-}" ] && ! is_private_ip "$PUBLIC_IP_DETECTED"; then
  PANEL_URL="http://$PUBLIC_IP_DETECTED:$SERVER_PORT/"
fi

# 入站可达性：服务在本地能应答，不等于外面连得进来。云主机的安全组默认几乎都
# 不放行自定义端口，而那一层脚本碰不到——用户看到「部署完成」+ 一个打不开的地址，
# 只会怀疑是自己装坏了。
#
# 判据用「从本机连自己的公网 IP」：放行就通、没放行就超时（实测 000 / 5s 超时）。
# 这条在 NAT 型云主机上同样成立——内部访问公网 IP 会被平台绕回本机，故它与
# 外部真实入站同生共死，是唯一不依赖第三方服务的可靠探针。
REACHABLE="unknown"
if [ -n "${PUBLIC_URL:-}" ]; then
  # 用户自己给了对外地址，安全组是否放行只有他知道，脚本不猜
  REACHABLE="skipped"
elif [ -n "$PANEL_URL" ]; then
  if curl -sf -o /dev/null --connect-timeout 5 --max-time 8 "$PANEL_URL" 2>/dev/null; then
    REACHABLE="yes"
  else
    REACHABLE="no"
  fi
fi

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║          MC_Commander  部署完成！                 ║"
echo "╠═══════════════════════════════════════════════════╣"
echo "║                                                   ║"
if [ -n "$PANEL_URL" ]; then
echo "║  ① 在浏览器里打开这个地址                         ║"
# URL 是纯 ASCII，%-51s 按字节补齐与显示宽度一致
printf "║%-51s║\n" "     $PANEL_URL"
else
echo "║  ① 在浏览器里打开面板                             ║"
echo "║     地址是 http://<公网 IP>:$SERVER_PORT/                ║"
echo "║     公网 IP 在云服务器控制台 → 实例列表里看       ║"
echo "║     前面挂了反向代理或域名？重跑时给 PUBLIC_URL   ║"
fi
echo "║                                                   ║"
# 只承诺已经真的起来了的能力：TLS 起不来时服务端会退回纯明文（缺 openssl、
# 证书生成失败等），此时说「已支持加密访问」是空头承诺，用户按它去装证书
# 会装完发现还是 http
if curl -skf -o /dev/null --connect-timeout 3 --max-time 6 "https://localhost:$SERVER_PORT/health" 2>/dev/null; then
echo "║  面板已支持加密访问（https，同一端口）            ║"
echo "║  浏览器会提示证书不受信——这是自签证书的正常现象   ║"
echo "║  进面板后在「设置 → 账号与安全」按提示装一次      ║"
echo "║  根证书，之后每台设备都走 https                   ║"
else
echo "║  本机加密访问未能启动，本次只提供 http            ║"
echo "║  面板其余功能不受影响；原因见启动日志             ║"
echo "║  常见原因：系统缺少 openssl 命令                  ║"
fi
echo "║                                                   ║"
if [ -n "$SETUP_TOKEN" ]; then
echo "║  ② 首次进入要设管理员密码                         ║"
echo "║     把下面这串 SETUP_TOKEN 粘到设密页：           ║"
echo "║                                                   ║"
# 令牌不套边框：三击选行会连 ║ 一起复制（实测 70 字符），粘进设密页必然校验失败
echo "    $SETUP_TOKEN"
echo "║                                                   ║"
echo "║  这串没存下来？重新运行同一条安装命令即可再显示   ║"
echo "║                                                   ║"
fi
echo "║  ③ 想接自动化工具？进面板后在「设置 → 连接设置」  ║"
echo "║     里生成 API Key，浏览器用不到它                ║"
echo "║                                                   ║"
echo "╠═══════════════════════════════════════════════════╣"
echo "║  游戏服务器地址不在这里                           ║"
echo "║  建好实例后，面板顶栏会显示「地址:端口」，        ║"
echo "║  那是给玩家连 MC 用的（默认端口 25565）。         ║"
if [ "${JAVA25_MISSING:-0}" -eq 1 ]; then
echo "║                                                   ║"
echo "║  ⚠ 缺少 Java 25：MC 26.x 及更新版本的实例无法启动 ║"
echo "║    面板其余功能不受影响                           ║"
fi
echo "╠═══════════════════════════════════════════════════╣"
# 按实测的可达性说话，不按「本机防火墙开没开」猜：ufw 没开而安全组拦着时，
# 本机看着「没有拦截」，实际外面连不进来，用户会转而去怀疑面板本身
if [ "$REACHABLE" = "no" ]; then
echo "║  ✗ 从外面还连不进来                               ║"
echo "║    面板本身是好的（本机访问正常），卡在云平台。   ║"
echo "║    去云控制台找到这台机器，把下面的端口放行：     ║"
echo "║      端口 $SERVER_PORT · 协议 TCP · 来源 0.0.0.0/0       ║"
echo "║    腾讯云/阿里云轻量：控制台 →「防火墙」页        ║"
echo "║    ECS/CVM：控制台 →「安全组」→ 入方向 → 添加规则 ║"
echo "║    放行后刷新页面即可，不用重装                   ║"
elif [ "$REACHABLE" = "yes" ]; then
echo "║  ✓ 已确认可以从外网访问                           ║"
echo "║    端口对公网开放，建议只放行你自己的 IP          ║"
case "$FIREWALL_STATE" in
  opened-ufw|opened-firewalld|opened-iptables|ufw-inactive|firewalld-inactive|none) ;;
  *) echo "║    注意：本机防火墙规则可能未生效，留意拦截       ║" ;;
esac
else
case "$FIREWALL_STATE" in
  opened-ufw|opened-firewalld|opened-iptables)
    echo "║  本机防火墙已放行 $SERVER_PORT                           ║"
    echo "║  云服务器还需在控制台安全组放行该端口             ║"
    ;;
  ufw-inactive|firewalld-inactive|none)
    echo "║  本机未启用防火墙                                 ║"
    echo "║  云服务器还需在控制台安全组放行该端口             ║"
    ;;
  *)
    echo "║  ⚠ 端口放行可能未生效，访问不了时检查防火墙       ║"
    ;;
esac
fi
echo "╠═══════════════════════════════════════════════════╣"
echo "║  接下来：进面板 → 部署实例                        ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""
echo "常用命令："
if [ "$SKIP_SYSTEMD" -eq 0 ]; then
  echo "  systemctl status  mc-commander    # 查看状态"
  echo "  systemctl restart mc-commander    # 重启服务"
  echo "  systemctl stop    mc-commander    # 停止服务"
  echo "  journalctl -u mc-commander -f     # 查看日志"
  echo "  服务以专用低权限用户 mc-commander 运行（非 root）；如需修改服务配置："
  echo "  sudo systemctl edit mc-commander  # 覆盖配置（如启动参数）"
else
  echo "  cd $MC_COMMANDER_DIR && node src/index.js   # 手动启动"
  echo "  提示：建议以非 root 的专用系统用户运行服务，避免高权限运行"
fi
echo ""
