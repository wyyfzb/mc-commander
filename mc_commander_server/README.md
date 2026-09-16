# MC_Commander Server

自托管 Minecraft 服务器管理 API。

**版本**: 1.2.1 <!-- x-release-please-version -->

## 功能特性

- **多实例管理** — 启动/停止/重启 MC 服务器
- **一键部署** — 支持 Vanilla/Paper/Fabric/Forge/Purpur，自动下载+Java 检测+首次启动配置
- **RCON 命令** — 基于 rcon-client，串行队列、持久连接、超时处理，命令失败短语解析（防前端假成功）
- **WebSocket 实时推送** — 32 种事件类型（含部署进度），Subprotocol 鉴权；**通知事件落库 + lastEventId 断线补齐**（断线/重启期间事件不丢）、心跳保活（30s ping 清理死连接）、广播背压保护、批量死亡事件 5s 窗口聚合（团灭只广播一条）
- **玩家管理** — OP/踢出/封禁/白名单 + 批量命令；**临时封禁自实现**（temp_bans 表 + 到期自动解封，不依赖插件）
- **封禁记录** — 合并临时封禁（temp_bans）与原版永久封禁（banned-players.json / banned-ips.json），去重展示
- **玩家洞察** — 物品栏/末影箱（NBT 解析）、成就/死亡/入睡事件、会话时间线、level.dat 读取（难度/出生点/天气，兼容 26.x 新旧格式）
- **日志系统** — 日志缓存、实时流推送、按级别过滤
- **server.properties 管理** — 读取/修改全部属性；**多端同步**（游戏内斜杠命令改属性 → 客户端同步；支持热改的属性保存后自动下发命令）
- **世界信息** — 世界配置、维度概览
- **备份系统** — **目录快照 + 增量传输**（Linux rsync `--link-dest` 硬链接快照：未变化文件零拷贝、变化文件整文件复制新 inode，region 文件天然适配；Windows rsync 优先、未安装时自动降级系统自带 robocopy `/MIR` 全量镜像）、**实例级备份**（世界+配置+插件全量，自动排除日志/加载器依赖/jar/pid，兼容 26.x 新布局与旧版 Bukkit 维度目录）、在线备份原子序列（save-off→save-all flush→save-on，RCON 不可用时运行中显式拒绝）、**恢复异步化**（202 立即返回 + restore 三事件 + 自动回滚 + level.dat 完整性校验 + jar 自动还原 + 恢复前快照预检，恢复为目录复制而非移动——mv 会污染硬链接快照链）、**自动清理**（数量/天数双上限，rm -rf 任意快照安全——硬链接引用计数自动回收）、磁盘预检、快照完整性校验、卡死记录自动恢复、SQLite 持久化（format 列区分快照/旧 zip）；**失败全程可见**（backupFailed/restoreFailed 携带中文原因，定时备份跳过发 backupSkipped 事件）；旧 zip 格式备份保留可删、恢复拒绝（无解压链路）
- **定时任务** — Cron 表达式（croner），支持重启/备份/命令/停止/启动
- **文件管理** — 文件浏览、在线编辑、路径遍历防护；**二进制检测拒绝**、UTF-8/GBK 编码识别与按原编码写回、BOM 保留、GBK 不可表示字符拒绝
- **列表文件同步** — 保存 banned-players/banned-ips/whitelist/ops.json 后自动对比差异并同步 MC 内存（pardon/ban/whitelist/deop/op 命令）
- **性能监控** — CPU/内存/TPS 采集，WebSocket 推送
- **实例持久化** — SQLite 存储实例元数据，支持从 JSON 自动迁移

## 快速开始

### 一键部署（推荐）

在目标 Linux 服务器上执行：

```bash
curl -fsSL -o /tmp/deploy-mc-commander.sh https://gitee.com/wyyfzb/mc-commander/raw/main/mc_commander_server/scripts/deploy-mc-commander.sh
sudo bash /tmp/deploy-mc-commander.sh
```

