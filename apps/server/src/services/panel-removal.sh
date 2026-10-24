#!/usr/bin/env bash
# 面板内「彻底删除」的实际执行体。
#
# 由面板经 sudo 触发一个 root 权限的一次性 systemd 单元运行，脱离面板进程生命周期：
# 在面板内部直接 rm -rf 会在删到一半时失去可执行文件与依赖树，留下半删状态。
#
# 部署时会被装到 /usr/local/lib/mc-commander/（root:root 0755）并要求单元只认那份副本：
# 安装目录整体属于面板账号，root 执行的脚本留在那儿等于面板可改 root 要跑的代码。
#
# 用法：panel-removal.sh --purge|--keep-data
#   --purge      删除程序与全部数据（实例、存档、备份）
#   --keep-data  只删程序，保留 var/servers、var/data、var/backups
set -uo pipefail

MODE="${1:-}"
# 安装目录：显式传入优先，未传时按脚本位置反推（脚本位于 <安装目录>/src/services/）。
# 可注入是必需的：按脚本位置反推在开发树里会把源码目录当成安装目录，
# 一次误跑就会删掉整个仓库。
if [ -n "${MC_COMMANDER_DIR:-}" ]; then
  INSTALL_DIR="${MC_COMMANDER_DIR}"
else
  INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
MANIFEST="$INSTALL_DIR/.install-manifest"
# 第三方软件源与密钥的合法落点：清单可被写坏，只有这几个目录下的文件允许删。
# 可注入是为了让用例在沙箱目录里验证同一条判定（生产环境不需要改它）
REPO_FILE_ROOTS="${REPO_FILE_ROOTS:-/etc/apt/sources.list.d /etc/yum.repos.d /usr/share/keyrings}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "[$(date '+%H:%M:%S')] [WARN] $*"; }

# 前缀匹配挡不住 <root>/../../etc/shadow，故显式拒绝上跳段
repo_file_allowed() {
  case "$1" in ''|*/../*|*/..|../*|..) return 1 ;; esac
  local root
  for root in $REPO_FILE_ROOTS; do
    case "$1" in "$root"/*) return 0 ;; esac
  done
  return 1
}

case "$MODE" in
  --purge|--keep-data) ;;
  *)
    echo "用法：$0 --purge|--keep-data" >&2
    exit 2
    ;;
esac

# 目录安全校验：宁可拒绝也不 rm -rf 一个危险路径
case "$INSTALL_DIR" in
  /|/usr|/usr/|/etc|/etc/|/var|/var/|/opt|/opt/|/home|/home/|/root|/root/|"")
    echo "拒绝在危险路径上执行删除：$INSTALL_DIR" >&2
    exit 1
    ;;
esac

# 源码树校验：安装目录或其任一祖先含 .git 说明这是开发检出，不是部署出来的安装。
# 对源码树执行删除会连带删掉未提交改动，且删完无法从安装清单回滚。
_probe="$INSTALL_DIR"
while [ -n "$_probe" ] && [ "$_probe" != "/" ]; do
  if [ -e "$_probe/.git" ]; then
    echo "拒绝在源码树中执行删除：$INSTALL_DIR 位于 git 检出内（$_probe）" >&2
    exit 1
  fi
  _probe="$(dirname "$_probe")"
done
unset _probe

log "开始清理（安装目录：$INSTALL_DIR，模式：$MODE）"

# 1. 先停掉仍在运行的服务器实例。
#    实例是 detached 进程，不随面板服务停止：不停就会继续写存档，
#    而且它们以 mc-commander 用户运行，会让后面的 userdel 必然失败。
if [ -d "$INSTALL_DIR/var/servers" ]; then
  running=$(pgrep -f "$INSTALL_DIR/var/servers/.*server.jar" 2>/dev/null || true)
  if [ -n "$running" ]; then
    log "停止运行中的服务器实例..."
    echo "$running" | xargs -r kill 2>/dev/null || true
    # 给 JVM 时间把世界数据落盘；直接 SIGKILL 会留下写了一半的区块
    for _ in $(seq 1 20); do
      [ -z "$(pgrep -f "$INSTALL_DIR/var/servers/.*server.jar" 2>/dev/null || true)" ] && break
      sleep 1
    done
    pgrep -f "$INSTALL_DIR/var/servers/.*server.jar" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  fi
fi

# 2. 收掉装包阶段留在临时目录里的安装清单残件。
#    清单内容是「这台机器装了什么」，装完就没用了，留着既无用又暴露主机信息。
#    只按本项目的前缀收：同目录下别人的文件不能带走。
TMP_BASE="${TMPDIR:-/tmp}"
for f in "$TMP_BASE"/mc-commander-manifest.*; do
  [ -e "$f" ] || continue
  rm -f "$f" && log "  已清理临时清单 ${f##*/}"
