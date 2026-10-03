#!/usr/bin/env bash
# MC_Commander 一键部署脚本
#
# 用法（远程两步命令，推荐先下载再执行，便于审查脚本内容）:
#   curl -fsSL -o /tmp/deploy-mc-commander.sh https://raw.githubusercontent.com/wyyfzb/mc-commander/main/mc_commander_server/scripts/deploy-mc-commander.sh
#   sudo bash /tmp/deploy-mc-commander.sh
#
# 用法（本地执行）:
#   sudo bash deploy-mc-commander.sh
#
# 卸载:
#   sudo bash deploy-mc-commander.sh --uninstall         移除面板（保留 servers/ data/ backups/）
#   sudo bash deploy-mc-commander.sh --uninstall --purge 连数据一起删（需确认，--yes 可跳过）
#   bash deploy-mc-commander.sh --help                   查看全部用法
#
# 环境变量覆盖:
#   MC_COMMANDER_DIR=/opt/mc-commander  安装目录
#   VERSION=latest                      发布版本：latest（默认）取最新发布版，或 v0.6.0 这类具体 tag。
#                                       旧名 BRANCH 仍作兼容别名生效
#   PACKAGE_URL=xxx                     后端代码包下载地址（tar.gz），默认取 GitHub Release 资产
#   SHA256SUMS_URL=xxx                  摘要文件地址，默认与 PACKAGE_URL 同 Release；自定义 PACKAGE_URL 时需一并设置
#   NODE_VERSION=v22.23.2               官方二进制兜底安装时固定的 Node.js LTS 版本号
#
# 安全说明：
#   - 代码包下载后取**同一 Release** 的 SHA256SUMS.txt 比对校验，不一致立即中止并删除临时文件。
#     摘要与资产同源，故防的是传输损坏与单方面替换资产（Release 已开 Immutable Releases：
#     发布后资产不可增删改、tag 不可删移）；要防「发布方本身被攻陷」需另行核对 tag 签名
#   - 不使用第三方 curl|bash 引导脚本；Node.js 优先发行版官方源，兜底用官方二进制包 + SHASUMS256.txt 校验
#   - systemd 服务以专用低权限用户 mc-commander 运行（25566 高位端口无需 root）
set -euo pipefail

# 禁止 apt/debconf 在安装过程中弹出交互式配置界面（如 needrestart 服务重启提示）
# 对非 Debian 系统无影响
export DEBIAN_FRONTEND=noninteractive
# 让 needrestart 自动重启使用旧库的服务，不再提示 "Which services should be restarted?"
export NEEDRESTART_MODE=a

