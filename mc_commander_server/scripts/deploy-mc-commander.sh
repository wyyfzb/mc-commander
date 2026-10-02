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

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "[WARN] $*"; }
err()  { echo "[ERROR] $*" >&2; }

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
# 下载 tar.gz（-f 失败即退出，-L 跟随重定向；停滞检测与续传见 download_with_resume）
if ! download_with_resume "$PACKAGE_URL" "$TMP_TGZ" "代码包"; then
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
      err "从最新发布版下载代码包失败（多次重试且已续传）。"
      err "可能原因：网络到 GitHub 不稳定，或该版本尚无 $ASSET_NAME 产物。"
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
  err "SHA256SUMS.txt 下载失败：$SHA256SUMS_URL"
  err "自定义 PACKAGE_URL 时请同时设置 SHA256SUMS_URL，否则无从校验完整性"
  rm -rf "$TMP_TGZ" "$TMP_SUMS" "$TMP_EXTRACT"
  exit 1
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
# 获取公网 IP，按优先级尝试多个服务（国内+国外），增加超时防止卡住
# 最终 fallback 从所有网卡 IP 中筛选出非私有地址
get_public_ip() {
  local ip=""
  # 公网 IP 查询服务（设置短超时，失败立即尝试下一个）
  # 国内优先
  ip=$(curl -sf --connect-timeout 3 https://myip.ipip.net 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://ip.sb 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://ifconfig.me 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://icanhazip.com 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://api.ipify.org 2>/dev/null) && echo "$ip" && return
  ip=$(curl -sf --connect-timeout 3 https://ident.me 2>/dev/null) && echo "$ip" && return
  # 云厂商元数据 API（腾讯云/阿里云，需 -k 跳过自签名证书）
  ip=$(curl -sf --connect-timeout 2 https://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null) && echo "$ip" && return
  ip=$(curl -sfk --connect-timeout 2 https://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null) && echo "$ip" && return
  # 从本地网卡 IP 中筛选：排除私有地址段，取第一个公网 IP
  # 排除: 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, 0.x, 224-255.x
  ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -vE '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|169\.254\.|0\.|2[2-5][0-9]\.)' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1)
  echo "$ip"
}
SERVER_IP=$(get_public_ip)
# 判断是否为私有/内网 IP
is_private_ip() {
  echo "$1" | grep -qE '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|169\.254\.|0\.)'
}
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
