#!/usr/bin/env bash
#
# 离机副本示例脚本：从 MC_Commander 拉取实例备份到本机（本机 = 面板之外的另一台机器/NAS）
#
# 用途：面板的备份默认与实例数据同盘，磁盘或主机损毁时两者一起没。本脚本让外部机器
# 定期「拉取」副本，把容灾落到本机之外——而不是让面板往外推（面板没有 push 通道）。
#
# 依赖：bash、curl、jq、tar。
#
# ── 为什么硬依赖 jq ──────────────────────────────────────────────────────
#   曾用 grep/sed 解析 JSON，实测会**静默漏掉**备份：「name/description 里出现 `}`」
#   就会截断记录（样本 `"name":"weird } name"` 直接吞掉整条）。容灾脚本最坏的缺陷
#   是「让人以为有离机副本、其实没有」，故宁可多一个依赖也不自己拼 JSON 抽取。
#
# ── 凭据（必读）──────────────────────────────────────────────────────────
#   `/backups/:id/download` 要求**管理员**凭据（只读凭据会 403）。
#   **不要把 Key 写进本文件或提交进仓库**，用环境变量传入：
#
#     export MCC_BASE_URL='http://192.0.2.10:25566'      # 面板地址（TEST-NET 示例值）
#     export MCC_API_KEY='mcck-…'                         # 管理员 Key
#     ./pull-backups.sh /srv/mc-offsite
#
#   会话 Bearer 令牌同样可用：把 MCC_API_KEY 换成 MCC_SESSION_TOKEN。
#
# ── 定时 ────────────────────────────────────────────────────────────────
#   crontab 示例（每天 04:30）：
#     30 4 * * * MCC_BASE_URL=http://192.0.2.10:25566 MCC_API_KEY=... \
#       /opt/mc-commander/scripts/pull-backups.sh /srv/mc-offsite >>/var/log/mc-offsite.log 2>&1
#
# ── 安全边界（必读，见 SECURITY.md 与 docs/user-guide.md）────────────────
#   备份是**明文、未加密、未签名**的完整副本（含世界数据）。面板的安全假设是
#   「目录权限即数据边界」——副本离开本机后这条边界不再成立。请限制本机权限，
#   必要时在落地前自行加密（如 gpg 或加密卷）。
#
#   另注：面板自身的 SQLite 库与 .env 伴生副本有独立一套保留（落 backups/panel/，
#   **不**在实例备份列表里）。只拉实例备份的话，主机损毁后**面板配置与管理凭据
#   无法重建**，请一并对该目录做副本。
#
set -euo pipefail

DEST_DIR="${1:-}"
BASE_URL="${MCC_BASE_URL:-}"
API_KEY="${MCC_API_KEY:-}"
SESSION_TOKEN="${MCC_SESSION_TOKEN:-}"

die() { echo "错误：$*" >&2; exit 2; }

[[ -n "$DEST_DIR" ]] || die "用法：MCC_BASE_URL=... MCC_API_KEY=... $0 <本机目标目录>"
[[ -n "$BASE_URL" ]] || die "未设置 MCC_BASE_URL（例：http://192.0.2.10:25566）"
if [[ -z "$API_KEY" && -z "$SESSION_TOKEN" ]]; then
  die "未设置 MCC_API_KEY 或 MCC_SESSION_TOKEN（该端点要求管理员凭据）"
fi
for tool in curl jq tar; do
  command -v "$tool" >/dev/null 2>&1 || die "缺少 $tool"
done

BASE_URL="${BASE_URL%/}"          # 容忍结尾斜杠
mkdir -p "$DEST_DIR"

auth_args=()
if [[ -n "$API_KEY" ]]; then
  auth_args=(-H "X-API-Key: $API_KEY")
else
  auth_args=(-H "Authorization: Bearer $SESSION_TOKEN")
fi

api_get() {
  curl -fsS --max-time 30 "${auth_args[@]}" "$1"
}

echo "[$(date -Is)] 从 $BASE_URL 拉取备份到 $DEST_DIR"

instances_json="$(api_get "$BASE_URL/api/v1/instances")" \
  || die "取实例列表失败（检查地址与凭据）"

# 实例 id 逐个取出；jq 失败即报错退出（不静默当成「没有实例」）
instance_ids="$(printf '%s' "$instances_json" | jq -r '.data[].id')" \
  || die "解析实例列表失败（响应不是预期信封）"

if [[ -z "$instance_ids" ]]; then
  echo "没有实例，退出。"
  exit 0
fi

for iid in $instance_ids; do
  list_json="$(api_get "$BASE_URL/api/v1/instances/$iid/backups?page=1&pageSize=100")" || {
    echo "  跳过实例 $iid：取备份列表失败" >&2; continue;
  }
  # 只取 completed：creating/restoring 下载会被服务端 400 拒绝
  # IFS=$'\t' 读入时 status 会带上行尾换行，必须剥掉——否则等值比较恒不成立，
  # 表现是「一条都不下载」却只打印「跳过」（静默失效，正是本脚本最不能有的缺陷）
  while IFS=$'\t' read -r bid bstatus; do
    bid="${bid//[$'\r\n']/}"
    bstatus="${bstatus//[$'\r\n']/}"
    [[ -n "$bid" ]] || continue
    if [[ "$bstatus" != "completed" ]]; then
      echo "  跳过备份 $bid（status=$bstatus，仅 completed 可下载）"
      continue
    fi
    out="$DEST_DIR/backup-$bid.tar.gz"
    if [[ -s "$out" ]]; then
      echo "  已存在，跳过：$out"
      continue
    fi
    # 先落 .part 再改名：中断/半截传输不会被下一次运行误当成「已存在」
    tmp="$out.part"
    if curl -fsS --max-time 3600 "${auth_args[@]}" \
         -o "$tmp" "$BASE_URL/api/v1/backups/$bid/download"; then
      mv "$tmp" "$out"
      echo "  已拉取 $out（$(du -h "$out" | cut -f1)）"
    else
      rm -f "$tmp"
      echo "  拉取备份 $bid 失败" >&2
    fi
  done < <(printf '%s' "$list_json" | jq -r '.data[] | "\(.id)\t\(.status)"')
done

echo "[$(date -Is)] 完成。"
echo "提示：面板自身快照（SQLite + .env）在面板机的 backups/panel/ 下，请单独做副本。"