> gitee 镜像分支为 `main`（无 `master`）；国际网络可将域名替换为 `https://raw.githubusercontent.com/wyyfzb/mc-commander/main/...` 同路径。先下载脚本再执行，便于执行前审阅。

脚本会自动安装 Java 17/21/25 / Node.js 22+、下载代码、生成 API Key 与一次性 SETUP_TOKEN、注册 systemd 服务并启动（代码包下载带 sha256 强校验）。

### 手动部署

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，设置 API_KEY（必填）

# 构建 Web 前端并放进 public/（面板界面必需：public/index.html 不存在时
# 静态层整体不挂载，浏览器访问只有 404 JSON；目录可用 PUBLIC_DIR 覆盖）
(cd ../mc_manager_web && npm install && npm run build)
mkdir -p public
cp -r ../mc_manager_web/dist/. public/

# 启动服务
npm start
```

服务端默认运行在 `http://localhost:25566`

## 升级

### 一键部署：重跑脚本原地升级

部署脚本幂等，发布新版本后重新执行同一脚本即完成升级：

```bash
curl -fsSL -o /tmp/deploy-mc-commander.sh https://gitee.com/wyyfzb/mc-commander/raw/main/mc_commander_server/scripts/deploy-mc-commander.sh
sudo bash /tmp/deploy-mc-commander.sh
```

**升级时自动保留**（脚本同步代码但不覆盖以下内容）：

| 保留项 | 说明 |
|--------|------|
| `.env` | 配置与 API_KEY 沿用不重新生成（缺失时以 `.env.example` 为模板生成） |
| `data/` | SQLite 数据库与运行时数据 |
| `servers/` | MC 实例目录 |
| `backups/` | 备份快照 |
| `node_modules/` | 代码同步不覆盖已装依赖；随后 `npm install --omit=dev` 按新 package.json 增量更新 |

升级完成后自动 `systemctl restart mc-commander` 生效。

> SETUP_TOKEN 仅首次设密使用（一次性，设密成功即作废，升级流程无需配置）。如需重新开启设密保护，手动向 `.env` 添加 `SETUP_TOKEN` 行后重启服务。

### 回滚路径

脚本默认拉取固定标签的 Release 代码包。回滚到旧版本时将 `BRANCH` 指定为旧标签；可变分支/commit 场景必须配合 `PACKAGE_SHA256`：

```bash
sudo BRANCH=<旧版本标签> PACKAGE_SHA256=<该代码包 sha256> bash /tmp/deploy-mc-commander.sh
```

`.env`、`data/`、`servers/`、`backups/` 不受回滚影响（数据不回退，仅回退代码）。

### sha256 校验文件使用顺序

代码包下载后强制 sha256 校验，与预期值不一致立即中止并删除临时文件：

1. **默认 Release 产物**：预期 sha256 内嵌于脚本（`EXPECTED_PACKAGE_SHA256`），下载后自动比对，无需额外配置；发新版时按脚本头注释先取 Release 产物 sha256 更新该值
2. **自定义 `PACKAGE_URL`**：必须先取该文件的 sha256，通过 `PACKAGE_SHA256` 环境变量传入后再执行脚本（未提供则中止）

## 环境变量

参见根目录 README。新增只读机器凭据相关的两个变量（`.env.example` 有同款注释）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `READONLY_API_KEY_HASH` | 空 | 只读凭据的 SHA-256 摘要。**留空 = 该通道不存在**（fail-closed）。请用 `POST /api/v1/rotate-readonly-key` 生成，不要手写 |
| `READONLY_API_KEY_ENABLED` | `true` | 只读通道开关（`true`/`false`/`1`/`0`）。关闭后该凭据一律 403、轮换端点同样 403 且不写 `.env`；哈希保留，设回 `true` 即恢复。与 `API_KEY_ENABLED` 相互独立 |

## 日志

服务端日志经 `utils/logger.js` 统一收口，四级级别过滤：

| 级别 | 流向 | 说明 |
|------|------|------|
| `debug` | stdout | 开发排障细节 |
| `info` | stdout | 常规运行信息 |
| `warn` | stderr | 可恢复告警 |
| `error` | stderr + `data/logs/error.log` | 错误（独立分流落盘） |