MC_COMMANDER_DIR="${MC_COMMANDER_DIR:-/opt/mc-commander}"
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
# 故这里自动选路——先 GitHub（权威源），探测不通或下载失败则自动切 Gitee。
GITEE_OWNER="${GITEE_OWNER:-wyyfzb}"
GITEE_REPO="${GITEE_REPO:-mc-commander}"
GITEE_API="https://gitee.com/api/v5/repos/$GITEE_OWNER/$GITEE_REPO"
# 置 0 可强制只用 GitHub（排查问题用；正常用户不需要知道这个变量）
ALLOW_GITEE_FALLBACK="${ALLOW_GITEE_FALLBACK:-1}"
# 探测超时（秒）：GitHub 挂死时 HEAD 实测在 10s 内超时，故不必等下载函数的 60s
PROBE_TIMEOUT="${PROBE_TIMEOUT:-12}"
# 当前实际使用的源，供报错文案与日志显示
SOURCE="GitHub"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "[WARN] $*"; }
err()  { echo "[ERROR] $*" >&2; }

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
# 默认**保留**数据（servers/ 是玩家的世界，删掉不可恢复）：只停服务、
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
    rm -f "$unit_path"
    systemctl daemon-reload 2>/dev/null || true
    systemctl reset-failed mc-commander 2>/dev/null || true
    log "已删除 /etc/systemd/system/mc-commander.service"
  elif [ "$unit_matches" -eq 0 ] && [ ! -f "$unit_path" ]; then
    log "未发现 systemd 服务（可能当初以非 root 部署）"
  fi

  # 2. 删除专用用户（仅在确认单元归属本目录、或压根没有单元时）
  # 家目录就是安装目录，先删用户不影响后续 rm
  if [ "$unit_matches" -eq 1 ] && id -u mc-commander &>/dev/null; then
    if userdel mc-commander 2>/dev/null; then
      log "已删除系统用户 mc-commander"
    else
      warn "删除用户 mc-commander 失败（可能有进程仍以该用户运行），可稍后手动 userdel"
    fi
  fi

  # 3. 目录处理：默认保留数据，--purge 才整体删除
  if [ "$purge" -eq 1 ]; then
    if [ "$assume_yes" -ne 1 ]; then
      echo ""
      warn "即将永久删除：$MC_COMMANDER_DIR"
      warn "其中 servers/ 下的每个实例都是**完整的 Minecraft 世界存档**，删掉无法恢复。"
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
    # 只删面板自己的代码与依赖，保留三个数据目录
    log "保留数据目录（servers/ data/ backups/）"
    for item in index.js config.js websocket.js package.json package-lock.json \
                services routes utils middleware db public mc-schemas; do
      [ -e "$MC_COMMANDER_DIR/$item" ] && rm -rf "${MC_COMMANDER_DIR:?}/$item"
    done
    if [ -d "$MC_COMMANDER_DIR" ]; then
      echo ""
      log "面板已卸载。以下数据**仍然保留**在 $MC_COMMANDER_DIR："
      for d in servers data backups; do
        [ -d "$MC_COMMANDER_DIR/$d" ] && log "  - $d/"
      done
      log "确认不再需要时，可手动删除整个目录：sudo rm -rf $MC_COMMANDER_DIR"
    fi
  fi

  echo ""
  log "卸载完成。防火墙端口 25566 的放行规则未自动移除"
  log "（可能被其它服务共用，如不再需要请自行清理：ufw delete allow 25566/tcp）"
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