done

# 3. 停服务并删单元。
#    先确认这个单元属于本次要删的安装目录：机器上可能有另一份安装（或开发树），
#    对着别人的单元 stop/rm 会停掉一个不该停的面板，而等它变 inactive 永远等不到。
UNIT=/etc/systemd/system/mc-commander.service
unit_belongs_here() {
  [ -f "$UNIT" ] || return 1
  grep -qF "$INSTALL_DIR" "$UNIT"
}

if command -v systemctl &>/dev/null && unit_belongs_here; then
  systemctl stop mc-commander 2>/dev/null || true
  # stop 是异步的：面板进程可能还在退出中，它占着 mc-commander 用户会让后面 userdel 失败。
  # 判定用 systemd 的单元状态而非 pgrep 命令行——本脚本路径里也含 src/，
  # 按命令行匹配会把脚本自己算成「面板仍在运行」，永远等不到退出。
  for _ in $(seq 1 30); do
    systemctl is-active --quiet mc-commander 2>/dev/null || break
    sleep 1
  done
  systemctl disable mc-commander 2>/dev/null || true
  # 三个单元一并删：面板本体 + 两个删除执行单元
  rm -f "$UNIT" \
        /etc/systemd/system/mc-commander-removal.service \
        /etc/systemd/system/mc-commander-removal-keep.service
  systemctl daemon-reload 2>/dev/null || true
  systemctl reset-failed mc-commander 2>/dev/null || true
  log "已移除 systemd 服务"
fi

# sudoers 白名单与本脚本的 root 副本都是本项目加的，一并撤掉
if [ -f /etc/sudoers.d/mc-commander ]; then
  rm -f /etc/sudoers.d/mc-commander
  log "已移除 sudoers 白名单"
fi
# 正在执行的就是这个副本：删掉它不影响已加载进内存的后续语句
rm -rf /usr/local/lib/mc-commander