- **级别控制**：`.env` 设置 `LOG_LEVEL`（`debug` / `info` / `warn` / `error`，默认 `info`），低于设定级别的日志不输出。
- **error 分流与轮转**：error 级别独立写入 `data/logs/error.log`；单文件 20MB，满后整体后移轮转为 `error.log.1` ~ `error.log.5`（最旧删除，磁盘占用上限约 100MB）。
- **启动横幅白名单**：版本/端口/目录等启动信息与 exit 前引导告警走 stderr 白名单，不受 `LOG_LEVEL` 过滤，任何级别下均可见。
- **每行格式**：`[ISO-8601 时间戳] [LEVEL] 消息`，占位符与多参数行为与 `console.*` 一致。

### systemd / journalctl 场景

服务由 systemd 托管时，stdout/stderr 自动进入 journal：

```bash
# 全部日志（stdout + stderr 合流，含启动横幅）
journalctl -u mc-commander -f

# 仅看告警与错误（warn/error 走 stderr，按优先级过滤）
journalctl -u mc-commander -p warning -f

# 本次启动的日志
journalctl -u mc-commander -b --no-pager
```

提示：error 除 journal 外仍落盘 `data/logs/error.log`（即 `DATA_DIR/logs/error.log`），便于 journal 轮转后回溯历史错误；`LOG_LEVEL` 默认 `info` 已含全部常规运行信息，无需另行配置日志文件。

## 忘记管理员密码

密码只以哈希落库、无法反解，也没有环境变量式重置开关（避免把重置能力留在 `.env` 里
长期暴露）。恢复方式是把管理员账号与会话清空，让面板回到首访设密流程：

```bash
# 1) 停止服务（systemd: systemctl stop mc-commander；否则先 Ctrl-C）

# 2) 清空管理员账号与会话（库文件默认 data/mc_commander.db，DATA_DIR 可改目录）
sqlite3 data/mc_commander.db "DELETE FROM admin_account; DELETE FROM admin_sessions;"

# 3) 重启服务，访问面板按首访向导重设密码
```

- 只删这两张表：实例、备份、定时任务、审计记录都不受影响。
- **会话必须一并清空**：直接改库不经过改密接口，已有令牌不会自动失效；留着等于旧令牌
  仍能登录。
- 配置了 `SETUP_TOKEN` 的部署（公网建议配置），重设密码时须先输入该令牌，见
  [SECURITY.md](../SECURITY.md) 的信任模型一节。
- 若机器上没有 `sqlite3`，用任意 SQLite 客户端打开同一文件执行同样两条语句即可。

## API 文档

### 认证

HTTP 提供两条通道，**管理员会话（Bearer）是面板的安全主线**：

```http
# 通道一：API Key（脚本 / 外部集成）
X-API-Key: your-api-key

# 通道二：管理员会话令牌（面板登录后自动携带；不再把明文 Key 存进浏览器）
Authorization: Bearer <session-token>
```

- **API Key**：按 `API_KEY_HASH` 校验（见上文部署口径），`POST /api/v1/rotate-key` 可轮换。
  设 `API_KEY_ENABLED=false` 可整体关闭该通道（HTTP 与 WebSocket 一律 403 并提示改用会话
  登录，`rotate-key` 同样 403 且**不写 `.env`**；`.env` 中的哈希保留不动，设回 `true` 即恢复。
  取值 `true`/`false`/`1`/`0`，大小写与首尾空格不敏感，其它取值启动即报错）。
  该 Key 是**单例全局凭据：无 scope、无过期、权限等同于管理员，且无条件绕过两步验证**
  （`middleware/auth.js` 的 API Key 分支直接放行，不要求 `totpCode`——刻意保住无人值守的
  自动化）。定位与操作纪律见 [SECURITY.md](../SECURITY.md) 的「API Key 的定位与信任模型」。