# 包管理器更新（确保软件包索引是最新的）
case "$PKG_MANAGER" in
  apt) apt-get update ;;
  yum) yum makecache ;;
  dnf) dnf makecache ;;
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
  ip=$(curl -sf --connect-timeout 3 https://myip.ipip.net 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://ip.sb 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://ifconfig.me 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://icanhazip.com 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://api.ipify.org 2>/dev/null) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://ident.me 2>/dev/null) && echo "$ip" && return
  # 云厂商元数据 API（腾讯云/阿里云，需 -k 跳过自签名证书）
  ip=$(curl -sf --connect-timeout 2 https://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null) && echo "$ip" && return
  ip=$(curl -sfk --connect-timeout 2 https://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null) && echo "$ip" && return
  # 从本地网卡 IP 中筛选：逐个排除私网/保留段，取第一个公网 IP
  # （判据与 is_private_ip 同源，不再内联第二份排除正则）
  local candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if ! is_private_ip "$candidate"; then
      echo "$candidate"
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

# 2. 安装基础工具（curl、tar、rsync）
# rsync 为备份功能依赖（目录快照 + --link-dest 硬链接增量，缺失时备份降级失败）
for tool in curl tar rsync; do
  if ! command -v "$tool" &>/dev/null; then
    log "安装 $tool..."
    install_pkg "$tool"
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
setup_corretto_repo() {
  case "$PKG_MANAGER" in
    apt)
      if [ ! -f /usr/share/keyrings/corretto-keyring.gpg ]; then
        log "添加 Amazon Corretto 仓库..."
        wget -qO- https://apt.corretto.aws/corretto.key | gpg --dearmor -o /usr/share/keyrings/corretto-keyring.gpg
        echo "deb [signed-by=/usr/share/keyrings/corretto-keyring.gpg] https://apt.corretto.aws stable main" > /etc/apt/sources.list.d/corretto.list
        apt-get update
      fi
      ;;
    yum|dnf)
      if [ ! -f /etc/yum.repos.d/corretto.repo ]; then
        log "添加 Amazon Corretto 仓库..."
        curl -fsSL https://yum.corretto.aws/corretto.repo -o /etc/yum.repos.d/corretto.repo
      fi
      ;;
  esac
}

install_java() {
  local need_17=0 need_21=0 need_25=0
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
        install_pkg "${pkgs[@]}" || warn "OpenJDK 安装失败（部分发行版可能缺少对应版本），将尝试 Amazon Corretto"
      fi
      # Java 25 使用 Amazon Corretto JDK（Corretto 仓库不提供 JRE-headless 变体，
      # 且 PaperMC 官方建议不使用 headless 变体以避免缺少 GUI 依赖）
      if [ "$need_25" -eq 1 ]; then
        setup_corretto_repo
        install_pkg java-25-amazon-corretto-jdk
      fi
      ;;
    yum|dnf)
      local pkgs=()
      [ "$need_17" -eq 1 ] && pkgs+=(java-17-openjdk-headless)
      [ "$need_21" -eq 1 ] && pkgs+=(java-21-openjdk-headless)
      if [ "${#pkgs[@]}" -gt 0 ]; then
        log "安装 OpenJDK: ${pkgs[*]}"
        install_pkg "${pkgs[@]}" || warn "OpenJDK 安装失败，将尝试 Amazon Corretto"
      fi
      if [ "$need_25" -eq 1 ]; then
        setup_corretto_repo
        install_pkg java-25-amazon-corretto-devel
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
        install_pkg "${pkgs[@]}"
      fi
      ;;
  esac

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
    install_pkg coreutils
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
  ln -sfn "/opt/node-${NODE_VERSION}-linux-${arch}/bin/node" /usr/local/bin/node
  ln -sfn "/opt/node-${NODE_VERSION}-linux-${arch}/bin/npm" /usr/local/bin/npm
  ln -sfn "/opt/node-${NODE_VERSION}-linux-${arch}/bin/npx" /usr/local/bin/npx
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
      install_pkg nodejs npm >/dev/null 2>&1 || true
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
      install_pkg nodejs npm
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
mkdir -p "$MC_COMMANDER_DIR"/{servers,data,backups}

# 5.5 校验实例目录与备份目录同文件系统：rsync --link-dest 硬链接要求
# link() 同设备（跨文件系统返回 EXDEV，退化为全量复制——磁盘节省失效、
# 耗时增加）。仅告警不阻断（退化为复制仍可用，只是非最优）
if command -v stat &>/dev/null; then
  SRC_DEV=$(stat -c %d "$MC_COMMANDER_DIR/servers" 2>/dev/null || echo "")
  BAK_DEV=$(stat -c %d "$MC_COMMANDER_DIR/backups" 2>/dev/null || echo "")
  if [ -n "$SRC_DEV" ] && [ -n "$BAK_DEV" ] && [ "$SRC_DEV" != "$BAK_DEV" ]; then
    warn "servers/ 与 backups/ 位于不同文件系统（设备号 $SRC_DEV vs $BAK_DEV）"
    warn "备份的 rsync --link-dest 硬链接增量将退化为全量复制（磁盘占用大、耗时增加）"
    warn "建议将 backups 与 servers 放置在同一磁盘分区"
  fi
fi

cd "$MC_COMMANDER_DIR"

# 5.6 探测公网 IP 并缓存（供 .env 与完成横幅共用，见 get_public_ip 头注释）
# 放在 .env 生成之前：写进 .env 的 PUBLIC_IP 是服务端的**首选**来源，
# 不写它，服务端就要自己异步探测（探测期间顶栏会退回显示局域网 IP——
# 而那是玩家连不上的地址，用户会照着复制发给朋友）。整体超时上限随探测链，
# 各源 --connect-timeout 3s、最多 8 个源，最坏约 20s，仅首次部署时发生。
log "探测公网 IP（用于面板展示服务器地址）..."
PUBLIC_IP_DETECTED=$(get_public_ip)
if [ -n "$PUBLIC_IP_DETECTED" ]; then
  if is_private_ip "$PUBLIC_IP_DETECTED"; then
    warn "探测到的是内网地址（$PUBLIC_IP_DETECTED），玩家可能无法直连；"
    warn "部署完成后可在 $MC_COMMANDER_DIR/.env 里改 PUBLIC_IP 为真实公网 IP"
  else
    log "公网 IP: $PUBLIC_IP_DETECTED（已写入 .env 的 PUBLIC_IP）"
  fi
else
  warn "未能探测到公网 IP；面板将按局域网地址展示，可在 .env 里手动设 PUBLIC_IP"
fi

# 6. 下载后端代码
# SKIP_DOWNLOAD=1：跳过下载、直接用安装目录里已有的代码（需 package.json + index.js）。
# 这是报错提示里承诺的出路——「手动放好代码再跑」必须真的能生效，
# 否则弱网用户下载反复失败后就没有任何自救手段（此前提示与实现矛盾）。
SKIP_DOWNLOAD="${SKIP_DOWNLOAD:-0}"
cd "$MC_COMMANDER_DIR"

if [ "$SKIP_DOWNLOAD" = "1" ]; then
  if [ -f "$MC_COMMANDER_DIR/package.json" ] && [ -f "$MC_COMMANDER_DIR/index.js" ]; then
    log "SKIP_DOWNLOAD=1 且已检测到代码（package.json + index.js），跳过下载"
  else
    err "SKIP_DOWNLOAD=1 但 $MC_COMMANDER_DIR 下没有可用的代码（缺 package.json 或 index.js）"
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

# 自动选路（仅默认源时）：先探测 GitHub 首个字节能否到达，不通则直接切 Gitee。
# 探测先于下载的理由：GitHub 的失败形态是「TCP 已建连但零字节」，直接进下载函数
# 要等满 60s 停滞检测才放弃；而探测实测 10s 内即超时，用户少等一分钟。
# 用户显式设过 PACKAGE_URL 时不介入（那是明确指定，尊重用户意图）。
if [ "$CUSTOM_PACKAGE_URL" -eq 0 ] && [ "$ALLOW_GITEE_FALLBACK" = "1" ]; then
  if source_reachable "$PACKAGE_URL"; then
    log "GitHub 源可达，使用：$PACKAGE_URL"
  elif use_gitee; then
    log "GitHub 源探测超时（${PROBE_TIMEOUT}s 内未收到数据），已自动改用 Gitee 镜像"
  else
    warn "GitHub 源探测超时，且 Gitee 也不可用，仍按 GitHub 重试"
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
  if [ "$CUSTOM_PACKAGE_URL" -eq 0 ] && [ "$ALLOW_GITEE_FALLBACK" = "1" ] && [ "$SOURCE" = "GitHub" ]; then
    warn "GitHub 源下载失败，改用 Gitee 镜像源重试"
    rm -f "$TMP_TGZ"
    if use_gitee && download_with_resume "$PACKAGE_URL" "$TMP_TGZ" "代码包（Gitee）"; then
      log "已通过 Gitee 镜像获取代码包"
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
  install_pkg coreutils
fi
if ! download_with_resume "$SHA256SUMS_URL" "$TMP_SUMS" "摘要文件"; then
  # 摘要单独失败时也试另一个源：摘要只是校验输入，下面的 sha256 比对是 fail-closed 的，
  # 故跨源取摘要不会降低安全性（对不上就中止），但能救「包下完了、摘要恰好没下来」。
  SUMS_OK=1
  if [ "$CUSTOM_PACKAGE_URL" -eq 0 ] && [ "$ALLOW_GITEE_FALLBACK" = "1" ] && [ "$SOURCE" = "GitHub" ]; then
    warn "GitHub 摘要文件下载失败，改用 Gitee 镜像源重试"
    rm -f "$TMP_SUMS"
    if use_gitee && download_with_resume "$SHA256SUMS_URL" "$TMP_SUMS" "摘要文件（Gitee）"; then
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
if [ ! -f "$TMP_EXTRACT/package.json" ]; then
  err "解压后未找到 package.json，代码包结构异常"
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
fi
# 复制代码到安装目录（首次部署与更新共用此逻辑）
# 注意：不会覆盖 .env（配置文件）、data/、servers/、backups/（运行时数据）、node_modules/（已安装依赖）
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
log "安装 npm 依赖..."
# 为 node-gyp 配置国内镜像源，避免从 nodejs.org 下载头文件超时
export npm_config_node_mirror="https://npmmirror.com/mirrors/node/"
npm install --omit=dev

# 9. 生成/读取 .env 配置（API Key 首次部署自动生成，更新时保留原有Key）
# .env 只落 API_KEY_HASH（SHA-256 摘要），明文仅在完成横幅一次性展示
# SETUP_TOKEN：首访设密所有权证明（audit S-P0-1 / #309）——仅首次部署生成；
# 更新部署不读取不再生成（一次性凭据，避免重复展示扩大暴露面；存量部署
# 需开启保护请手动向 .env 添加 SETUP_TOKEN 行后重启服务）
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
SERVERS_DIR=./servers
DATA_DIR=./data
BACKUPS_DIR=./backups
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
  # Key 掩码进日志（P2-10）：完整值仅在下方完成横幅一次性展示（交付通道），
  # 不进 log 长期留存；.env 只存摘要
  log "已生成 API Key: ${API_KEY:0:4}****（完整值见部署完成横幅）"
  log "已生成一次性 SETUP_TOKEN（首访设密时需粘贴，用后作废）"
else
  log ".env 已存在，保留现有 API_KEY_HASH（不重新生成）..."
fi

# 9.5 开放防火墙端口（25566）
SERVER_PORT=25566
log "开放防火墙端口 $SERVER_PORT ..."
if command -v ufw &>/dev/null; then
  ufw allow "$SERVER_PORT"/tcp >/dev/null 2>&1 && log "已通过 ufw 开放端口 $SERVER_PORT" || true
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port="$SERVER_PORT"/tcp >/dev/null 2>&1
  firewall-cmd --reload >/dev/null 2>&1
  log "已通过 firewalld 开放端口 $SERVER_PORT" || true
elif command -v iptables &>/dev/null; then
  iptables -I INPUT -p tcp --dport "$SERVER_PORT" -j ACCEPT >/dev/null 2>&1 || true
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
  fi
  # 安装目录/数据目录属主交给该用户（服务运行需要读写 data/、servers/、backups/）
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
# 只向面板主进程发停止信号，不波及同 cgroup 的 MC 实例——面板停机不停实例
# （owner 2026-09-09 拍板），实例由下次启动的 pid 文件接管。默认 control-group
# 会把实例一并 SIGTERM 杀掉，使该语义失效
KillMode=process
WorkingDirectory=$MC_COMMANDER_DIR
ExecStart=$(which node) index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable mc-commander
  # 面板停机不停实例（owner 2026-09-09 拍板）：重启后面板按 pid 文件接管运行态，
  # 但接管实例的控制台管道不可恢复——命令需 RCON，无 RCON 的实例只能强制终止
  if pgrep -f 'servers/.*/server\.jar' >/dev/null 2>&1; then
    warn "检测到运行中的 MC 实例：面板重启后将自动接管（运行态恢复，日志从接管时刻起）"
    warn "接管实例的命令需启用 RCON；未启用 RCON 的实例将只能强制终止"
  fi
  systemctl restart mc-commander
  log "已注册并启动 systemd 服务: mc-commander（以专用低权限用户 mc-commander 运行）"
elif command -v pm2 &>/dev/null; then
  # pm2 分支同样显式设置 NODE_ENV=production，使错误掩码/密钥校验等门控行为确定化
  NODE_ENV=production pm2 start index.js --name mc-commander
  pm2 save
  log "已通过 pm2 启动服务（NODE_ENV=production）"
else
  warn "未检测到 systemd/pm2，使用 nohup 后台运行（重启后需手动启动）"
  warn "当前将以 root 运行服务，建议改用 systemd 并配置专用低权限用户后重新启动"
  NODE_ENV=production nohup node index.js > "$MC_COMMANDER_DIR/server.log" 2>&1 &
  echo "$!" > "$MC_COMMANDER_DIR/server.pid"
  log "已通过 nohup 启动，PID: $(cat "$MC_COMMANDER_DIR/server.pid")"
fi

# 11. 等待服务就绪
log "等待服务启动..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:25566/health >/dev/null 2>&1; then
    log "服务已就绪（端口 25566）"
    break
  fi
  if [ "$i" -eq 30 ]; then
    warn "服务在 30 秒内未就绪，请检查日志：journalctl -u mc-commander -e 或 $MC_COMMANDER_DIR/server.log"
  fi
  sleep 1
done

# 12. 输出部署信息
# 公网 IP 在步骤 5.6 已探测并写入 .env（服务端优先读它，不再自行探测），此处复用同一个值
SERVER_IP="${PUBLIC_IP_DETECTED:-}"
if [ -z "$SERVER_IP" ]; then
  SERVER_IP="<请手动填入服务器公网IP>"
  IP_WARN=1
elif is_private_ip "$SERVER_IP"; then
  IP_WARN=1
else
  IP_WARN=0
fi

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║          MC_Commander  部署完成！                ║"
echo "╠═══════════════════════════════════════════════════╣"
echo "║                                                  ║"
printf "║   ► 服务器地址:  %-34s ║\n" "$SERVER_IP"
printf "║   ► 端口:        %-34s ║\n" "25566"
if [ -n "$API_KEY" ]; then
# Key 长 76 字符（32 字节 hex + 分组连字符），不再塞进右侧带边框的一行——会顶飞边框
echo "║   ► API Key（仅此一次显示，请立即保存；服务端只存摘要）："
echo "║     $API_KEY"
fi
if [ -n "$SETUP_TOKEN" ]; then
echo "║   ► SETUP_TOKEN（仅首次设密用：浏览器设密页粘贴，用后作废）："
echo "║     $SETUP_TOKEN"
echo "║                                                  ║"
fi
echo "║                                                  ║"
echo "║   ⚠ 端口已对外开放：建议在云安全组/防火墙限制来源  ║"
echo "║     IP，或经反向代理终止 TLS 后再对外暴露          ║"
echo "║                                                  ║"
if [ "$IP_WARN" -eq 1 ]; then
echo "║  ⚠ 以上地址为内网IP/未获取到，请在云服务器控制台 ║"
echo "║    查看公网IP并手动填入客户端                      ║"
echo "║                                                  ║"
fi
echo "║   请在客户端输入以上信息完成连接                    ║"
echo "║                                                  ║"
echo "╠═══════════════════════════════════════════════════╣"
if [ "$IP_WARN" -eq 0 ]; then
echo "║  健康检查:  http://$SERVER_IP:25566/health       ║"
else
echo "║  本地健康检查:  curl http://localhost:25566/health║"
fi
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
  echo "  cd $MC_COMMANDER_DIR && node index.js   # 手动启动"
  echo "  提示：建议以非 root 的专用系统用户运行服务，避免高权限运行"
fi
echo ""
