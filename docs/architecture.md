# 架构说明

MC_Commander 由两部分组成：**服务端**（Node.js，部署在 Minecraft 服务器所在机器）与
**Web 前端**（SPA，由服务端同源托管）。服主在浏览器中完成全部管理操作，
无需在 Minecraft 服务端安装任何插件。

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
- **认证**：全局 API Key（`X-API-Key` 头）+ 双级速率限制（见 SECURITY.md 信任模型）
- **实例管理**：`services/mc_server.js` —— 子进程生命周期（spawn/崩溃检测/自动重启）、
  RCON 双向通道（命令下发 + 响应读取）、日志/性能指标采集、旧版与 26.x 新版
  目录结构兼容（如 `world_gen_settings.dat` 拆分）
- **部署**：`routes/server-jar.js` —— PaperMC API 拉取版本清单/下载 jar（进度事件）、
  首启 eula/properties 生成、Forge installServer 支持
- **备份**：`services/backup.service.js` —— 目录快照 + 硬链接增量
  （rsync `--link-dest`，Windows 降级 robocopy）
- **定时任务**：`services/task_scheduler.js`（croner）—— 5 类任务 + 临时封禁到期轮询
- **数据**：better-sqlite3（实例/备份/计划任务/封禁记录），schema 迁移见 `db/database.js`
- **实时**：`websocket.js` —— 32 种事件广播、断线补齐、心跳保活、背压保护

## Web 前端（mc_manager_web/）

- **技术栈**：React 19 + TypeScript strict + Vite + Tailwind v4（`--mcs-*` 设计 token 体系）+
  shadcn-ui + TanStack Query（服务端状态）+ zustand（客户端状态）
- **结构**：feature-based —— `src/features/<域>/`（players/instances/world/files/tasks/
  settings/dashboard/onboarding/emergency），跨域复用下沉 `src/lib/`、`src/components/mcs/`
- **通信**：REST（`src/api/`）+ WebSocket 优先、HTTP 轮询保底降级
- **测试**：vitest + @testing-library + msw（单测 54 文件）；Playwright e2e 10 spec
  （mock 后端 + dev server 双 webServer 自启）

## 版本兼容策略

Minecraft 新旧版本在目录结构（数据包拆分）、NBT 字段、命令行为上差异较大。
服务端在读档类逻辑（世界种子、统计数据、玩家数据）集中处理版本分支；
排查 MC 命令类问题时应优先怀疑版本差异，且不假设服务端装有 EssentialsX 等插件。