- **部署能力探测**：`GET /api/v1/auth/capabilities` 返回 `{ apiKeyEnabled }`（认证域内，
  未认证 401）。面板据此隐藏 `rotate-key` 入口；该开关是部署配置，未认证可达的
  `/auth/status` 不回传任何配置面。设置页以**面板地址**为键探测：地址停止输入后落定
  （约 300ms 防抖）才发请求，且表单未指明地址时（空串 = 同源默认值）**不发**——空地址探测会把
  同源 origin 误当成会话签发面板。响应不可判读、请求失败或 40103 一律按「未知」处理：入口保持
  可见（只有服务端明确返回 `apiKeyEnabled: false` 才隐藏），且探测**不改变本机登录态**。
- **管理员会话**：`POST /api/v1/auth/setup` 首次设置管理员密码，`POST /api/v1/auth/login`
  换取令牌，`PUT /api/v1/auth/password` 改密；令牌仅以 SHA-256 落库，滑动有效期默认 7 天
  （`ADMIN_SESSION_TTL_HOURS`），自创建起 30 天强制重登（`ADMIN_SESSION_ABSOLUTE_TTL_DAYS`）。
- **只读机器凭据**（`READONLY_API_KEY_HASH`，监控/仪表盘用）：同样走 `X-API-Key` 头，但角色为
  `readonly`，**只**能访问 5 个只读监控端点——`GET /api/v1/overview`、`/system-stats`、
  `/instances`、`/instances/:id`、`/instances/:id/players`；其余端点（含全部写操作与文件 /
  日志 / 配置 / 世界 / 玩家存档 / 备份 / 命令史 / 审计 / 会话 / 任务 / Webhook）一律
  403 `AUTH_INSUFFICIENT_ROLE`(40305)，WebSocket 握手一律拒绝。`GET /instances` 与
  `GET /instances/:id` 对只读**按角色裁剪**：响应不含 `jvmArgs`/`startCommand`
  （运维常把 JMX/DB 口令写进 JVM 参数）、`javaPath`、`seed`，监控所需字段照常返回；
  管理员响应不裁剪。

  ```bash
  # 生成 / 轮换（用管理员会话或全局 API Key 调用；明文只在响应里出现一次）
  curl -X POST http://127.0.0.1:25566/api/v1/rotate-readonly-key \
       -H "X-API-Key: <管理员 Key>"
  # → {"status":"ok", ..., "data":{"apiKey":"mcro-xxxxxxxx-xxxxxxxx-xxxxxxxx"}}

  # 只读调用
  curl http://127.0.0.1:25566/api/v1/overview -H "X-API-Key: mcro-..."
  ```

  轮换后旧只读 Key 立即失效；只读凭据调用轮换端点会 403（不能自我提权）。服务端把新摘要写进
  `.env` 的 `READONLY_API_KEY_HASH` 行（明文不落盘），其余键不动。**未配置 `READONLY_API_KEY_HASH`
  时该通道不存在**（携带任意值都按无效凭据 401）；`READONLY_API_KEY_ENABLED=false` 时请求侧
  403 `READONLY_API_KEY_DISABLED`(40304)、轮换端点同样 403 且不写 `.env`（哈希保留，设回 `true`
  即恢复）。该开关与 `API_KEY_ENABLED` 相互独立——只关全权 Key 的部署仍可单独保留只读监控凭据。
  **彻底关闭**：删除 `.env` 的 `READONLY_API_KEY_HASH` 行并重启。权限边界与操作纪律见
  [SECURITY.md](../SECURITY.md) 的「只读机器凭据」；需要敏感读时请改用管理员凭据。
- 两条通道都不可用时返回 401，错误信息同时提示两种凭据形态。

### 两步验证（TOTP）

