# 架构说明

MC_Commander 由两部分组成：**服务端**（Node.js，部署在 Minecraft 服务器所在机器）与
**Web 前端**（SPA，由服务端同源托管）。服主在浏览器中完成全部管理操作，
无需在 Minecraft 服务端安装任何插件。

两端的接口契约由共享包 `mc-schemas/`（zod）单一维护：前端经 vite alias 直读其 `src`，
服务端经 `file:` 链接消费其构建产物 `dist`——因此改 `src` 后必须重建并一并提交 `dist`。

```
┌─────────────┐  HTTPS/WSS   ┌──────────────────────┐   RCON / HTTP   ┌──────────────┐
│   浏览器     │ ───────────▶ │  mc_commander_server  │ ──────────────▶ │ Minecraft 服务端│
│  (PWA 可装)  │ ◀─────────── │  Express + WebSocket  │ ◀────────────── │ (vanilla/纸鸢等) │
└─────────────┘   事件广播     └──────────────────────┘                 └──────────────┘
                                    │ 文件系统
                                    ▼
                        servers/<实例>/  data/  backups/
```

## 服务端（mc_commander_server/）

- **入口**：`index.js`（Express + ws），同源托管 `public/` 下的前端产物
- **认证**：双通道 —— 管理员会话（`Authorization: Bearer`，面板默认路径）与全局 API Key
  （`X-API-Key` 头，脚本/集成），+ 双级速率限制（见 SECURITY.md 信任模型）
- **实例管理**：`services/mc_server.js` —— 子进程生命周期（spawn/崩溃检测/自动重启）、
  RCON 双向通道（命令下发 + 响应读取）、日志/性能指标采集、旧版与 26.x 新版
  目录结构兼容（如 `world_gen_settings.dat` 拆分）
- **部署**：`routes/server-jar.js` —— PaperMC API 拉取版本清单/下载 jar（进度事件）、
  首启 eula/properties 生成、Forge installServer 支持
- **备份**：`services/backup.service.js` —— 目录快照 + 硬链接增量
  （rsync `--link-dest`，Windows 降级 robocopy）
- **定时任务**：`services/task_scheduler.js`（croner）—— 5 类任务 + 临时封禁到期轮询
- **数据**：better-sqlite3（实例/备份/计划任务/封禁记录），schema 迁移见 `db/database.js`
- **实时**：`websocket.js` —— 事件广播（目录与分类见契约包 `WS_EVENT_TYPES` / `WS_EVENT_KINDS`）、
  断线补齐、心跳保活、背压保护

## Web 前端（mc_manager_web/）

- **技术栈**：React 19 + TypeScript strict + Vite + Tailwind v4（`--mcs-*` 设计 token 体系）+
  shadcn-ui + TanStack Query（服务端状态）+ zustand（客户端状态）
- **结构**：feature-based —— `src/features/<域>/`（players/instances/world/files/tasks/
  settings/dashboard/onboarding/plugins/webhooks/audit/auth），跨域复用下沉
  `src/lib/`、`src/components/mcs/`
- **通信**：REST（`src/api/`）+ WebSocket 优先、HTTP 轮询保底降级
- **测试**：vitest + @testing-library + msw（单测 141 文件）；Playwright e2e 12 spec
  （mock 后端 + dev server 双 webServer 自启）。（文件数为 v0.2.1 时点，仅示意规模）

## 实时事件：状态与事件的分类口径

WebSocket 事件分两类，**新加事件必须在 `@mc-commander/schemas` 的 `WS_EVENT_KINDS` 里落一格**
（自愈路径在同包的 `WS_STATE_RECOVERY`，完整性由该包测试守住）：

- **状态（`state`）**：此刻的值（进度、运行态、读数）。晚订阅者**必须能直接读到**，
  否则界面上是「这一块根本不存在」，而不是「少了一条通知」。
- **事件（`event`）**：发生过的瞬间事实（玩家进出、备份完成）。可丢、可重放，
  丢一条只是少一条记录。

状态的三种自愈路径（判据：晚订阅者在有限时间内拿到当前值）：

| 路径 | 做法 | 例 |
| --- | --- | --- |
| `snapshot` | 服务端保留在途值，订阅/登记时补发 | 运行态、部署/升级进度、世界格式升级 |
| `poll` | 前端按 REST 轮询权威状态 | 备份/还原进度 |
| `cadence` | 通道本身按固定周期重发 | 主机读数（15s） |
| `none` | **已声明缺口**（读代码确认无上述路径） | 性能读数、天气、玩家读数 |

两条配套约定：

1. **不要用补发「事件」去恢复「状态」**。补一条 `started` 会同时篡改事实（把开始时间说成现在）
   并给客户端一个只能由边沿创建的载体（界面上那一行的挂载点）。
2. **状态快照里的字段要能区分「空闲」与「未知」**：对象＝在途、`null`＝确认空闲（客户端清残留）、
   **字段缺席＝未知**（保持现状）。少了后两者的区分，「服务端没告诉我」会被读成「没有升级」，
   把正在跑的进度条抹掉。字段还要**按角色裁剪**——快照是只读连接也能收的。

事件的落库面是 `NOTIFICATION_EVENT_TYPES`（断线补齐用），只收 `event` 类；服务端与前端都从契约包取，
不各存一份。

## 版本兼容策略

Minecraft 新旧版本在目录结构（数据包拆分）、NBT 字段、命令行为上差异较大。
服务端在读档类逻辑（世界种子、统计数据、玩家数据）集中处理版本分支；
排查 MC 命令类问题时应优先怀疑版本差异，且不假设服务端装有 EssentialsX 等插件。
