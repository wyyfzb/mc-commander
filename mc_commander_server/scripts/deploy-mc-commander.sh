#!/usr/bin/env bash
# MC_Commander 一键部署脚本
#
# 用法（远程两步命令，推荐先下载再执行，便于审查脚本内容）:
#   curl -fsSL -o /tmp/deploy-mc-commander.sh https://raw.githubusercontent.com/wyyfzb/mc-commander/main/mc_commander_server/scripts/deploy-mc-commander.sh
#   sudo bash /tmp/deploy-mc-commander.sh
#   （国内网络不畅时可改用 gitee 镜像同路径）
#
# 用法（本地执行）:
#   sudo bash deploy-mc-commander.sh
#
# 环境变量覆盖:
#   MC_COMMANDER_DIR=/opt/mc-commander  安装目录
#   BRANCH=v1.0.0                       发布标签/分支（默认锁定具体 tag，避免 master 可变分支被篡改；
#                                       显式覆盖为可变分支时，必须同时提供 PACKAGE_SHA256 完成完整性校验）
#   PACKAGE_URL=xxx                     后端代码包下载地址（tar.gz，默认 GitHub Release 固定标签；
#                                       国内网络可覆盖为 gitee 镜像同文件地址）
#   PACKAGE_SHA256=xxx                  预期代码包 sha256（自定义 PACKAGE_URL 时必填，用于覆盖内嵌默认值）
#   NODE_VERSION=v22.23.2               官方二进制兜底安装时固定的 Node.js LTS 版本号
#
# 安全说明：
#   - 代码包下载后强制校验 sha256（与内嵌预期值比对），校验失败立即中止并删除临时文件
#   - 不使用第三方 curl|bash 引导脚本；Node.js 优先发行版官方源，兜底用官方二进制包 + SHASUMS256.txt 校验
#   - systemd 服务以专用低权限用户 mc-commander 运行（25566 高位端口无需 root）
#
# 发布新版本时须同步更新（保证脚本与代码包版本一致）：
#   1) 推送新 tag → CI release.yml 自动构建并上传 mc-commander-server-<tag>.tar.gz
#   2) 下载该 Release 产物取 sha256 → 更新下方 EXPECTED_PACKAGE_SHA256
#   3) 提交脚本更新并推送（tag 产物内容不变，无需重打）
set -euo pipefail

# 禁止 apt/debconf 在安装过程中弹出交互式配置界面（如 needrestart 服务重启提示）
# 对非 Debian 系统无影响
export DEBIAN_FRONTEND=noninteractive
# 让 needrestart 自动重启使用旧库的服务，不再提示 "Which services should be restarted?"
export NEEDRESTART_MODE=a

MC_COMMANDER_DIR="${MC_COMMANDER_DIR:-/opt/mc-commander}"
# 默认锁定具体发布标签（vX.Y.Z），避免 master 可变分支被投毒/误覆盖后影响安装；
# 仍保留 BRANCH 环境变量覆盖（例如 BRANCH=master 或指定 commit），但可变分支场景必须配合 PACKAGE_SHA256
BRANCH="${BRANCH:-v1.0.0}"
# GitHub Release 资产为权威来源（CI 构建）；国内网络可通过 PACKAGE_URL 覆盖为 gitee 镜像
PACKAGE_URL="${PACKAGE_URL:-https://github.com/wyyfzb/mc-commander/releases/download/${BRANCH}/mc-commander-server-${BRANCH}.tar.gz}"
# 预期代码包 sha256（强制完整性校验，防篡改/防发布版本错配）。
# 当前值为本地构建参考值，发布新版本时必须按脚本头部注释流程同步更新；
# 自定义 PACKAGE_URL 时通过 PACKAGE_SHA256 环境变量提供对应文件的 sha256
EXPECTED_PACKAGE_SHA256="${PACKAGE_SHA256:-82193196194e514c2334dd8bb4949040682afe61c58f218419baef5ce0fccadf}"

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

# 2. 安装基础工具（curl、tar、rsync）
# 通过 Gitee raw 接口下载预打包的 tar.gz，绕过 archive 接口的人机验证和 git 认证拦截
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
  if ! curl -fsSL --connect-timeout 15 --retry 2 -o "$tmp_dir/SHASUMS256.txt" "$base/SHASUMS256.txt"; then
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
  if ! curl -fsSL --connect-timeout 15 --retry 2 -o "$tmp_dir/$file" "$base/$file"; then
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
# 使用 Gitee raw 文件接口下载预打包的 tar.gz，完全绕过：
#   - archive 接口的人机验证（验证码页面，返回 400/HTML）
#   - git clone HTTPS 的认证提示（云服务器 IP 被风控要求 Username）
# raw 接口支持匿名访问，脚本自身就是通过此接口下载的，已验证可靠
log "下载 MC_Commander 后端代码..."
TMP_TGZ="$MC_COMMANDER_DIR/.tmp_package.tar.gz"
TMP_EXTRACT="$MC_COMMANDER_DIR/.tmp_extract"
rm -rf "$TMP_TGZ" "$TMP_EXTRACT"
mkdir -p "$TMP_EXTRACT"
# 下载 tar.gz（-f 失败即退出，-S 显示错误，-L 跟随重定向，--connect-timeout 防止长时间挂起）
if ! curl -fSL --connect-timeout 15 --retry 2 -o "$TMP_TGZ" "$PACKAGE_URL"; then
  err "代码包下载失败：$PACKAGE_URL"
  err "请检查网络连接或手动指定 PACKAGE_URL 环境变量"
  err "也可以手动将后端代码解压到 $MC_COMMANDER_DIR 后重新运行此脚本"
  rm -rf "$TMP_TGZ" "$TMP_EXTRACT"
  exit 1