可在设置中为管理员账号挂靠基于时间的一次性口令（RFC 6238：SHA-1 / 6 位 / 30 秒，
兼容 Google Authenticator、Authy、1Password 等）。挂靠与登录链路：

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/v1/auth/totp/status` | 状态：`{ enabled, confirmedAt, recoveryCodesRemaining }`（永不返回密钥与恢复码） |
| `POST` | `/api/v1/auth/totp/enroll` | 生成候选密钥与二维码（`secret` / `otpauthUrl` / `qrDataUrl`）；此时**尚未启用** |
| `POST` | `/api/v1/auth/totp/confirm` | 提交一次动态口令完成挂靠，返回 10 个一次性恢复码（**仅此一次**） |
| `POST` | `/api/v1/auth/totp/disable` | 关闭两步验证：须同时提交当前密码与第二因子（动态口令或一枚未用恢复码） |

- 启用后 `POST /api/v1/auth/login` 必须在 `password` 之外携带 `totpCode`（6 位动态口令或
  一枚恢复码）：未带时返回 `40105`（客户端据此显示输入框），校验失败返回 `40106` 并计入
  登录失败封禁（与密码失败共用计数）；任一步失败都不签发会话。
- 动态口令接受 ±1 个步长（±30s）的时钟漂移，且**同一个码不会被接受两次**（已接受的
  步长会被记录，任何不大于它的码一律拒绝）。
- 恢复码只以 SHA-256 摘要落库、用后即废，登录与关闭两步验证时均可使用；用尽或需要重新
  签发时，先关闭再重新挂靠即可。
- **挂靠成功（confirm）与关闭（disable）都会立即吊销其它会话**，只保留发起本次操作的会话：
  两步验证只拦新的登录，不吊销变更前创建的会话会让被窃会话绕过新因子。失败路径
  （动态口令错 / 密码错）不吊销任何会话。
- 密钥（`totp_secret`）与密码哈希同库明文存储：能读到库文件的攻击者本就能改管理员密码，
  本仓不为它单独引入加密密钥管理（取舍说明见 `routes/auth.js` 头部注释）。

WebSocket 经 Subprotocol 鉴权，与 HTTP 同源：`mc-commander-apikey.<key>`（API Key）
或 `mc-commander-session.<token>`（会话令牌）。

### 基础路径

所有 API 端点以 `/api/v1/` 为前缀。

### 响应格式

```json
// 成功
{ "status": "ok", "code": 0, "message": "Success", "data": {...}, "timestamp": "..." }

// 错误
{ "status": "error", "code": 50000, "message": "...", "details": null, "timestamp": "..." }
```

### 实例管理

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/v1/overview` | 面板概览（含系统总内存） |
| `GET` | `/api/v1/instances` | 实例列表 |
| `GET` | `/api/v1/instances/:id` | 实例详情 |
| `POST` | `/api/v1/instances/:id/start` | 启动实例 |
| `POST` | `/api/v1/instances/:id/stop` | 停止实例 |
| `POST` | `/api/v1/instances/:id/restart` | 重启实例 |
| `POST` | `/api/v1/instances/:id/command` | 发送命令 |
| `GET` | `/api/v1/instances/:id/logs` | 获取日志 |
| `GET` | `/api/v1/instances/:id/properties` | 获取 server.properties |
| `PUT` | `/api/v1/instances/:id/properties` | 更新 server.properties |
| `GET` | `/api/v1/instances/:id/world` | 世界信息 |