# 4. 按安装清单回滚系统改动。
#    只动清单里记过的条目：用户机器原有的 Java/Node 不能碰（他别的程序要用）。
if [ -f "$MANIFEST" ]; then
  log "回滚安装时记录的系统改动..."

  while IFS=$'\t' read -r key value; do
    case "$key" in
      firewall-ufw)
        command -v ufw &>/dev/null && ufw delete allow "$value"/tcp >/dev/null 2>&1 &&
          log "  已撤销 ufw 规则 $value/tcp"
        ;;
      firewall-firewalld)
        if command -v firewall-cmd &>/dev/null; then
          firewall-cmd --permanent --remove-port="$value"/tcp >/dev/null 2>&1
          firewall-cmd --reload >/dev/null 2>&1
          log "  已撤销 firewalld 规则 $value/tcp"
        fi
        ;;
      firewall-iptables)
        command -v iptables &>/dev/null &&
          iptables -D INPUT -p tcp --dport "$value" -j ACCEPT >/dev/null 2>&1 &&
          log "  已撤销 iptables 规则 $value/tcp"
        ;;
      repo-file)
        # 清单是可写文件，值直接当 rm 入参等于给「清单被改过」开一个删任意文件的口子。
        # 只认软件源与密钥所在的那几个目录；按后缀放行挡不住 /tmp/x.list 这类越界路径。
        if repo_file_allowed "$value"; then
          [ -f "$value" ] && rm -f "$value" && log "  已移除软件源文件 ${value##*/}"
        else
          warn "  忽略清单外路径的软件源记录：${value:0:60}"
        fi
        ;;
    esac
  done < "$MANIFEST"

  # 系统包：只卸「装之前不存在」的那些
  # 清单在面板可写的安装目录内，包名拼成字符串再裸展开，一个空格就多出一个包管理器参数
  pkgs=()
  while IFS=$'\t' read -r key value; do
    [ "$key" = "pkg-installed" ] || continue
    # 以 - 开头的值会被当成选项，-o DPkg::Pre-Invoke::=<命令> 足以在本脚本的 root 权限下执行任意命令
    if [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9+._-]*$ ]]; then
      pkgs+=("$value")
    else
      # 截断再回显：清单可被写坏，原样回显一个超长值会把终端刷屏
      warn "  忽略非法包名：${value:0:40}"
    fi
  done < "$MANIFEST"
  if [ "${#pkgs[@]}" -gt 0 ]; then
    log "  卸载安装时新增的系统包：${pkgs[*]}"
    if command -v apt-get &>/dev/null; then
      apt-get remove -y --purge "${pkgs[@]}" >/dev/null 2>&1 ||
        warn "  部分系统包卸载失败，可手动执行：apt-get remove --purge ${pkgs[*]}"
    elif command -v dnf &>/dev/null; then
      dnf remove -y "${pkgs[@]}" >/dev/null 2>&1 || warn "  部分系统包卸载失败"
    elif command -v yum &>/dev/null; then
      yum remove -y "${pkgs[@]}" >/dev/null 2>&1 || warn "  部分系统包卸载失败"
    fi
  fi

  # Node 软链：只在它们指向本项目装的 /opt/node-* 时才删
  while IFS=$'\t' read -r key value; do
    if [ "$key" = "node-symlink" ]; then
      target=$(readlink -f "$value" 2>/dev/null || true)
      case "$target" in
        /opt/node-*) rm -f "$value" && log "  已移除软链 $value" ;;
      esac
    fi
  done < "$MANIFEST"
else
  warn "未找到安装清单，跳过系统包与防火墙回滚（无法判断哪些是本项目装的）"
fi

# 5. 删专用用户（单元以 root 运行，此时实例与面板都已停）
if id -u mc-commander &>/dev/null; then
  if userdel mc-commander 2>/dev/null; then
    log "已删除系统用户 mc-commander"
  else
    warn "未能删除用户 mc-commander（仍有进程占用）"
    warn "  查看占用：ps -u mc-commander"
    warn "  停掉后删：sudo pkill -u mc-commander && sudo userdel mc-commander"
  fi
fi

# 6. 删目录
if [ "$MODE" = "--purge" ]; then
  rm -rf "$INSTALL_DIR"
  log "已删除安装目录（含全部实例与存档）"
else
  for item in src public mc-schemas node_modules package.json package-lock.json .env .install-manifest; do
    rm -rf "${INSTALL_DIR:?}/$item"
  done
  kept=""
  for d in var/servers var/data var/backups; do
    if [ -d "$INSTALL_DIR/$d" ]; then
      n=$(find "$INSTALL_DIR/$d" -type f 2>/dev/null | wc -l)
      # 用 printf 拼而非 $'...'：后者在 bash 4.4 以下的命令替换里不展开
      [ "$n" -gt 0 ] && kept="$kept
  - $d/（$n 个文件）"
    fi
  done
  if [ -n "$kept" ]; then
    log "已保留以下数据在 $INSTALL_DIR："
    printf "%b\n" "$kept"
  else
    log "已保留数据目录（其中没有实例或备份文件）"
  fi
fi

log "清理完成"