fi
# 校验文件类型：tar.gz (gzip) 魔术字节为 1f 8b
GZ_MAGIC=$(head -c 2 "$TMP_TGZ" 2>/dev/null | od -An -tx1 | tr -d ' \n')
if [ "$GZ_MAGIC" != "1f8b" ]; then
  err "下载的文件不是有效的 tar.gz 包（魔术字节: ${GZ_MAGIC:-空}）"
  err "可能是网络错误或文件不存在，请检查 URL："
  err "  $PACKAGE_URL"
  rm -rf "$TMP_TGZ" "$TMP_EXTRACT"
  exit 1
fi
# 完整性校验：下载文件的 sha256 必须与内嵌预期值一致（防篡改/防发布版本错配）。
# 校验失败立即中止并清理临时文件（fail-closed，绝不执行未经验证的代码）
if ! command -v sha256sum &>/dev/null; then
  install_pkg coreutils
fi
ACTUAL_SHA256=$(sha256sum "$TMP_TGZ" | awk '{print $1}')
if [ "$ACTUAL_SHA256" != "$EXPECTED_PACKAGE_SHA256" ]; then
  err "代码包 sha256 校验失败！"
  err "  预期: $EXPECTED_PACKAGE_SHA256"
  err "  实际: $ACTUAL_SHA256"
  err "下载文件可能已被篡改，或脚本与代码包版本不匹配（脚本未随新版本同步更新校验值）"
  err "已中止安装并删除临时文件。排查建议："
  err "  1. 使用官方发布包时，请从 master 分支重新获取最新部署脚本"
  err "  2. 自定义 PACKAGE_URL 安装时，请同时设置 PACKAGE_SHA256 环境变量"
  err "  3. 仍无法解决时，请先人工核实下载内容来源"
  rm -rf "$TMP_TGZ" "$TMP_EXTRACT"
  exit 1
fi
log "代码包 sha256 校验通过"
# 解压到临时目录
if ! tar -xzf "$TMP_TGZ" -C "$TMP_EXTRACT"; then
  err "解压失败，tar.gz 文件可能已损坏"
  rm -rf "$TMP_TGZ" "$TMP_EXTRACT"
  exit 1
fi
# 验证解压结果：必须存在 package.json（后端入口标识）
if [ ! -f "$TMP_EXTRACT/package.json" ]; then
  err "解压后未找到 package.json，代码包结构异常"
  rm -rf "$TMP_TGZ" "$TMP_EXTRACT"
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
rm -rf "$TMP_TGZ" "$TMP_EXTRACT"
log "代码下载完成"

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
if [ ! -f .env ]; then
  log "首次部署，生成 API Key 和 .env 配置文件..."
  API_KEY=$(openssl rand -hex 16)
  cat > .env <<EOF
API_KEY=$API_KEY
PORT=25566
SERVERS_DIR=./servers
DATA_DIR=./data
BACKUPS_DIR=./backups
LOG_LEVEL=info
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=100
EOF
  log "已生成 API Key: $API_KEY"
else
  log ".env 已存在，读取现有配置..."
  # 从已有 .env 中读取 API_KEY（支持 API_KEY=xxx 或 API Key: xxx 格式）
  API_KEY=$(grep -E '^API_KEY=' .env 2>/dev/null | cut -d= -f2 | tr -d ' "[:space:]')
  if [ -z "$API_KEY" ]; then
    API_KEY=$(grep -E '^API Key:' .env 2>/dev/null | cut -d: -f2 | tr -d ' "[:space:]')
  fi
  if [ -z "$API_KEY" ]; then
    warn "未能从 .env 中读取到 API_KEY，将重新生成"
    API_KEY=$(openssl rand -hex 16)
    sed -i "s/^API_KEY=.*/API_KEY=$API_KEY/" .env 2>/dev/null || echo "API_KEY=$API_KEY" >> .env
  else
    log "已读取现有 API Key: ${API_KEY:0:4}****"
  fi
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
# 生产模式：启用 NODE_ENV 门控行为（严格错误掩码、弱密钥校验等），避免环境不一致
Environment=NODE_ENV=production
WorkingDirectory=$MC_COMMANDER_DIR
ExecStart=$(which node) index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable mc-commander
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
printf "║   ► API Key:     %-34s ║\n" "$API_KEY"
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