### 服务端部署

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/v1/server-jar/versions?type=` | 获取版本列表（type: vanilla/paper/fabric/forge/purpur） |
| `POST` | `/api/v1/server-jar/instances/deploy` | 一键部署 MC 实例（下载+配置+首次启动） |

**部署请求体**:
```json
{
  "type": "paper",
  "mcVersion": "1.21.4",
  "instanceName": "My Server",
  "maxMemory": "4G",
  "loaderVersion": "0.16.10"
}
```

**部署进度事件**（WebSocket `deployProgress` 事件）:
```json
{
  "stage": "download",
  "percent": 0.65,
  "transferred": 2048000,
  "total": 3150000
}
```

stage 取值：`download` / `download_complete` / `forge_install` / `first_launch` / `complete` / `error`

### 玩家管理

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/v1/instances/:id/players` | 玩家列表（在线+离线，含物品栏/统计/封禁状态） |
| `GET` | `/api/v1/instances/:id/players/bans` | 封禁记录（临时封禁 + 原版永久封禁合并去重） |
| `POST` | `/api/v1/instances/:id/players/:name/op` | OP 玩家 |
| `DELETE` | `/api/v1/instances/:id/players/:name/op` | 取消 OP |
| `POST` | `/api/v1/instances/:id/players/:name/kick` | 踢出玩家 |
| `POST` | `/api/v1/instances/:id/players/:name/ban` | 封禁玩家（body: reason/duration/ip，duration 支持 1h/12h/1d/7d/30d 临时封禁） |
| `POST` | `/api/v1/instances/:id/players/:name/pardon` | 解封玩家 |
| `POST` | `/api/v1/instances/:id/players/bans/:target/pardon` | 通用解封（body: targetType=player/ip） |
| `POST` | `/api/v1/instances/:id/players/:name/whitelist/add` | 添加白名单 |
| `DELETE` | `/api/v1/instances/:id/players/:name/whitelist` | 移除白名单 |

### 备份管理

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/v1/instances/:id/backups` | 备份列表（camelCase 契约：instanceId/worldName/createdAt/format） |
| `POST` | `/api/v1/instances/:id/backups` | 创建备份（异步执行，目录快照 + rsync/robocopy 增量；完成/失败经 WS 事件推送） |
| `POST` | `/api/v1/backups/:id/restore` | 恢复备份（**202 立即返回**，后台执行；互斥状态机：恢复中拒绝创建/删除/再次恢复；旧 zip 格式 40904 拒绝） |
| `DELETE` | `/api/v1/backups/:id` | 删除备份（异步，恢复中/备份中拒绝） |

> 备份 = `backups/<instanceId>/<名称>-<时间戳>/` 目录快照：Linux 用 `rsync -a --link-dest=<上一快照>` 硬链接增量（需安装 rsync，`apt-get install -y rsync`；实例目录与备份目录须同文件系统），Windows 优先 MSYS2 rsync、未安装时自动降级 robocopy `/MIR` 全量镜像。`size` 为快照逻辑大小（恢复所需容量）。改造前的 zip 备份 `format='zip'` 仅可删除。

**面板自身数据**（`data/mc_commander.db`）每日自动快照至 `backups/panel/`，保留策略与实例备份一致。
`.env` 不纳入自动备份（含认证凭据，且备份产物可经 API 下载），部署或改建后请手动复制一份留存。

面板库快照还原步骤：

1. 停止面板进程（运行中覆盖会导致 WAL 半写，还原后数据损坏）
2. 留存现场：把 `data/mc_commander.db` 及 `-wal` / `-shm` 残留移出 `data/`（勿覆盖旧快照目录）
3. 将 `backups/panel/` 中目标快照复制为 `data/mc_commander.db`
4. 确认 `data/` 下无 `-wal` / `-shm` 残留（有则删除——旧 WAL 与还原库不匹配）
5. 启动面板，验证登录与实例列表完整性
6. 确认无误后清理第 2 步留存的现场文件

> 快照还原的是**面板配置**；实例世界数据请用实例备份还原，两者相互独立。

### 定时任务

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/v1/tasks` | 所有定时任务 |
| `GET` | `/api/v1/instances/:id/tasks` | 实例的任务列表 |
| `POST` | `/api/v1/instances/:id/tasks` | 创建任务 |
| `PUT` | `/api/v1/tasks/:id` | 更新任务 |
| `DELETE` | `/api/v1/tasks/:id` | 删除任务 |
| `POST` | `/api/v1/tasks/:id/run` | 立即执行 |

### 文件管理

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/api/v1/instances/:id/files` | 列出文件/目录 |
| `GET` | `/api/v1/instances/:id/files/content` | 读取文件内容 |
| `PUT` | `/api/v1/instances/:id/files/content` | 写入文件内容 |
| `DELETE` | `/api/v1/instances/:id/files` | 删除文件/目录 |

### WebSocket

**连接**: `ws://host:25566/ws`，通过 Subprotocol 鉴权：`mc-commander-apikey.YOUR_API_KEY`

