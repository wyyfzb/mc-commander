# MC_Commander Server

自托管 Minecraft 服务器管理 API。

**版本**: 1.1.0

## 功能特性

- **多实例管理** — 启动/停止/重启 MC 服务器
- **一键部署** — 支持 Vanilla/Paper/Fabric/Forge/Purpur，自动下载+Java 检测+首次启动配置
- **RCON 命令** — 基于 rcon-client，串行队列、持久连接、超时处理，命令失败短语解析（防前端假成功）
- **WebSocket 实时推送** — 19 种事件类型（含部署进度），Subprotocol 鉴权；**通知事件落库 + lastEventId 断线补齐**（断线/重启期间事件不丢）、心跳保活（30s ping 清理死连接）、广播背压保护、批量死亡事件 5s 窗口聚合（团灭只广播一条）
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
curl -fsSL https://gitee.com/wyyfzb/mc_commander/raw/master/mc_commander_server/scripts/deploy-mc-commander.sh | sudo bash
```

脚本会自动安装 Java 17/21/25 / Node.js 22+、下载代码、生成 API Key、注册 systemd 服务并启动。

### 手动部署

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，设置 API_KEY（必填）

# 启动服务
npm start
```

服务端默认运行在 `http://localhost:25566`

## 环境变量

参见根目录 README。

## API 文档

### 认证

所有请求通过 Header 携带 API Key：

```
X-API-Key: your-api-key
```

WebSocket 通过 Subprotocol 鉴权：`mc-commander-apikey.your-api-key`

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

**事件**（共 19 种）:

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
| `deployProgress` | 部署进度 | MC 实例部署期间（下载/配置/首次启动）；进度节流 ≥1% 才发射 |
| `error` | 错误事件 | 异常情况 |

## 项目结构

```
mc_commander_server/
├── index.js              # 入口 (Express + WebSocketServer)
├── config.js             # 配置加载 (.env)
├── websocket.js          # WebSocket 事件广播（通知落库/断线补齐/心跳/背压保护）
├── routes/               # API 路由
│   ├── status.js         # 实例状态/属性/世界/日志
│   ├── server-jar.js     # MC 服务端部署（minecraft-core + got + Paper v3）
│   ├── players.js        # 玩家管理 + 封禁（临时封禁自实现 + 封禁记录合并）
│   ├── backups.js        # 备份管理
│   ├── tasks.js          # 定时任务
│   └── files.js          # 文件管理（二进制/编码防护 + 列表文件同步）
├── services/             # 业务逻辑
│   ├── mc_server.js      # MC 实例管理 + RCON（rcon-client，从 SQLite 加载；死亡事件聚合）
│   ├── backup.service.js # 备份操作（目录快照 + rsync/robocopy 增量）
│   └── task_scheduler.js # Cron 调度（croner）+ 临时封禁到期自动解封
├── middleware/            # 中间件
│   ├── auth.js           # API Key 认证
│   ├── cors.js           # CORS
│   ├── error_handler.js  # 错误处理 + 404
│   └── rate_limit.js     # 频率限制
├── db/                   # 数据库
│   ├── database.js       # SQLite 初始化（含 notification_events 通知事件表）
│   ├── instance.model.js # 实例模型（CRUD + JSON 迁移）
│   ├── backup.model.js   # 备份模型
│   ├── scheduled_task.model.js # 任务模型
│   └── ban.model.js      # 临时封禁模型（temp_bans 表）
└── utils/                # 工具
    ├── response.js       # 统一响应格式 + 错误码
    └── java-detector.js  # Java 版本检测（版本矩阵+回退）
```

## 测试

```bash
npm test        # vitest，422 个用例
npm run lint    # eslint
```

## 开发

```bash
npm run dev     # --watch 热重载
npm test        # vitest
```

## License

MIT