**订阅**（可携带 `lastEventId` 断线补齐，服务端重放其后遗漏的通知事件）:
```json
{"type": "subscribe", "instanceId": "your-instance-id"}
{"type": "subscribe", "instanceId": "your-instance-id", "lastEventId": 42}
```

**事件**（共 32 种）:

> 通知类事件（玩家/备份/任务）在广播前**落库**（`notification_events` 表）并携带自增 `id` 字段；客户端记录最后收到的 `id`，重连时通过 `lastEventId` 补齐断线期间事件。高频事件（log/status 快照/performance/weather）不落库。

| 事件 | 说明 | 触发条件 |
|------|------|----------|
| `log` | 服务器日志 | stdout/stderr 输出 |
| `status` | 状态变更 | 启动/停止/就绪/存档（跃迁子事件落库） |
| `performanceUpdate` | 性能数据 | CPU/内存/TPS，每 5 秒（已并入原 `tpsUpdate`，TPS 告警由客户端从此事件解析） |
| `weatherUpdate` | 天气/时间更新 | 每 10 秒（level.dat + RCON 实时） |
| `playerStatsUpdate` | 玩家状态 | 每 5 秒（血量/坐标/入睡，RCON 查询） |
| `playerJoin` | 玩家加入 | 玩家登录 |
| `playerLeave` | 玩家离开 | 玩家退出（含被动离开/被踢） |
| `playerDeath` | 玩家死亡 | 检测日志；**5s 窗口聚合**——单条为 `{name, cause, killer}`，批量（团灭）为 `{players: [...], count: N}` |
| `playerRespawn` | 玩家复活 | 检测日志 |
| `playerSleep` | 玩家入睡/起床 | RCON 状态变化 |
| `playerChat` | 玩家聊天 | 聊天消息 |
| `achievement` | 获得成就/完成挑战 | 检测日志 |
| `backupStart` | 备份开始 | 手动/定时备份 |
| `backupComplete` | 备份完成 | 备份成功（content 含名称+大小） |
| `backupFailed` | 备份失败 | 备份错误（content 含原因；setup/execution/save-on/scheduled 四来源统一结构） |
| `backupSkipped` | 定时备份跳过 | 触发时上一备份/恢复仍在进行（互斥命中） |
| `restoreStart` | 恢复开始 | 恢复异步化：后台执行开始 |
| `restoreComplete` | 恢复完成 | 恢复成功（提示启动服务器生效） |
| `restoreFailed` | 恢复失败 | 恢复失败（含原因；自动回滚已执行） |
| `taskExecute` | 定时任务执行 | Cron 触发（**不落库**：前端零消费，避免挤占断线补齐配额） |
| `taskFailed` | 定时任务失败 | 任务执行失败（command 异步失败/同步 throw/未知类型；**落库**：与 backupFailed 同语义，断线补齐可见） |
| `deployProgress` | 部署进度 | MC 实例部署期间（下载/配置/首次启动）；进度节流 ≥1% 才发射 |
| `error` | 错误事件 | 异常情况 |

## 项目结构

```
mc_commander_server/
├── index.js              # 入口 (Express + WebSocketServer)
├── config.js             # 配置加载 (.env)
├── websocket.js          # WebSocket 事件广播（通知落库/断线补齐/心跳/背压保护）
├── routes/               # API 路由（统一挂 /api/v1）
│   ├── index.js          # v1 路由装配
│   ├── status.js         # 实例状态/属性/世界/日志
│   ├── server-jar.js     # MC 服务端部署（minecraft-core + got + Paper v3）
│   ├── players.js        # 玩家管理 + 封禁（临时封禁自实现 + 封禁记录合并）
│   ├── plugins.js        # 插件管理 + Modrinth 市场（搜索/版本/一键安装/更新检测）
│   ├── backups.js        # 备份管理
│   ├── tasks.js          # 定时任务
│   ├── files.js          # 文件管理（二进制/编码防护 + 列表文件同步）
│   ├── webhooks.js       # Webhook CRUD + 事件类型
│   ├── audit.js          # 审计日志查询
│   ├── auth.js           # 管理员 setup/login/改密/会话状态（安全主线）
│   ├── keys.js           # API Key 轮换
│   └── upgrade.js        # 实例版本升级（P0-4）
├── services/             # 业务逻辑
│   ├── mc_server.js      # MC 实例管理 + RCON（rcon-client，从 SQLite 加载；死亡事件聚合）
│   ├── mc-server/        # 启动生命周期 / 输出解析 / 日志尾随 / 状态采集 / 世界数据
│   ├── backup.service.js # 备份操作（目录快照 + rsync/robocopy 增量）
│   ├── panel-backup.service.js # 面板自身数据备份（SQLite 在线快照）
│   ├── plugin.service.js # 插件扫描 / 启停 / 市场安装（feat-8）
│   ├── market.service.js # Modrinth 市场客户端
│   ├── instance-properties.service.js # server.properties 读写（issue 514）
│   ├── upgrade.service.js # 实例版本升级
│   ├── webhook.service.js # Webhook 投递（重试 + 投递日志）
│   └── task_scheduler.js # Cron 调度（croner）+ 临时封禁到期自动解封
├── middleware/           # 中间件
│   ├── auth.js           # 双通道认证（API Key / Bearer 会话）+ WS 子协议
│   ├── validate.js       # zod 请求校验（@mc-commander/schemas）
│   ├── static_serve.js   # 前端 dist 同源托管（含 SPA 深链接兜底）
│   ├── cors.js           # CORS
│   ├── error_handler.js  # 错误处理 + 404
│   └── rate_limit.js     # 频率限制
├── db/                   # 数据库
│   ├── database.js       # SQLite 初始化（含 notification_events 通知事件表）
│   ├── index.js          # 模型统一导出
│   ├── instance.model.js # 实例模型（CRUD + JSON 迁移）
│   ├── admin.model.js    # 管理员账号 + 会话模型（安全主线）
│   ├── backup.model.js   # 备份模型
│   ├── scheduled_task.model.js # 任务模型
│   ├── task_run_history.model.js # 任务执行历史（append-only）
│   ├── ban.model.js      # 临时封禁模型（temp_bans 表）
│   ├── audit.model.js    # 审计日志 + 命令历史模型（含保留清理）
│   └── webhook.model.js  # Webhook 模型（CRUD + 投递日志）
└── utils/                # 工具（全仓公共单一实现，勿另起副本）
    ├── response.js       # 统一响应格式 + 错误码
    ├── db-time.js        # SQLite 时间归一化（naive UTC 串 ↔ ISO / epoch）
    ├── java-detector.js  # Java 版本检测（版本矩阵 + 回退）
    ├── player-utils.js   # 玩家工具（离线 UUID 的唯一实现）
    ├── password.js       # 管理员密码哈希 / 定时安全比较
    ├── setup-token.js    # 首启一次性授权令牌（SETUP_TOKEN）
    ├── weak-key.js       # 弱 API Key 检测
    ├── url-guard.js      # URL SSRF 防护
    ├── fs-utils.js       # 原子写文件（tmp + rename）
    ├── jar-download-guard.js # JAR 下载完整性校验
    ├── command-mask.js   # 命令历史敏感参数脱敏
    ├── ban-reconcile.js  # 实例启动前 tempban 对账（banned-players.json ↔ DB）
    ├── audit.js          # 审计写入入口（AuditActions 词表）
    ├── pagination.js     # 分页参数解析（前端路由统一口径）
    ├── asyncHandler.js   # async 路由包装（统一错误捕获）
    ├── logger.js         # console 封装 + 文件日志 + 轮转
    └── version.js        # 版本号单一来源（package.json）
```

## 测试

```bash
npm test        # vitest 全量用例
npm run lint    # eslint
```

## 开发

```bash
npm run dev     # --watch 热重载
npm test        # vitest
```

## License

AGPL-3.0-or-later（见仓库根 [LICENSE](../LICENSE)）
