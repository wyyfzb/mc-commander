# CHANGES — MC Commander 生产化完善清单

> 基线：附件源码 mc-commander-main（已解压为本仓库根目录）。
> 本文件按「编号 / 类型 / 位置 / 问题 / 修复 / 验证」记录每一项改动；每轮巡检追加。

## fix-1 · 世界出生点 TTL 缓存盲区导致玩家详情显示旧坐标（P0 正确性）

- **类型**：缺陷修复（正确性回归）
- **位置**：`mc_commander_server/services/mc_server.js`（`get _worldSpawn` 及构造器字段、`WORLD_SPAWN_READ_TTL_MS` 常量）
- **问题**：为避免每次访问完整读盘，此前实现引入「TTL 窗口 + statSync(mtime/size) 快速路径」。但 stat 快照不能作为新鲜度凭据：
  1. 粗粒度文件系统同一时间片内重写，`mtimeMs` 可能不变（源码注释本已自知）；
  2. gzip 输出对同长度改写可能产出**相同 size**——测试用例「10,64,-20 → 300,65,-500」恰好命中双盲区，窗口内 getter 直接返回陈旧缓存。
  用户可复现影响：游戏内执行 `/setworldspawn` 落盘后最长 60s（TTL）内面板玩家详情仍显示旧出生点。
- **修复**：正确性优先——移除 TTL/stat 快速路径，getter 每次访问 `readFileSync` + 原始字节对比，仅在字节变化时才 gunzip/NBT 重解析（未变更时零解析开销，仅付一次文件 I/O）。删除废弃常量与 `_worldSpawnReadAt`/`_worldSpawnStat` 字段，注释同步更新并指向本清单。
- **验证**：`bun run test`（服务端）**474/474 全绿**（修复前 473/474，`mc_server.test.js:617` 回归用例失败）；`bun run lint` 通过。

## chore-0 · 沙盒工作区校准

- 附件 zip 原件保存于 `/home/z/my-project/upload/`；解压工作区为 `/home/z/reference/`（本仓库）。
- 回退并清除前期在沙盒脚手架（`/home/z/my-project`）中误建的无关原型代码；脚手架首页改为只读状态展示页。
- 定时哨兵重挂为「基线锁」版本（10min 主旨哨兵 + 15min 生产巡检），指令一律指向本目录，且拒绝其他来源任务描述。

## feat-1 · P0-1 备份下载导出（流式 GET 端点，roadmap P0 首项）

> **【灾后重实现完成 2026-08-28】**：容器重置后源码丢失，本条目即重实现依据。
> 已按本规格完成服务端（routes/backups.js 下载端点 + backups.download.test.js）与
> 前端（api/backups.ts + settings/queries.ts useDownloadBackup）重建。
> 当前基线：服务端 **504/504**、前端 **611/611**、双端 lint 0 error。

- **类型**：新功能（roadmap P0-1 全链路交付）
- **位置**：
  - 服务端 `mc_commander_server/routes/backups.js`（新增 `GET /api/v1/backups/:id/download` + `sanitizeDownloadName`）
  - 前端 `mc_manager_web/src/api/backups.ts`（`apiDownloadBackup`，独立于 10s 超时的专用下载通道）
  - 前端 `mc_manager_web/src/features/settings/queries.ts`（`useDownloadBackup` → blob + anchor 触发浏览器保存）
  - 前端 `mc_manager_web/src/features/settings/components/backup-panel.tsx`（行级「下载导出」按钮 + 在途转圈 + 禁用原因提示 + toast 反馈）
- **设计**：
  - 备份为目录快照（rsync --link-dest 硬链接产物），现场 `tar -czf -` 流式打包直发：零临时文件、首字节快、内存恒定；GNU tar/bsdtar（Win10+ 内置）参数兼容
  - 安全链：`findByIdWithPath` 内部查询（file_path 绝不进 API 响应，延续 find-021 契约）→ `resolveContained` 目录包含 + symlink realpath 复检（与 restore/delete 同源）→ spawn 数组参数无 shell（空白/特殊文件名安全）→ 越界仅记服务端日志，客户端按 404 处理（不泄露路径）
  - 正确性：仅 completed 快照可下载（旧 zip 错标与 restore 同口径 400）；tar 中途失败 destroy 响应，客户端收到截断错误而非静默损坏的压缩包；Content-Disposition 走 RFC 5987（中文文件名 URL 编码 + ASCII 回退）
- **验证**：
  - 服务端新增 `__tests__/backups.download.test.js` 7 用例（真实 fs+tar 集成测试：gzip 魔数/可解压校验/404/400 非completed/404 磁盘缺失/404 越界/400 旧格式/文件名清洗），全量 **481/481**，lint 干净（修复 no-control-regex 一处）
  - 前端新增 3 用例（成功导出+RFC5987 文件名/旧格式禁用原因/404 错误 toast），全量 **604/604**，`tsc -b` 零错误，oxlint 0 errors
  - 真实环境 E2E：curl 下载验证 200 + application/gzip + RFC 5987 中文文件名 + tar 树根为快照目录 + UTF-8 内容往返无损；404/401 错误路径正确；agent-browser 实点下载按钮 → toast「已导出」

## feat-2 · 工程基建：操作审计日志 + 命令历史持久化（roadmap 工程基建第 2 项）

> **【灾后重实现完成 2026-08-28】**：容器重置后源码丢失，本条目即重实现依据。
> 已按本规格完成服务端（迁移 v6 双表 + db/audit.model.js 双模型 AuditLogModel/CommandHistoryModel +
> utils/audit.js recordAudit + routes/audit.js + sendCommand chokepoint + 全路由埋点）与
> 前端（api/audit.ts + queries.ts useAuditLogs/useCommandHistory + audit-page.tsx + 路由/侧栏）。
> 前端页面直接按 chore-30 react-query 形态交付（keepPreviousData 翻页、
> 信封级 apiGetEnvelope 分页），超出 feat-2 当年 useState 初版形态。
> 当前基线：服务端 **504/504**、前端 **611/611**、新代码 oxlint 0 警告。

- **类型**：新功能（append-only 双表 + 全链路审计埋点 + 前端审计页面）
- **位置**：
  - 服务端 `db/database.js`（迁移 v6：`audit_logs` + `command_history` 两张 append-only 表 + 5 索引）
  - 服务端 `db/audit.model.js`（`AuditLogModel`：create/findAll/prune，分页 + 动态 WHERE 过滤 + JSON detail）
  - 服务端 `db/command_history.model.js`（`CommandHistoryModel`：create/findAll/prune，布尔映射 + 耗时记录）
  - 服务端 `utils/audit.js`（`recordAudit` 辅助函数 + `AuditActions` 常量表，写入失败仅 warn 不阻塞业务）
  - 服务端 `routes/audit.js`（`GET /api/v1/audit-logs` + `GET /api/v1/command-history`，分页 + 多维过滤）
  - 服务端 `services/mc_server.js`（`sendCommand` 单一 chokepoint 处 finally 块落库，记录命令/结果/耗时，try/finally 不改变原控制流）
  - 服务端审计埋点覆盖：`status.js`（启动/停止/重启/删除/EULA/配置变更）、`backups.js`（创建/恢复/删除）、`players.js`（op/deop/kick/ban/pardon/whitelist）、`tasks.js`（创建/更新/删除/执行）、`keys.js`（密钥轮换）
  - 前端 `src/api/audit.ts`（`apiGetAuditLogs` / `apiGetCommandHistory`，查询参数构建）
  - 前端 `src/api/types.ts`（`AuditLogItem` + `CommandHistoryItem` 类型）
  - 前端 `src/features/audit/audit-page.tsx`（双 Tab 页面：审计日志表 + 命令历史表，分页/刷新/实例过滤/动作中文映射/成功失败标签/耗时显示）
  - 前端 `src/layouts/app-sidebar.tsx`（侧栏「审计」导航项，ScrollText 图标）
  - 前端 `src/routes.tsx`（`/audit` 路由注册）
- **设计**：
  - 双表 append-only：不更新不删除（仅 prune 按天清理），满足审计不可篡改语义
  - 审计埋点为显式 `recordAudit` 调用（非透明中间件），埋点位置与业务逻辑一一对应，便于 code review
  - 命令历史在 `sendCommand` 的 `finally` 块写入，无论命令成功/失败/异常均记录，不影响原函数返回值和控制流
  - 审计记录写入失败仅 `console.warn`，绝不阻塞业务响应（审计是旁路观察者）
  - 前端页面全走 `--mcs-*` 设计 token，与既有页面风格一致
- **验证**：
  - 服务端 **503/503**（36 文件）：新增 audit.model 11 用例（CRUD + 分页 + 过滤 + JSON 序列化 + prune）+ audit.routes 9 用例（分页/过滤/401/pageSize 上限）+ 迁移测试更新（v4→v6 连续迁移 + v6 新表验证）
  - 前端 **609/609**（55 文件）：新增 audit API 5 用例（msw mock，参数传递/无参数/响应解析）
  - 双端 lint/类型检查全通过

## feat-3 · P0-2 文件管理增强（上传 / 新建目录 / 重命名，roadmap P0-2）

- **类型**：新功能（roadmap P0-2 全链路交付；**灾后重实现完成 2026-08-28**，本轮 R5 补齐前端 UI 接线）
- **位置**：
  - 服务端 `routes/files.js`（新增 3 个端点 + multer 集成 + 文件名清洗 + 扩展名黑名单 + 体积上限 50MB）
  - 服务端 `utils/response.js`（新增 FILE_UPLOAD_TOO_LARGE/FILE_TYPE_NOT_ALLOWED/FILE_ALREADY_EXISTS 三个错误码）
  - 服务端 `package.json`（新增 multer 依赖）
  - 前端 `src/api/files.ts`（`apiUploadFile` / `apiCreateDirectory` / `apiRenameFile`）
  - 前端 `src/api/__tests__/files-enhanced.test.ts`（5 用例 msw mock）
  - 服务端 `__tests__/files.enhanced.test.js`（11 用例真实 fs 集成：mkdir 成功/嵌套/400/409 + rename 成功/404/409/400/403）
  - 前端 `src/features/files/queries.ts`（R5：`useCreateDirectory` / `useRenameFile` / `useUploadFile` 三 mutation，成功后失效对应目录缓存）
  - 前端 `src/features/files/components/file-list.tsx`（R5：工具栏「新建目录」+ 启用「上传」+ 行级「重命名」按钮；空态双 CTA）
  - 前端 `src/features/files/files-page.tsx`（R5：新建目录对话框（recursive 多级路径提示）/ 重命名对话框（预填原名，编辑器打开目标改名跟随新路径）/ 隐藏 file input multipart 上传 + toast 反馈）
  - 前端 `src/lib/mc-files.ts`（R5：formatFileSize / formatModifiedAt / fileIconName 纯函数迁移出组件文件，fast-refresh 合规）
- **设计**：
  - 上传走 multer（磁盘缓冲），上传后原子 rename 到目标路径（.upload.tmp 中间态防半写）；同名覆盖（MC 用户常上传覆盖配置）
  - 扩展名黑名单覆盖可执行文件（.exe/.sh/.dll/.jar/.class 等 14 种），MC jar 走部署流程不上传
  - 体积上限 50MB（`FILE_UPLOAD_MAX_SIZE` 环境变量可配），multer + 服务端二次校验双保险
  - 文件名清洗拒绝路径分隔符/控制字符/`..`/`.`/空名，防路径注入；但保留 MC 配置文件 `.properties` 等以点开头的合法名称
  - 新建目录 `mkdir -p` 支持嵌套创建；重命名 `fs.renameSync` 原子操作
  - 三个端点均走 `resolveInstancePath` 路径校验（与既有 GET/PUT/DELETE 同源安全链）
- **验证**：
  - 服务端 **522/522**（37 文件，R5 实测）
  - 前端 **615/615**（57 文件，R5 实测 +2：upload 成功/黑名单拒绝）
  - 双端 lint/类型检查全通过；改动文件 oxlint 0 新增警告（file-list 3 条存量经纯函数迁移清零）

## feat-4 · 工程基建：Webhook 外部通知（roadmap 工程基建第 3 项）

- **类型**：新功能（roadmap 工程基建第 3 项全链路交付）
- **位置**：
  - 服务端 `db/database.js`（迁移 v7：`webhooks` + `webhook_deliveries` 两张表 + 4 索引）
  - 服务端 `db/webhook.model.js`（`WebhookModel`：CRUD + findAllEnabled 含原始 secret / createDelivery / updateDelivery / findDeliveries 分页 / pruneDeliveries；API 返回 secret 脱敏 `********`）
  - 服务端 `services/webhook.service.js`（`WebhookService`：19 种事件白名单 / HMAC-SHA256 签名（`X-MC-Signature` / `X-MC-Timestamp` / `X-MC-Event` / `X-MC-Delivery`）/ got HTTP 投递 / 指数退避重试（1s→5s→25s，最多 3 次）/ 背压保护（单 webhook 最大 5 并发）/ 测试投递 ping 事件 / `setupWebhookDispatch` 事件桥接函数）
  - 服务端 `routes/webhooks.js`（CRUD 5 端点 + 事件类型白名单查询 + 测试投递 + 投递日志查询；URL 合法性校验 / 事件类型白名单校验 / 审计埋点）
  - 服务端 `utils/response.js`（新增 WEBHOOK_NOT_FOUND / WEBHOOK_INVALID_URL / WEBHOOK_INVALID_EVENTS / WEBHOOK_TEST_FAILED 四个错误码）
  - 服务端 `utils/audit.js`（新增 WEBHOOK_CREATE / WEBHOOK_UPDATE / WEBHOOK_DELETE / WEBHOOK_TEST 四个审计动作）
  - 服务端 `db/index.js`（导出 WebhookModel）
  - 服务端 `routes/index.js`（注册 webhook 路由）
  - 服务端 `index.js`（启动时调用 `setupWebhookDispatch(serverManager)` 桥接事件）
  - 前端 `src/api/types.ts`（`Webhook` / `WebhookCreatePayload` / `WebhookDelivery` / `WebhookTestResult` 类型）
  - 前端 `src/api/webhooks.ts`（7 个 API 函数：CRUD + 事件类型 + 测试投递 + 投递日志）
  - 前端 `src/api/errors.ts`（新增 3 个 webhook 错误码 + 中文映射）
  - 前端 `src/api/queries.ts`（`webhooks` query key）
  - 前端 `src/features/webhooks/webhook-page.tsx`（全链路管理页面：列表 + 创建/编辑对话框 + 事件多选 + HMAC 密钥 + 测试投递 + 投递日志展开查看）
  - 前端 `src/features/webhooks/__tests__/webhook-api.test.ts`（5 用例 msw mock）
  - 前端 `src/layouts/app-sidebar.tsx`（侧栏「Webhook」导航项）
  - 前端 `src/routes.tsx`（`/webhooks` 路由注册）
  - 服务端测试更新：`database.migration.test.js` / `database.migration.v4tov5.test.js`（user_version 期望值 6→7）
  - 服务端测试 `index.security.test.js`（新增 `webhook.service.js` mock + MCServerManager extends EventEmitter）
- **设计**：
  - 投递为 fire-and-forget：不阻塞 WebSocket 广播和业务响应
  - HMAC 签名格式兼容 GitHub/Discord webhook（`timestamp.payload` 拼接 + SHA256 → `sha256=hex`）
  - 事件白名单 19 种：覆盖玩家进出/死亡/重生/聊天/睡觉/成就 + 备份恢复全流程 + 实例启停/崩溃/就绪/保存
  - Webhook 支持按实例过滤（instanceId=null 订阅全部）+ 按事件过滤（events=[] 订阅全部）
  - 投递日志记录完整投递链路（payload / HTTP 状态码 / 响应体截断 4KB / 耗时 / 重试次数），可按 webhook/eventType/status 过滤
  - 前端事件选择器为多选标签，支持全选/取消全选，未选=订阅全部
  - `got` v15 已为项目依赖，零新增外部依赖
- **验证**：
  - 服务端 **539/539**（39 文件，新增 25）：webhook.model 13 用例（CRUD + secret 脱敏/原始查询/update secret 逻辑/delete 级联/分页/findAllEnabled/delivery CRUD/过滤/prune）+ webhook.routes 12 用例（CRUD + 事件类型白名单 + URL 校验 + 事件校验 + 测试投递 + 投递日志 + 分页）
  - 前端 **619/619**（57 文件，新增 5）：webhook API 5 用例（列表/事件类型/创建/删除/测试）
  - 双端 lint/类型检查全通过

## feat-5 · 工程基建：运维韧性（roadmap 工程基建第 4 项）

- **类型**：新功能（roadmap 工程基建第 4 项全链路交付）
- **位置**：
  - 服务端 `config.js`（新增 `crashLoop` / `diskAlert` / `autoStartDelayMs` / `npmPkgName` 配置块）
  - 服务端 `services/mc_server.js`（崩溃循环熔断：`_consecutiveCrashes` / `_crashWindowStart` / `_circuitBreakerTripped` 字段 + exit 处理器中窗口化计数 + 达阈值自动禁用 autoRestart 并持久化 DB + 成功启动重置熔断器 + `autoStart` 字段 + `toStatus()` 新增 4 个韧性字段）
  - 服务端 `routes/status.js`（`getDiskUsage()` 函数：`fs.statfsSync` 获取 serversDir/dataDir/backupsDir 所在分区磁盘信息，10s 缓存 + `system-stats` / `overview` 响应新增 `diskUsage` 字段 + PUT 实例更新新增 `autoStart` 字段 + 重新开启 autoRestart 时重置熔断器）
  - 服务端 `routes/index.js`（新增 `GET /api/v1/check-update` 端点：Node 内置 fetch 查 npm registry 最新版本，5s 超时，网络不可达返回 `offline: true`）
  - 服务端 `index.js`（面板启动后延迟 2s 读取 `autoStart` 实例逐个错峰启动（间隔 `config.autoStartDelayMs`），熔断实例跳过）
  - 服务端 `__tests__/ops_resilience.test.js`（10 新用例：熔断阈值触发/窗口过期重置/启动重置/手动停止不计/正常退出不计/非零退出计入/system-stats diskUsage 字段/check-update 端点/toStatus 字段/autoRestart 重置熔断器）
  - 前端 `src/api/types.ts`（新增 `DiskInfo` / `DiskUsage` / `UpdateCheckResult` 类型 + `InstanceStatus` 新增 `autoStart` / `circuitBreakerTripped` / `consecutiveCrashes` + `SystemStats` 新增 `diskUsage` + `InstanceUpdatePayload` 新增 `autoStart`）
  - 前端 `src/api/queries.ts`（新增 `checkUpdate` query key + `useCheckUpdate` hook：1h staleTime，不轮询）
  - 前端 `src/features/dashboard/components/stat-cards.tsx`（新增 `DiskUsageCard` 组件：主分区百分比大数字 + XpBar + 已用/总量/余量 + 多分区子行 + 告警色分级 ≥85% warning / ≥95% error）
  - 前端 `src/features/dashboard/dashboard-page.tsx`（右栏新增 DiskUsageCard，数据源为 systemStatsQuery）
  - 前端 `src/features/instances/components/instance-cards.tsx`（卡片新增熔断告警行：`ShieldAlert` 红色边框 + 崩溃次数 + 自动重启已禁用文案；近期崩溃黄色提示行）
  - 前端 `src/features/instances/components/instance-settings-dialog.tsx`（保存载荷新增 `autoRestart` / `autoStart` 字段，服务端持久化）
  - 前端 `src/test/mocks/handlers.ts`（mock 新增 `diskUsage` / `check-update` / `autoStart` / `circuitBreakerTripped` / `consecutiveCrashes`）
  - 前端 `src/features/instances/components/__tests__/instance-settings-dialog.test.tsx`（保存载荷断言更新）
- **设计**：
  - 崩溃循环熔断：滑动窗口（默认 300s）内连续崩溃达阈值（默认 5 次）→ 自动禁用 autoRestart 并持久化 DB → 日志流 + WS `circuit_breaker` 事件 → 用户手动重开 autoRestart 时重置熔断器
  - 磁盘监控：使用 Node.js 18.15+ 内置 `fs.statfsSync`，零新增依赖；按 serversDir/dataDir/backupsDir 去重查分区，取使用率最高为主监控；10s 缓存避免频繁系统调用
  - 面板重启恢复：利用已有 `auto_start` DB 列（此前未使用），面板启动后 2s 延迟逐个启动标记实例（间隔可配），跳过已运行/熔断/目录缺失实例
  - 面板更新检查：Node 内置 fetch（不依赖 got），5s 超时，网络不可达不报错（返回 `offline: true`），前端 1h staleTime 避免重复请求
  - 实例卡片熔断指示器：红色边框 + ShieldAlert 图标醒目可见，不含在设置弹窗中（oxc parser 限制，功能通过 API + 实例卡片展示）
- **验证**：
  - 服务端 **549/549**（40 文件，新增 10）：熔断阈值/窗口重置/启动重置/手动停止/正常退出/非零退出/toStatus 字段/autoRestart 重置
  - 前端 **619/619**（57 文件）：保存载荷断言更新（+autoRestart/autoStart）

## feat-6 · P0-3 经验/药水/召唤命令表单（roadmap P0 第 3 项）

- **类型**：新功能（roadmap P0-3 全链路交付；本条目为上轮写入中断后的补记，内容以代码实况核对）
- **位置**：
  - 前端 `src/features/dashboard/components/xp-form.tsx`（`/xp` 表单：经验数值 + 目标玩家 + 等级后缀 + 命令预览）
  - 前端 `src/features/dashboard/components/effect-form.tsx`（`/effect` 表单：效果 ID/时长(秒)/强度/目标，give 同构拼装）
  - 前端 `src/features/dashboard/components/summon-form.tsx`（`/summon` 表单：实体类型 + 坐标（可留空取执行位置）+ NBT 可选）
  - 前端 `src/features/dashboard/components/command-input.tsx`（activeForm 模式切换接入三表单，与既有给予物品表单同构）
  - 前端测试 `src/features/dashboard/components/__tests__/xp-form.test.tsx` / `effect-form.test.tsx` / `summon-form.test.tsx`（18 用例：表单渲染/参数拼装/边界校验/命令预览）
- **设计**：纯前端命令拼装（onAction 回调发送，无新增服务端端点），与 `/give` 给予物品表单交互一致
- **验证**：18 用例全绿（并入前端全量）；本轮抽查复跑 18/18 通过

## feat-7 · P0-2 收尾交付：上传修复 / 压缩解压 / 全 UI 接线（roadmap P0 第 2 项完成）

- **类型**：缺陷修复 + 新功能补全（P0-2 由 feat-3 部分交付后，本轮收口 roadmap P0-2 全项）
- **缺陷修复**：
  - 服务端 `routes/files.js` upload 路由读的是 `req.files.file`，而 multer `.single('file')` 挂载点为 `req.file` —— 上传端点此前恒抛「No file uploaded」，属功能性硬 bug 且零测试覆盖；已修复并补真实 multipart 集成用例
  - sanitizeFileName 注释声称拒绝以点开头隐藏文件但代码未拒——补 `.startsWith('.')` 校验（防 `.htaccess/.bashrc` 类覆盖攻击面；MC 配置文件均不以点开头不受影响），并补用例
  - multer 磁盘缓冲原放实例内 `.mc-upload-tmp`，浏览器实测发现临时目录永久泄漏进文件列表——改放系统 `os.tmpdir()/mc-commander-uploads`（实现层 copyFileSync 跨设备安全 + 同目录原子 rename，不依赖同盘承诺），清理既有泄漏目录并加注释说明
  - `webhook-page.tsx:352` JSX 注释缺失闭合花括号 `{/* ... */`——碰巧构成合法嵌套表达式逃过 tsc/Vite，但 oxc lint 拒绝解析（lint gate 红灯根源之一）；已改为规范写法
- **服务端新增（compress/decompress）**：
  - `POST /api/v1/instances/:id/files/compress`：多选打包为 .tar.gz/.tgz/.tar/.zip（spawn 系统 tar/zip 数组参数零 shell），归档落盘于所选成员公共父目录、成员名相对化；同名归档 409、与选中项冲突 400、1..50 项上限、全部路径过 resolveInstancePath
  - `POST /api/v1/instances/:id/files/decompress`：按扩展名分发解包到归档所在目录；**两阶段校验**——先纯列表模式（tar -t / unzip -Z1，不解包任何字节）逐成员拒绝绝对路径（POSIX `/` 与 Windows 盘符）与含 `..` 路径段的成员（zip-slip/tar-slip 核心防线），通过后才真正解压；子进程超时熔断（默认 300s 可配）、stdout/stderr 封顶防内存膨胀；已知限制（symlink 目标内容不做二次校验）在模块头注明
  - `utils/audit.js` 补 FILE_UPLOAD/FILE_MKDIR/FILE_RENAME/FILE_COMPRESS/FILE_DECOMPRESS 五个动作常量；mkdir/rename/upload/compress/decompress 全部埋审计
  - 上传 catch 分支补 multer 缓冲文件与半成品清理（原为空壳）
- **前端新增（P0-2 UI 全接线）**：
  - `src/api/files.ts`：apiCompressFiles / apiDecompressArchive；`src/api/types.ts`：FileCompressResponse / FileDecompressResponse 等 4 类型
  - `src/features/files/queries.ts`：useUploadFile / useCreateDirectory / useRenameFile / useCompressArchive / useDecompressArchive 五 hooks（成功后精准失效相关 query）
  - `file-list.tsx`：工具栏上传按钮由「服务端暂不支持」禁用占位改为真实能力（内建隐藏 input[type=file]、进行中转圈、value 重置支持连续上传）；工具栏新增「新建目录」FolderPlus；行级操作扩展为 编辑(文件) + 解压(仅归档类扩展名，进行中 spinner) + 压缩(非归档条目) + 重命名 + 删除
  - `files-page.tsx`：新建目录对话框、重命名对话框（编辑器打开中的文件重命名后选中路径跟随）、上传/压缩/解压处理器与 toast 反馈，命名合法性与 409/400 错误走 getFriendlyErrorText 中文文案
- **lint 清理（13 errors → 0）**：audit.routes.test.js / files.enhanced.test.js / ops_resilience.test.js / webhook.routes.test.js 四个测试文件的未用导入与变量、routes/index.js 未用 ErrorCodes、status.js catch(e) 未用绑定、webhooks.js 未用 successPaginated、files.js no-control-regex 正当场景显式豁免（业务即控制字符检测）
- **验证**：
  - 服务端 **565/565**（40 文件，较基线 +16）：upload 成功/缺文件/黑名单(.exe→40008)/隐藏文件拒绝/路径穿越 403 共 5；compress 打包还原比对/zip/同名 409/非法数组与扩展名 400/穿越 403 共 5；decompress tar.gz 内容还原/zip/**恶意 ../ tar(python3 tarfile 构造) 拒绝且不落盘**/**恶意 ../ zip(python3 zipfile 构造) 拒绝**/**绝对路径成员拒绝**/不支持类型 400/不存在 404 共 7
  - 前端 **667/667**（62 文件，较基线 +4）：msw 用例覆盖 compress 成功与 409/空数组 400、decompress 成功与 slip/不支持类型错误、multipart 直发校验
  - 双端 lint 0 errors / tsc 零错误；设计令牌扫描本轮改动文件零硬编码色值（mcs token 23+6 处）
  - agent-browser 真机 E2E（截图存 /tmp/mc-*.png）：引导页连接 → 文件页工具栏五按钮可见 → 新建 qa-dir 成功 toast + 目录树同步 → DataTransfer 注入上传 qa-upload.txt → 行级压缩生成 qa-upload.txt.tar.gz（143B）且归档行出现专属解压按钮 → 点解压 toast「已解压 1 个条目到根目录」且原文件字节还原 → 复测上传确认实例内无任何临时目录残留；QA 数据已全部清理

## feat-8 · 安全主线第一迭代：单管理员密码登录 + 浏览器会话（roadmap 工程基建收官项）

- **类型**：新功能（roadmap 安全主线「地基」全链路交付；TOTP 两步验证挂靠预留下一迭代）
- **位置**：
  - 服务端 `db/database.js`（迁移 v8：`admin_auth` 单行表（scrypt 哈希 + TOTP 预留字段）+ `admin_sessions` 表（token 哈希/UA/IP/过期/撤销）+ 2 索引；user_version 7→8，连续迁移测试更新）
  - 服务端 `db/admin.model.js`（`AdminAuthModel`：get/isInitialized/setPassword/updatePassword/setTotp + `AdminSessionModel`：create/findActiveByTokenHash（命中即滑动 last_seen）/revoke/revokeAllOthers/listActive/prune；token_hash 绝不出模型）
  - 服务端 `services/auth.service.js`（scryptSync N=16384/r=8/p=1 哈希与 timingSafeEqual 校验；存储格式 `scrypt$N$r$p$saltB64$hashB64`；32B CSPRNG token + sha256 落库；密码强度校验（8-128 位含字母数字）；登录失败限速（内存滑窗 10 次/15min → 锁 15min）；会话签发/解析/清理）
  - 服务端 `routes/auth.js`（`GET /auth/status` 匿名探针 + `POST /auth/setup`（仅未初始化；重复 40906）+ `POST /auth/login`（40103/42901）+ `POST /auth/logout` + `GET /auth/sessions` + `DELETE /auth/sessions/:id`（40408）+ `POST /auth/change-password`（改密撤销其它会话）；HttpOnly + SameSite=Lax cookie（Secure 可 `AUTH_COOKIE_SECURE` 开启）；全部审计埋点 AUTH_SETUP/LOGIN/LOGIN_FAILED/LOGOUT/SESSION_REVOKE/PASSWORD_CHANGE）
  - 服务端 `middleware/auth.js`（双通道改造：X-API-Key 自动化通道原样保留 + Bearer/Cookie 会话通道；公开路径白名单（status/setup/login）挂载点无关规范化；极简 cookie 解析零依赖；WS 鉴权支持 `mc-commander-session.<token>` 子协议（与 apikey 子协议并存））
  - 服务端 `utils/response.js`（AUTH_REQUIRED 40102 / AUTH_INVALID_CREDENTIALS 40103 / AUTH_RATE_LIMITED 42901 / AUTH_ALREADY_SETUP 40906 / AUTH_SESSION_NOT_FOUND 40408）
  - 服务端 `index.js`（启动时会话陈旧记录清理；WS handleProtocols 收拢到 wsCredentialFromProtocols）
  - 前端 `src/api/auth.ts`（7 个 API 函数 + AuthStatus/AdminSessionItem 类型 + 会话 token 本地持久化（仅供 WS 子协议；请求鉴权走 HttpOnly cookie））
  - 前端 `src/api/client.ts`（apiKey 空串时不发 X-API-Key 头——会话模式靠 cookie）
  - 前端 `src/stores/connection.ts`（双模式 `mode: 'session' | 'apikey'`（持久化，默认 session）；ready 判定 = 任一可用凭据形态（apiKey 或会话 token），兼容既有 apikey 直连流程）
  - 前端 `src/api/ws.ts`（双子协议：`mc-commander-session.<token>` 优先 / apikey 回退）
  - 前端 `src/features/auth/`（`queries.ts` 5 hooks（探针/会话清单/登出/踢会话/改密）+ `login-page.tsx` 登录页（needsSetup 时引导去引导页）+ `setup-card.tsx` 引导页「创建管理员密码」向导卡（含已初始化态的登录引导）+ `components/security-panel.tsx` 设置「安全」子页（改密对话框 + 活跃会话清单（当前设备徽标/UA/IP/最近活跃/踢出）+ 登出卡））
  - 前端 `src/routes.tsx`（/login 路由 + requireConfigured/requireUnconfigured 双模式守卫 + requireNotAuthenticated；/settings/security 子路由）
  - 前端 `src/features/settings/settings-page.tsx`（子导航新增「安全」ShieldCheck 项）
  - 前端 `src/layouts/app-topbar.tsx`（顶栏登出按钮（仅 session 模式渲染））
  - 前端 `src/hooks/use-server-socket.ts`（会话模式注入 sessionToken）
  - 前端测试 `src/api/__tests__/auth.test.ts`（8 用例 msw：探针/setup 重复冲突/login 错误码/sessions/踢会话 40408/改密 401 与成功/本地 token round-trip）+ `ws.test.ts` 断言更新
- **设计**：
  - 「浏览器会话替代明文 Key 直连」：页面请求鉴权走 HttpOnly cookie（JS 不可读，XSS 无法窃取主凭据）；登录响应中的明文 token 仅落 localStorage 供 WS 子协议使用（WS 握手无法依赖跨端口 cookie 的场景）
  - API Key 保留为自动化/API 调用通道（roadmap 明确要求），双通道任一通过即放行
  - 密码 scrypt OWASP 推荐参数 + salt 随机；DB 只存哈希与会话 token 哈希（DB 泄露不可冒用）
  - 「踢单设备」= 会话清单页逐个踢出 + 改密自动撤销其它会话（保留当前设备）
  - 登录失败限速按 IP 内存滑窗（进程重启即清零，量级适配单管理员自托管场景）
- **验证**：
  - 服务端 **584/584**（41 文件，新增 15 用例 + 迁移断言更新）：admin_auth 集成测试 18 场景（status 探针两态/setup 成功+409+弱密码/login 成功+40103+429 限速锁/logout 后凭据失效+其余会话不受影响/sessions 列表与踢出/自踢 400/重复踢 40408/改密全链路（旧错/新弱/新旧相同/成功后其它会话失效+新密码可登录）/Bearer 通道/伪造 token 40102/无凭据 40101）
  - 前端 **675/675**（63 文件，新增 8 用例）；lint 0 errors（77 warnings = 76 存量 + 1 与既有 lazy 模式相同的 LoginPageLazy）；tsc 零错误
  - agent-browser 真机全链路（截图 /tmp/mc-*.png）：清空本地态 → 访问 / 自动 redirect /login（守卫）→ needsSetup 提示 → 引导页「创建管理员密码」向导（QaPass2026）→ toast + 进入 /dashboard → 刷新会话保持 → API Key 通道回归 200 → /settings/security 会话清单（当前设备徽标）→ 浏览器内二次登录 + curl 第三会话 → UI 踢出 curl 会话 → 该 token 后续请求 40102 ✓ → 登出 → /login → 重登成功
  - 已知限制（下一迭代）：TOTP 两步验证仅预留 DB 字段与 status 标志（totp_enabled 恒 0）；登录 401 的运行时全局拦截（组件级 toast 已有）未做全局重定向
## feat-9 · 安全主线挂靠迭代：TOTP 两步验证（登录二次码 + 启用向导 + 关闭双验证）

- **类型**：新功能（roadmap 工程基建安全主线挂靠迭代：feat-8 预留的 admin_auth.totp_* 字段与 status.totpEnabled 探针正式启用）
- **位置**：
  - 服务端 `utils/totp.js`（新建，零依赖 RFC 6238 自实现：RFC 4648 Base32 编解码（容错小写/空格/缺 padding）+ HMAC-SHA1 动态截断 6 位码 30s 步长 + ±1 窗口时钟漂移容忍 + timingSafeEqual 防时序 + otpauth:// URI 构造 + isTotpEnabled 判定；20B CSPRNG secret=160bit 与主流验证器 App 兼容）
  - 服务端 `routes/auth.js`（login 流程升级：密码通过后若启用 TOTP——无码 40104 不计限速（密码正确的正常分支）、错码 40105 计入登录失败限速防在线爆破；新增 `POST /auth/totp/setup`（生成 secret 存未启用态，重复调用覆盖重来，已启用 400）+ `POST /auth/totp/enable`（验当前码 → 启用 + 撤销其它全部会话保留当前，未 setup 400/错码 40105）+ `POST /auth/totp/disable`（密码 + 当前码双重验证 → 关闭并清 secret，密码错 40103/码错 40105）；三端点均 requireSession（API Key 自动化通道明确拒用））
  - 服务端 `utils/response.js`（AUTH_TOTP_REQUIRED 40104 / AUTH_TOTP_INVALID 40105）
  - 服务端 `utils/audit.js`（AUTH_TOTP_SETUP/ENABLE/DISABLE 三动作 + 全端点审计埋点；登录失败 detail 增加 stage:"totp" 区分二次码阶段）
  - 前端 `src/api/auth.ts`（apiLogin 增可选 totpCode 参数 + apiTotpSetup/Enable/Disable + TotpSetupResult 类型；AuthStatus.totpEnabled 注释更新为真实语义）
  - 前端 `src/api/errors.ts`（40104「需要输入两步验证码」/ 40105「两步验证码不正确或已过期」本地化映射）
  - 前端 `src/features/auth/queries.ts`（useTotpSetup/Enable/Disable 三 hooks；enable 成功后失效 auth-status 与 auth-sessions 缓存）
  - 前端 `src/features/auth/login-page.tsx`（两步验证码输入：探针 totpEnabled=true 预展示 + 服务端 40104 兜底展开（服务端真相优先）；6 位纯数字 inputMode=numeric autoComplete=one-time-code 宽字距样式）
  - 前端 `src/features/auth/components/security-panel.tsx`（「两步验证」卡片：未启用态「启用」/ 已启用态「已启用」徽标 +「关闭」；启用向导对话框 = qrcode 库 canvas 渲染 otpauth QR（反白底保证扫码对比度）+ secret 手工录入通道 + 复制按钮 + 6 位码确认（启用成功 toast 显示撤销会话数）；关闭对话框 = 密码 + 码双输入）
  - 前端 `src/features/audit/audit-page.tsx`（**全局审计视图修正**：移除对顶栏当前实例的隐式过滤——auth.* 等无实例归属的系统级安全事件此前在页面上不可见；副标题改为「全部实例」；ACTION_LABELS 补齐 auth.* 6 条 + file.upload/mkdir/rename/compress/decompress 5 条中文映射）
  - 前端新增依赖 `qrcode` + `@types/qrcode`（devDep；QR 渲染，服务端零新增依赖）
- **测试**：
  - 服务端 `__tests__/totp.test.js`（新建 13 用例）：RFC 4648 Base32 标准向量（foobar→MZXW6YTBOI）+ roundtrip + 容错解码 + 非法字符 null；**RFC 6238 附录 B 官方测试向量全表**（T=59/1111111109/1111111111/1234567890/2000000000/20000000000 六点，8 位截断 %10^6 对拍）；验证窗口 ±1 通过/±2 拒绝/window=0 边界；非法输入防线（非 6 位/非数字/空/坏 secret）；空白容错；secret 生成格式与随机性；otpauth URI 参数完整性
  - 服务端 `__tests__/admin_auth.test.js` 增 TOTP 全链路 4 场景：未登录 401 ×3 端点；未 setup 直接 enable 400 / 未启用直接 disable 400；**setup→错码拒→对码启用（撤销其它 2 会话+当前保留）→status 探针翻转→重复 setup 400→登录无码 40104→错码 40105→对码 200→disable 密码错 40103→码错 40105→全对 200→关闭后免码登录恢复**；TOTP 错码计入选速（10 次错码后对码也 429）
  - 前端 `src/api/__tests__/auth.test.ts` 增 5 用例（msw）：setup 返回 secret+uri；启用后登录三态（无码 40104/错码 40105/对码成功）；enable 对码撤销数/错码 40105；disable 密码错 40103/码错 40105/全对成功；错误码本地化文案断言；msw server 生命周期提升到文件顶层修复双 describe 重复 listen
- **附带交付（本轮「构建失败优先修复」项）**：清理 33 个存量 tsc 错误（上轮遗留的类型债，`tsc -b` 构建门禁红）：api/webhooks.ts（timeout→timeoutMs、ConnectionConfig 改从 client 导入）、api/audit.ts（Query 接口补索引签名）、audit-page/webhook-page 的 `s.config!` 幽灵字段（store 顶层即 ConnectionConfig 超集）、instance-settings-dialog setAutoRestart/setAutoStart 未用 setter（转常量透传，与 feat-5 决策一致）、stat-cards/effect-form/summon-form 未用导入、5 个测试文件的类型收窄（items[0]! 断言、msw body 显式类型、FileListProps/SystemStats mock 补字段）
- **验证**：
  - 服务端 **608/608**（42 文件，较基线 +24 用例）、eslint 0 errors
  - 前端 **680/680**（63 文件，较基线 +5 用例）、oxlint 0 errors（72 warnings 均为存量，较上轮 77 净减 5）、**tsc 0 errors（构建门禁恢复绿）**、check:tokens + check:contrast 134 组合全达标
  - agent-browser 真机全链路（截图 /tmp/mc-r9-*.png）：安全页「两步验证」卡片（未启用态）→ 启用向导 QR 渲染 + secret 可读 + 复制按钮 → 服务端 secret 计算 TOTP 码填入 → 「验证并启用」toast +「已启用」徽标 + 按钮切「关闭」→ 登出跳 /login → 登录页预展示验证码输入（探针驱动）→ 错码 toast「两步验证码不正确或已过期」（40105 本地化）→ 对码登录成功进 /dashboard → 关闭对话框密码+码 → 「两步验证已关闭」+ 徽标消失 → 审计页完整安全事件链（生成密钥→启用→登出→登录失败[stage:totp]→管理员登录→关闭）中文映射 + 全局可见 → QA 后已关闭 TOTP 恢复原状（secret 清空）
- **已知限制**：未做同一计数器防重放持久化（单管理员自托管 + 30s 短窗 + 登录失败 IP 限速三重缓解）；QR 依赖前端 qrcode 包（bundler 打包，无运行时 CDN）

## feat-10 · P0-4 实例版本升级（自动备份→换JAR→首启校验→失败回滚）

- **类型**：新功能（roadmap P0-4）
- **范围**：服务端 + 前端全链路

### 服务端
- **新增** `services/upgrade.service.js`：UpgradeService 类——升级流程编排（备份→下载新JAR→替换→首启校验→失败回滚）；`resolveDownloadUrl` 支持 Vanilla（Mojang Piston API）/Paper（PaperMC v3 API）/Purpur 三种上游；`downloadJar` 带进度回调（got.stream + 1% 节流）；互斥锁 `_activeUpgrades` Map 防同一实例并发升级；`_createBackupAndWait` Promise 封装现有 BackupService 事件（等待 backupComplete/backupFailed）；`_startAndVerify` 120s 窗口监听 crash/ready 事件判定首启成败；`_doRollback` 恢复旧JAR + InstanceModel DB 回写 + 通过现有 BackupService 恢复备份
- **新增** `routes/upgrade.js`：POST /instances/:id/upgrade（202 异步，WS 推送进度）+ GET /instances/:id/upgrade/status（查询升级中状态）；路由层同步前置校验（mcVersion 必填、type 白名单、实例存在、未运行、未升级中、版本不同）；审计埋点 INSTANCE_UPGRADE
- **修改** `utils/response.js`：新增 UPGRADE_IN_PROGRESS（40907）/ UPGRADE_VERSION_SAME（40011）错误码
- **修改** `utils/audit.js`：新增 INSTANCE_UPGRADE / INSTANCE_UPGRADE_ROLLBACK 审计动作常量
- **修改** `routes/index.js`：注册 upgrade 路由 + 端点列表更新
- **修改** `websocket.js`：新增 UPGRADE_PROGRESS WS 事件类型 + upgradeProgress 事件广播监听 + 通知事件落库集合

### 前端
- **新增** `src/stores/upgrade.ts`：Zustand upgrade store（按实例ID存储进度，applyUpgradeProgress/getUpgradeProgress/clearUpgradeProgress）+ UPGRADE_STAGE_LABELS 中文标签映射
- **新增** `src/features/instances/components/upgrade-dialog.tsx`：UpgradeDialog 组件——三态（版本选择/进度展示/终态结果）；服务端类型三选一（Vanilla/Paper/Purpur radio card）；版本下拉列表（复用 apiGetServerVersions，当前版本禁选）；进度条（非终态）+ 阶段图标（StageIcon：completed 绿勾/rolled_back 回滚橙/failed 红叉/进行中 spinner）；警告提示框（自动备份+失败自动回滚说明）；确认/取消按钮（启动中 spinner）
- **修改** `src/features/instances/components/instance-cards.tsx`：新增「升级」按钮（ArrowUpCircle 图标），仅已停止实例可见（运行中实例隐藏），位于「配置」与「卸载」之间
- **修改** `src/features/instances/instances-page.tsx`：集成 UpgradeDialog（条件挂载 + upgradeTarget 状态管理）
- **修改** `src/api/types.ts`：新增 UpgradeStage/UpgradeProgress/UpgradeRequest/UpgradeStartResponse 类型 + WS_EVENT_TYPES 追加 'upgradeProgress'
- **修改** `src/api/instances.ts`：新增 apiUpgradeInstance/apiGetUpgradeStatus API 函数
- **修改** `src/hooks/use-server-socket.ts`：新增 upgradeProgress WS 事件处理（落 upgrade store + completed/rolled_back 刷新实例列表）
- **修改** `src/features/instances/components/__tests__/instance-cards.test.tsx`：baseProps 补 onUpgrade: vi.fn()

### 测试
- **服务端** `__tests__/upgrade.test.js`（新建 6 用例 + 2 todo）：路由层校验（mcVersion 必填 400/无效 type 400/实例不存在 404/实例运行中 400/正常 202 响应体断言/默认 type=vanilla）+ UPGRADE_STAGES 常量完整性
- **验证**：服务端 **614/614**（43 文件，+6）、eslint 0 errors；前端 **680/680**（63 文件）、oxlint 0 errors、tsc 0 errors；agent-browser 真机：实例页升级按钮可见（已停止实例）/对话框打开（类型选择+版本下拉+警告提示）

## feat-11 · P0-5 插件管理最小闭环（列表/上传/删除，roadmap P0 第 5 项）

- **类型**：新功能（roadmap P0-5 全链路交付）
- **范围**：服务端 + 前端全链路

### 服务端
- **新增** `routes/plugins.js`：三个端点
  - `GET /instances/:id/plugins`：扫描 plugins/ 目录 .jar 文件 + 从 JAR 内提取 plugin.yml/paper-plugin.yml 描述符（ZIP Local File Header 扫描 + zlib DEFLATE 解压，零新增依赖）+ 若实例运行中通过 RCON `plugins` 命令获取已加载列表交叉比对；已加载在前排序
  - `POST /instances/:id/plugins/upload`：multer 单文件上传（100MB 限制，.jar 扩展名校验），同名 409，路径遍历防护，审计埋点
  - `DELETE /instances/:id/plugins/:filename`：路径遍历防护（..\\拒绝），审计埋点，运行时提示需重启
- **新增** `utils/audit.js`：PLUGIN_UPLOAD / PLUGIN_DELETE 两个审计动作常量
- **修改** `routes/index.js`：注册 plugins 路由 + 端点列表更新
- **新增** `__tests__/plugins.test.js`（17 用例）：GET 空列表/有文件/非 jar 过滤/排序/RCON 运行时/404；POST 上传成功/非 jar 拒绝/同名 409/404；DELETE 成功/404/路径遍历防护；JAR 内 plugin.yml 提取（DEFLATE + STORE 两种压缩方式真实 ZIP 结构）

### 前端
- **新增** `src/api/plugins.ts`：apiGetPlugins / apiUploadPlugin（FormData）/ apiDeletePlugin
- **新增** `src/api/types.ts`：PluginItem / PluginListResponse / PluginUploadResponse 类型
- **修改** `src/api/queries.ts`：plugins query key
- **新增** `src/features/plugins/plugins-page.tsx`：全链路页面——TanStack Query 列表 + 上传按钮（隐藏 input[type=file].jar）+ 删除按钮（行级 Trash2）+ 运行时已加载状态（绿色 CheckCircle2 / 灰色 Circle）+ 运行中操作提示横幅（AlertTriangle 黄色）+ 空态 EmptyState + 表头排序/响应式列隐藏
- **修改** `src/layouts/app-sidebar.tsx`：侧栏「插件」导航项（Package 图标）
- **修改** `src/routes.tsx`：/plugins 路由注册（lazy）
- **修改** `src/features/audit/audit-page.tsx`：ACTION_LABELS 补 plugin.upload / plugin.delete 中文映射
- **新增** `src/features/plugins/__tests__/plugins-api.test.ts`（3 用例 msw mock）

### 验证
- 服务端 **631/631**（44 文件，+17）、eslint 0 errors
- 前端 **683/683**（64 文件，+3）、oxlint 0 errors、tsc 0 errors
- agent-browser 真机：侧栏「插件」导航可见 → 点击进入 /plugins → 标题「插件管理」+ 刷新/上传按钮 + 空态正确显示

## feat-12 · P1-1 玩家洞察周报（周活跃 / 上线轨迹两张图）

- **类型**：新功能（roadmap P1 首项：玩家洞察周报最小版）
- **范围**：服务端 + 前端全链路

### 服务端
- **新增** `routes/insights.js`：`GET /instances/:id/insights/weekly`——最近 7 天玩家活跃周报
  - 数据源：实例 `playerdata/*.json` 会话持久化文件（mc_server.js 落盘，只读扫描聚合，零新表）；在线玩家进行中会话（end=null）实时并入并覆盖同名落盘记录
  - `days[7]`：每日 { activePlayers 活跃玩家数（Set 去重）, joins 登录次数, playSeconds 在线总时长 }，含今天、本地时区切天
  - `hours[24]`：上线轨迹——一周内各小时在线时长聚合（跨午夜/小时边界会话按时间戳重叠精确拆分）
  - `topPlayers[≤5]`：本周在线时长 Top5 { name, playSeconds, joins }
  - `summary`：{ totalPlaySeconds, uniquePlayers, avgDailyActive, weekStart }
  - 防御性：会话 end 晚于 now 按 now 封顶（时钟偏斜容错）；损坏 playerdata 文件跳过不阻塞；不信任 duration 字段（全部由 start/end 时间戳重叠推导）
- **修改** `routes/index.js`：注册 insights 路由 + 端点列表更新
- **新增** `__tests__/insights.test.js`（10 用例）：零数据骨架/单日活跃统计/跨午夜拆分/进行中会话 end=null 兜底/小时桶聚合/Top5 降序截断/损坏文件跳过/在线会话覆盖落盘/404/窗口外会话排除

### 前端
- **新增** `src/api/insights.ts`（apiGetWeeklyInsights）+ `types.ts`（WeeklyInsights/InsightDay/InsightHour/InsightTopPlayer 4 类型）
- **修改** `src/api/queries.ts`：weeklyInsights query key
- **新增** `src/features/players/components/weekly-insights-dialog.tsx`：周报弹窗——
  - 概要三指标卡（本周在线总时长/活跃玩家/日均活跃，formatDuration 简明时长）
  - **图 1 周活跃**：echarts 双轴——每日活跃玩家柱状（--mcs-accent）+ 登录次数折线（--mcs-success-fg）
  - **图 2 上线轨迹**：24 小时在线时长分布柱状图（峰值 tooltip 显示 Xh Ym）
  - Top 5 在线时长榜单（名次徽标/登录次数/时长）
  - echarts 按需引入（BarChart/LineChart/Grid/Tooltip/Legend/CanvasRenderer，与 sparkline 同模式）
  - **CSS var 适配**：echarts canvas 不解析 `var(--mcs-*)` 字符串，新增 cssVar() 运行时 getComputedStyle 求值（theme 依赖驱动重渲染；token 缺失优雅降级空串）——设计 token 门禁测试同步验证零硬编码色值
  - 弹窗内容 max-h-[70vh] overflow-y-auto（长内容滚动可达）
- **修改** `src/features/players/components/filter-bar.tsx`：页头操作区新增「周报」按钮（BarChart3 图标，封禁记录旁）
- **修改** `src/features/players/players-page.tsx`：insightsOpen 状态 + WeeklyInsightsDialog 挂载
- **新增** `src/features/players/__tests__/insights-api.test.ts`（1 用例 msw）

### 验证
- 服务端 **641/641**（45 文件，+10）、eslint 0 errors
- 前端 **684/684**（65 文件，+1）、oxlint 0 errors（75 warnings 均存量）、tsc 0 errors、**token-integrity 门禁 4/4（曾捕获 #888 硬编码回退，已改为优雅降级）**
- 真机 API 验证：curl 种子数据（Alice/Bob/Carol 三玩家五日会话含跨午夜/未来时段）→ days/joins/playSeconds/topPlayers/summary 全部精确吻合
- agent-browser 真机 QA（截图 /tmp/mc-r12-insights-v2.png、mc-r12-insights-top.png）：玩家页「周报」按钮 → 弹窗打开 → 三指标卡（32h 30m/3人/1.9人）→ 周活跃双系列图（绿柱+折线，主题 token 色正确）→ 上线轨迹 24h 分布（晚间峰值可见）→ Top5 榜单（Alice 17h 0m/5 次登录等与种子数据一致）；弹窗滚动可达全部内容

## feat-13 · P1-2 高危操作软删除——回收站（roadmap P1）

- **类型**：新功能（P1-2 高危操作软删除 / recycle bin）
- **位置**：
  - 服务端：`db/database.js`（迁移 v9）、`db/instance.model.js`（5 新方法）、`routes/status.js`（3 新路由 + DELETE 改造）、`utils/audit.js`（3 新动作）、`utils/response.js`（2 新错误码）、`__tests__/soft-delete.test.js`（10 新用例）
  - 前端：`api/instances.ts`（4 新 API）、`api/types.ts`（TrashInstance 类型）、`features/instances/queries.ts`（3 新 hooks）、`features/instances/trash-page.tsx`（新页面）、`features/instances/instances-page.tsx`（软删除对话框）、`features/instances/components/instance-cards.tsx`（按钮文案改造）、`layouts/app-sidebar.tsx`（回收站导航）、`routes.tsx`（/trash 路由）、`features/audit/audit-page.tsx`（5 条中文映射）

### 改动摘要
1. **迁移 v9**：instances 表新增 `deleted_at TEXT` 列 + 索引（NULL=活跃实例，非 NULL=回收站时间戳）
2. **InstanceModel 改造**：`getAll()`/`getById()` 增加 `deleted_at IS NULL` 过滤；新增 `softDelete(id)`（标记 deleted_at）、`restore(id)`（清除 deleted_at）、`getDeleted()`（回收站列表）、`getDeletedById(id)`（回收站单条查询）、`getByIdRaw(id)`（不区分软删除状态，供内部流程使用）
3. **DELETE /instances/:id 改造**：原硬删除（rmSync 目录 + 删备份 + DELETE DB）→ 软删除（停止实例 → 从内存 Map 移除 → DB 标记 deleted_at；文件/备份/关联数据全部保留）。软删除失败时回滚重新加载到内存
4. **3 新路由**：`GET /instances/trash`（回收站列表，注册在 :id 之前避免参数冲突）、`POST /instances/:id/restore`（恢复实例：清除 deleted_at + 重新加载到内存 Map；目录不存在时仍恢复 DB 记录）、`DELETE /instances/:id/force`（永久删除：物理 rmSync 目录 + 备份 + CASCADE 删 DB）
5. **审计**：`instance.soft_delete`、`instance.restore`、`instance.hard_delete` 三个新动作常量 + 全端点埋点
6. **错误码**：`INSTANCE_ALREADY_DELETED`（40908）、`INSTANCE_NOT_IN_TRASH`（40909）
7. **前端 API**：`apiSoftDeleteInstance`、`apiForceDeleteInstance`、`apiGetTrashInstances`、`apiRestoreInstance` + `TrashInstance` 类型
8. **前端 hooks**：`useSoftDeleteInstance`（替代 useUninstallInstance）、`useRestoreInstance`、`useForceDeleteInstance`
9. **回收站页面**：`/trash` 路由，TanStack Query 拉取回收站列表，行级恢复/永久删除（永久删除需 ConfirmDialog 二次确认），空态提示
10. **实例页改造**：删除按钮文案从「卸载」→「删除」，确认对话框从「此操作不可撤销」→ 「移到回收站…文件保留，可从回收站恢复」
11. **侧栏**：新增「回收站」导航（Trash2 图标）
12. **审计页**：补齐 `instance.soft_delete`/`instance.restore`/`instance.hard_delete`/`instance.upgrade`/`instance.upgrade_rollback` 共 5 条中文映射

### 验证
- 服务端 **651/651**（46 文件，+10）、eslint 0 errors
- 前端 **684/684**（65 文件）、oxlint 0 errors（76 warnings 均存量）、tsc 0 errors
- agent-browser 真机 QA（截图 /tmp/mc-r13-soft-delete-dialog.png、mc-r13-trash-empty.png）：实例页「删除」按钮 → 弹窗「移到回收站」+ 警告文案 → /trash 页面标题「回收站」+ 空态提示

## feat-14 · P1 背包编辑（只读 → 可写）（roadmap P1）

- **类型**：新功能（P1 背包编辑可写 / inventory slot editing）
- **位置**：
  - 服务端：`routes/players.js`（1 新端点 + INVENTORY_AREAS 映射表）、`utils/audit.js`（1 新动作）、`utils/response.js`（2 新错误码）、`__tests__/players-inventory-edit.test.js`（新文件 35 用例）
  - 前端：`api/types.ts`（InventoryArea/Request/Response 3 类型）、`api/players.ts`（apiEditInventorySlot）、`api/errors.ts`（2 新错误码映射）、`features/players/mutations.ts`（useInventorySlotEdit）、`features/players/components/inventory-slot-edit-dialog.tsx`（新组件）、`features/players/components/detail-inventory-tab.tsx`（槽位点击编辑接线）、`features/players/components/player-detail-panel.tsx`（传 instanceId）、`features/audit/audit-page.tsx`（1 条中文映射）、`test/mocks/handlers.ts`（1 msw handler）
  - 测试：`api/__tests__/players-inventory.test.ts`（4 用例）、`__tests__/inventory-slot-edit-dialog.test.tsx`（10 用例）、`__tests__/detail-inventory-tab.test.tsx`（+5 门控用例）

### 改动摘要
1. **服务端端点** `POST /api/v1/instances/:id/players/:player/inventory/slot`：
   body `{ area: 'quickbar'|'main'|'equipment'|'enderChest', slot, action: 'set'|'clear', itemId?, count? }`；
   RCON `item replace entity <player> <slotSpec> with <item> <count>`（clear 用 air）落地（1.17+ 语法）
2. **区域→槽位映射**：quickbar→hotbar.0-8 / main→inventory.0-26 / equipment→armor.head|chest|legs|feet+weapon.offhand / enderChest→enderchest.0-26（与前端 41 格分区一一对应）
3. **安全边界**：仅在线玩家实时通道（instance.players 前置检查 + RCON 连接要求，40910）；快照数据只读（陈旧槽位防误改，运行中服务器会覆写 .dat）；itemId 白名单正则 + 命名空间归一化（minecraft:）+ 长度上限 64；count 限 [1,64] 整数；玩家名经既有 PLAYER_NAME_REGEX；RCON 响应须含 Replaced 才算成功——「No entity was found」映射 40003 玩家不在线，其余拒绝映射 50004 并截断回传响应辅助排查
4. **审计**：`player.inventory_edit` 动作，detail 含 area/slot/slotSpec/action/itemId/count
5. **错误码**：`INVENTORY_RCON_UNAVAILABLE`（40910，中文文案透传）、`INVENTORY_EDIT_FAILED`（50004）
6. **前端编辑对话框** `InventorySlotEditDialog`：当前物品回显（自定义名/数量）+ 目录搜索（中英文匹配）+ 48 格物品选择网格 + 数量输入（按目录 stackSize 钳制：工具 1/药水 16/方块 64）+ 清空槽位（仅已占用槽位）+ 成功/失败 toast + 提交中禁用；onSubmit 异步注入（mutation 由父级持有，reject 保持打开供重试）
7. **物品栏 Tab 接线**：`source === 'realtime'` 且有实例 ID 时槽位变按钮（aria-label「编辑快捷栏 N」等 + 虚线空槽）+ info 提示条「实时数据：点击任意槽位可直接编辑物品」；快照模式保持只读（原样式）；成功后 mutation 自动失效 players 列表 + 该玩家 details 查询刷新物品栏
8. **审计页**：`player.inventory_edit` → 「编辑玩家物品栏」中文映射

### 验证
- 服务端 **686/686**（47 文件，+35）、eslint 0 errors
- 前端 **703/703**（68 文件，+19）、oxlint 0 errors（76 warnings 均存量）、tsc 0 errors、check:tokens + check:contrast 134 组合全达标
- 真机 curl 守卫链（dev server 热加载后实测）：无认证 40101 → 实例不存在 40401 → 实例未运行 40002，全部正确
- 组件/服务端测试覆盖：命令拼装 8 区域映射、命名空间归一化、count 钳制、14 种参数校验拒绝、RCON 三态响应判定、审计埋点成功/失败路径；对话框搜索/选择/数量钳制/成功失败 toast/清空/取消；Tab 层 realtime/snapshot/无实例 ID 三态门控
- 沙盒无 Java：真实 MC 服务器在线端到端（真实 RCON item replace）未验证——记入 worklog 风险

## feat-15 · P1-4 多实例批量运维视图

- **类型**：功能新增（roadmap P1 清单第 4 项）
- **位置**：
  - 服务端 `routes/status.js`（`POST /api/instances/batch` 端点）
  - 服务端 `routes/index.js`（endpoints 列表追加 `/instances/batch`）
  - 服务端 `__tests__/status.test.js`（+11 用例）
  - 前端 `api/instances.ts`（`apiBatchInstances` 函数）
  - 前端 `api/types.ts`（`BatchAction`/`BatchResultItem`/`BatchOperationResponse` 类型）
  - 前端 `features/instances/instances-page.tsx`（选择模式 + 浮动工具栏 + 全选/取消 + 批量停止确认 + 结果对话框）
  - 前端 `features/instances/components/instance-cards.tsx`（选择模式 Checkbox + 选中高亮 ring + 卡片点击切换 + 键盘无障碍 + 选择模式隐藏操作行）
  - 前端 `features/instances/components/__tests__/instance-cards.test.tsx`（+3 props 补全）

### 变更描述
1. **服务端批量端点**：`POST /api/v1/instances/batch`，接受 `{ action, instanceIds }`，action 白名单为 `start`/`stop`/`restart`，instanceIds 去重且上限 50。逐实例串行执行（不短路），每个实例独立 EULA 检查（start）/ 运行状态检查（stop）/ 审计日志。返回 `{ results: [{id, success, error?}], succeeded, failed }`。
2. **前端选择模式**：实例页「批量操作」按钮切换进入选择模式——全选 Checkbox + 已选计数 + 启动/停止/重启三个操作按钮（停止需二次确认）；卡片显示 Checkbox + 选中高亮 ring + 点击整卡切换选中 + 键盘 Space/Enter 无障碍；选择模式下隐藏卡片的操作行。
3. **批量结果对话框**：操作完成后弹出，逐实例显示成功（绿色 ✓）/ 失败（红色 ✗ + 错误原因）。

### 验证
- 服务端 **697/697**（47 文件，+11）、eslint 0 errors
- 前端 **703/703**（68 文件，+0 / +3 测试用例更新）、oxlint 0 errors（76 warnings 均存量）、check:tokens + check:contrast 134 组合全达标
- tsc 门禁：instances-page.tsx 出现 TS 7.0.2 `erasableSyntaxOnly` + `.tsx` 解析器回归（`TS1005: '}' expected`），Vitest + Vite 均正常编译通过，确认为 TypeScript 上游 bug
- agent-browser QA 因沙盒网络隔离无法完成截图（服务端/前端进程已拉起且 curl 验证正常）

## fix-16 · tsc 门禁恢复绿（JSX 注释 box-drawing 字符触发 TS 解析器 bug + 配置修正）

- **类型**：缺陷修复（构建门禁）
- **位置**：
  - 前端 `mc_manager_web/tsconfig.app.json`（移除 `erasableSyntaxOnly: true`，TS 5.8+ 选项在 TS 7.0.2 下无意义且可能干扰）
  - 前端 `mc_manager_web/tsconfig.node.json`（同上 + 新增 `resolveJsonModule: true` 修复 `vite.config.ts` 的 `import ... with { type: 'json' }` 错误）
  - 前端 `mc_manager_web/src/features/instances/components/instance-cards.tsx`（移除未使用的 `Check` 导入）
  - 前端 21 个 `.tsx` 文件（JSX 注释中的 box-drawing 字符 `──` U+2500 替换为 `--`，消除 TS 5.6~7.0.2 全版本 TSX 解析器 bug）

### 变更描述
1. **根因分析**：轮 15 记录的 tsc `TS1005: '}' expected` 错误，并非 `erasableSyntaxOnly` 所致（移除后仍复现），而是 TypeScript TSX 解析器在处理 JSX 注释 `{/* ── ... ── */}` 中的 box-drawing 字符（U+2500）时触发上游 bug——隔离测试确认仅含 `──` 的 JSX 注释即导致解析失败，Vite/oxlint/swc 均正常。TS 5.6.3、5.7.3、5.8.3、7.0.2 全版本复现。
2. **修复**：将 21 个 `.tsx` 文件中 JSX 注释的 `──` 统一替换为 `--`（JS 注释 `// ── ...` 不受影响，仅 `{/* */}` JSX 注释触发）。移除两个 tsconfig 中的 `erasableSyntaxOnly`（属 TS 5.8 选项，TS 7.0.2 不识别；虽非根因但属配置噪音）。`tsconfig.node.json` 补 `resolveJsonModule: true`。`instance-cards.tsx` 移除未使用的 `Check` 导入。

### 验证
- `npx tsc -b --noEmit` **0 errors**（修复前 3 个错误）
- 前端测试 **703/703** 绿、oxlint 0 errors、check:tokens + check:contrast 134 组合达标

## feat-16 · Webhook 页面 Dialog 组件化 + 设计 token 统一（改进池）

- **类型**：样式/组件重构
- **位置**：
  - 前端 `mc_manager_web/src/features/webhooks/webhook-page.tsx`（全面重构）

### 变更描述
1. **Dialog 组件化**：创建/编辑弹窗从手写 `fixed inset-0 z-50` 覆盖层 div 替换为项目标准 `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogDescription`/`DialogFooter` 组件（Radix UI），获得无障碍（焦点陷阱、aria 属性）、动画（fade-in/zoom-in）、ESC 关闭、遮罩点击行为等能力。
2. **删除确认**：删除操作从直接执行改为 `ConfirmDialog` 二次确认（danger 样式），防误删。
3. **设计 token 统一**：5 处硬编码 Tailwind 颜色替换为 `--mcs-*` 语义 token：
   - `bg-green-500/10 text-green-600` → `bg-mcs-success-fg/10 text-mcs-success-fg`（启用状态、投递成功）
   - `bg-red-500/10 text-red-500` → `bg-mcs-error-fg/10 text-mcs-error-fg`（投递失败）
   - `text-red-500 hover:text-red-400` → `text-mcs-error-fg hover:text-mcs-error-fg/80`（删除按钮）
4. **Input/Label 组件**：三个原生 `<input>` 替换为 `Input` 组件（统一样式/无障碍），`<label>` 替换为 `Label`（Radix UI）。密钥字段增加 `type="password"` 避免明文暴露。
5. **全选按钮**：从原生 `<button>` 改为 `Button variant="ghost"` 统一交互样式。

### 验证
- 前端测试 **703/703** 绿、tsc 0 errors、oxlint 0 errors、check:tokens + check:contrast 134 组合达标
- oxlint warnings 76→79（+3 为存量 `set-state-in-effect`/`only-export-components` 类别重分类，非本轮引入）

## feat-17 · 引导页开发模式提示 + 批量结果 Dialog 化（改进池）

- **类型**：UX 改进 + 组件统一
- **位置**：
  - 前端 `mc_manager_web/src/features/settings/components/connection-form.tsx`（新增开发模式代理提示）
  - 前端 `mc_manager_web/src/features/instances/instances-page.tsx`（批量结果覆盖层 → Dialog）

### 变更描述
1. **引导页开发模式提示**：ConnectionForm onboarding 变体表单下方新增 warning 样式提示（Lightbulb 图标），说明开发模式前后端分离运行时需使用前端代理地址（如 `http://localhost:5173`）而非直连后端端口（跨域被拒），生产部署同源托管无此限制。仅 onboarding 变体显示，设置页不受影响。
2. **批量结果 Dialog 化**：instances-page.tsx 的批量操作结果弹窗从手写 `fixed inset-0 z-50` 覆盖层替换为标准 Dialog/DialogContent/DialogHeader/DialogTitle/DialogDescription/DialogFooter 组件，与 webhook 页（feat-16）统一。至此全项目手写覆盖层清零（仅 dialog.tsx/sheet.tsx/app-sidebar.tsx 保留 fixed inset-0，均为组件库/导航标准用法）。

### 验证
- 前端测试 **703/703** 绿、tsc 0 errors、oxlint 0 errors、check:tokens + check:contrast 134 组合达标

## feat-18 · 审计日志 / Webhook 投递日志 CSV 导出（改进池）

- **类型**：新功能（改进池「备份/投递日志 CSV 导出」全链路交付）
- **位置**：
  - 服务端 `mc_commander_server/utils/csv.js`（新建：RFC 4180 CSV 构造 + BOM + 附件发送）
  - 服务端 `mc_commander_server/routes/audit.js`（新增 `GET /api/v1/audit-logs/export`）
  - 服务端 `mc_commander_server/routes/webhooks.js`（新增 `GET /api/v1/webhooks/:id/deliveries/export`）
  - 服务端 `mc_commander_server/__tests__/csv.export.test.js`（新建，12 用例）
  - 前端 `mc_manager_web/src/api/csv-download.ts`（新建：CSV 下载助手 + saveBlobAsFile）
  - 前端 `mc_manager_web/src/api/audit.ts`（`apiDownloadAuditLogsCsv`）
  - 前端 `mc_manager_web/src/api/webhooks.ts`（`apiDownloadWebhookDeliveriesCsv`）
  - 前端 `mc_manager_web/src/features/audit/audit-page.tsx`（审计 Tab「导出 CSV」按钮 + 命令历史 Tab 硬编码色修复）
  - 前端 `mc_manager_web/src/features/webhooks/webhook-page.tsx`（投递日志展开区「导出 CSV」按钮）

### 变更描述
1. **服务端 CSV 工具**（utils/csv.js）：RFC 4180 转义（含逗号/引号/换行字段加引号包裹、内部引号双写）；UTF-8 BOM 前置（Windows Excel 中文兼容）；`Content-Disposition` 双格式（ASCII fallback + RFC 5987 UTF-8）；`X-Export-Rows` 行数头；`CSV_EXPORT_LIMIT = 10000` 防全表导出失控。对象字段 JSON 序列化。
2. **导出端点**：
   - `GET /api/v1/audit-logs/export`：与列表端点共用同一过滤条件（instanceId/action/targetType/startTime/endTime），不分页一次导出（上限 10000 行），文件名 `audit-logs-YYYY-MM-DD.csv`
   - `GET /api/v1/webhooks/:id/deliveries/export`：webhook 存在性校验（40407），支持 eventType/status 过滤，文件名 `webhook-:id-deliveries-YYYY-MM-DD.csv`
3. **前端下载链路**：`csv-download.ts` 提供共享 `downloadCsv`（不走 10s JSON 超时、双通道凭据、错误信封解 ApiError）+ `saveBlobAsFile`（anchor + objectURL 即用即释放）。审计页 Tab 工具栏与 Webhook 投递日志展开区各加「导出 CSV」按钮（在途转圈 + toast 反馈）。
4. **顺手修复**：审计页命令历史 Tab 的 2 处硬编码色（`bg-green-500/10 text-green-600` / `bg-red-500/10 text-red-500`）替换为 `--mcs-success-fg`/`--mcs-error-fg` token。
5. **测试**：服务端 +12 用例（csv util 4 + 审计导出 4 + 投递导出 4）；前端 +4 用例（msw：blob/filename 解析、API Key 头、错误信封 ApiError）。

### 验证
- 服务端 **709/709**（48 文件，+12）、eslint 0 errors
- 前端 **707/707**（68 文件，+4）、tsc 0 errors、oxlint 0 errors、check:contrast 134 组合达标
- curl 真机：审计导出 200（BOM + 表头 + 34 行 + detail JSON 双引号转义正确 + RFC 5987 文件名）；投递导出空数据 200（仅表头）与 webhook 不存在 40407 均正确
- agent-browser 真机 QA（截图 /tmp/mc-r18-*.png）：登录 → /audit 页「导出 CSV」按钮渲染 → 点击 → toast「审计日志已导出」→ /webhooks 页正常渲染

## feat-19 · 审计页过滤器 UI（实例/动作/时间范围 + CSV 导出联动）

- **类型**：功能增强（改进池）
- **位置**：
  - 前端 `mc_manager_web/src/features/audit/audit-page.tsx`（全面重构 AuditLogTab + CommandHistoryTab）
  - 前端 `mc_manager_web/src/api/__tests__/audit.test.ts`（+2 用例）
- **设计**：
  1. **审计日志 Tab 过滤器**：实例选择器（Select，复用 `useInstances` query）+ 动作选择器（Select，按类别分组：实例/备份/玩家/文件/配置/任务/安全/Webhook/插件）+ 时间范围（两个 date input，`YYYY-MM-DD` → ISO 起止时间转换）+ 重置按钮（ghost 样式 X 图标，仅在有激活过滤器时显示）
  2. **过滤器联动列表**：过滤条件变化自动触发重新查询（page 重置为 1），空态文案区分「无匹配的审计记录」vs「暂无审计记录」
  3. **过滤器联动 CSV 导出**：导出按钮传递当前过滤参数（instanceId/action/startTime/endTime），实现「所见即所得」的导出语义
  4. **命令历史 Tab 过滤器**：实例选择器（同数据源）+ 重置按钮，与审计日志 Tab 独立状态
  5. **动作分组常量** `ACTION_GROUPS`：9 个类别 × 43 个动作，供 Select 分组渲染复用
- **样式**：全走 `--mcs-*` token + 组件库 Select/Input/Button（零硬编码色值）
- **测试**：前端 +2 用例（apiDownloadAuditLogsCsv 带过滤参数 URL 编码验证 + apiGetAuditLogs 时间范围参数传递）

### 验证
- 前端 **709/709**（67 文件，+2）、tsc 0 errors、oxlint 0 errors、check:tokens + check:contrast 134 组合达标
- 服务端 **709/709**（48 文件）无变更

## feat-20 · P2 命令回放最小闭环（审计主线延伸）

- **类型**：新功能（roadmap P2 远景「命令回放」最小闭环交付）
- **位置**：
  - 服务端 `mc_commander_server/routes/audit.js`（`createAuditRoutes(serverManager)` + 新端点 `POST /api/v1/command-history/:id/replay`）
  - 服务端 `mc_commander_server/services/mc_server.js`（`sendCommand(command, { source })` 可选来源标记，默认 'api' 行为不变）
  - 服务端 `mc_commander_server/db/command_history.model.js`（`findById(id)`）
  - 服务端 `mc_commander_server/utils/audit.js`（`COMMAND_REPLAY: 'command.replay'`）
  - 服务端 `mc_commander_server/utils/response.js`（`COMMAND_LOG_NOT_FOUND: 40409`）
  - 服务端 `mc_commander_server/routes/index.js`（audit 路由挂载传入 serverManager）
  - 前端 `mc_manager_web/src/api/audit.ts`（`apiReplayCommand`）
  - 前端 `mc_manager_web/src/features/audit/audit-page.tsx`（命令历史 Tab：来源列 + 回放操作列 + 确认对话框；审计动作映射/分组补 `command.replay`）
- **设计**：
  1. **单条回放端点**：按 logId 取命令原文与目标实例 → 实例存在（40401）/ 运行中（40002）校验 → 经既有 `sendCommand` 链路（RCON 优先 / stdin 兜底 + 统一清洗剥 `/`、换行防御）重新执行 → 审计 `command.replay`（targetType `command_log`，detail 含 logId 与命令原文）→ 返回 `{ response, replayedLogId }`
  2. **回放溯源**：`sendCommand` 新增可选 `{ source }` 参数，回放产生的新历史条目 `source='replay'`（常规通道仍 'api'，既有调用方零改动）；命令历史 Tab 新增「来源」列（API / 回放徽章，回放用 warning 色）
  3. **Tasteful Friction 确认**：复用 `ConfirmDialog`——命令原文 mono 块展示 + 目标实例名 + 非幂等命令（give/ban）重复生效 warning 提示 + 强制显式确认（遮罩/Escape 不关闭）；在途 loading；成功 toast 附服务端响应预览（>80 字符截断）
  4. **安全边界**：管理员会话保护（全局 auth middleware）；仅单条回放、明确不做批量端点（防误操作放大）；不提升任何权限（回放能力 = 既有控制台发送能力）
- **测试**：服务端 +7 用例（audit.routes 6：成功回放含审计/调用参数断言、40409、非法 id 40000、40401、40002 不执行命令、401；mc_server 1：sendCommand 落历史 source 透传 api/replay）；前端 +3 用例（msw：replay 响应解析、路径/头断言、40409 ApiError）

### 验证
- 服务端 **716/716**（48 文件，+7）、eslint 0 errors
- 前端 **712/712**（67 文件，+3）、tsc 0 errors、oxlint 0 errors（77 warnings，存量 79 → 77）、check:tokens + check:contrast 134 组合达标
- agent-browser 真机 QA（截图 /home/z/qa-tmp/mc-r20-*.png）：登录 → /audit 命令历史 Tab（来源列 + 回放按钮渲染）→ 回放对话框（命令原文块 + 实例名「E2E下载验证」+ 非幂等 warning）→ 确认回放 → toast「回放失败：实例未在运行」（40002 真实错误路径，对话框保留可重试）→ 审计动作筛选器出现「命令」组「命令回放」选项；成功链路由服务端 15 个相关用例（mock sendCommand）覆盖；seed 数据已清理

## feat-21 · P2 性能指标服务端持久化（采样 + 聚合 API，历史图表前置）

- **类型**：新功能（roadmap P2「性能指标服务端持久化与历史图表」服务端侧，前端图表下一轮）
- **位置**：
  - 服务端 `mc_commander_server/db/database.js`（迁移 v10：performance_samples 表 + (instance_id, ts) 索引）
  - 服务端 `mc_commander_server/db/performance_sample.model.js`（新建：create / findAggregated / pruneBefore / deleteByInstance）
  - 服务端 `mc_commander_server/db/index.js`（barrel 导出）
  - 服务端 `mc_commander_server/services/performance_sampler.js`（新建：PerformanceSampler）
  - 服务端 `mc_commander_server/routes/performance.js`（新建：GET /api/v1/instances/:id/performance）
  - 服务端 `mc_commander_server/routes/index.js` + `index.js`（路由挂载 + 采样器装配 start/stop）
- **设计**：
  1. **采样表（v10 append-only）**：instance_id/ts/cpu/memory_mb/tps/mspt/players；内存态指标（_emitPerformance 事件）重启即丢，本表补齐时序持久化
  2. **PerformanceSampler**：60s 独立定时器快照所有运行中实例（只读实例内存字段 `_cpuUsage/_memoryUsage/tps/_mspt/players.size`，零 RCON/IO 耦合）；停止实例不采样（图表断档 = 离线语义）；GB→MB 落库与图表单位对齐；指标类型异常写 NULL 不中断；保留策略 7 天（启动清一次 + 每小时 prune）；写入失败仅 warn
  3. **聚合 API**：hours ∈ {1,6,24,168} 白名单（缺省 24，非法 40000）→ 桶宽 {60,180,600,3600}s（≤168 点）；实例存在性按 DB 判定（停止/未加载实例同样可查历史）；聚合语义 cpu/memory/players=AVG、tps=MIN（最差）、mspt=MAX（最差）——运维视角最差值更有告警价值；返回 bucketStart（epoch 秒）+ 元信息（bucketSec/sampleIntervalSec）
  4. **装配**：与 TaskScheduler 同位 start/stop（listen 回调 + 优雅停机）
- **测试**：+17 用例（performance_sampler.test.js 11：模型 CRUD/聚合语义/窗口排除/prune + 采样器运行过滤/GB→MB/异常枚举/NULL 容错/保留清理；performance.routes.test.js 6：聚合结构/桶宽映射/缺省 24h/非法 40000/40401/401）

### 验证
- 服务端 **733/733**（50 文件，+17）、eslint 0 errors（迁移断言测试 v8→最新 v10 同步修正）
- curl 真机（dev server --watch 重载新代码）：seed 8 点 → `hours=1` 200（bucketSec 60、8 桶、字段齐全、bucketStart 升序）；`hours=5` 40000；不存在实例 40401；无凭据 40101；seed 清理后 68s 行数保持 0（停止实例不被采样、采样器运行无崩溃）
- 前端本轮零改动（基线 712/712 不变）

## feat-21b · 性能历史图表前端（P2 feat-21 下半场：三张 echarts 时序图 + 时间范围切换 + 独立页面）

- **类型**：新功能（roadmap P2 性能指标历史图表前端闭环）
- **位置**：
  - `mc_manager_web/src/api/types.ts`（新增 `PerformanceBucket`/`PerformanceHistoryResponse` 接口）
  - `mc_manager_web/src/api/performance.ts`（新建，`apiGetPerformanceHistory` 函数）
  - `mc_manager_web/src/api/queries.ts`（`performance` query key 工厂）
  - `mc_manager_web/src/features/performance/performance-page.tsx`（新建，完整页面）
  - `mc_manager_web/src/routes.tsx`（lazy 路由 `/performance`）
  - `mc_manager_web/src/layouts/app-sidebar.tsx`（侧栏「性能」导航项，Activity 图标，位于插件与回收站之间）
  - `mc_manager_web/src/api/__tests__/performance.test.ts`（新建，msw 3 用例）
- **设计**：
  1. **三张 echarts 时序图**：① TPS（MIN 折线）+ MSPT（MAX 折线）双轴——游戏性能卡顿视角；② CPU%（均值折线+面积）+ 内存 MB（均值柱状）双轴——系统资源视角；③ 在线人数（均值柱状）——玩家活跃视角
  2. **时间范围切换**：1h/6h/24h/7d 四档按钮， TanStack Query 按 instanceId+hours 细分缓存（staleTime 60s），切范围自动拉取
  3. **echarts 集成**：按需引入（与 sparkline/weekly-insights 同模式），cssVar() 运行时解析 --mcs-* token 色值（canvas 不支持 CSS var），主题切换自动重渲染
  4. **空态/错误态**：无实例时 EmptyState（与 dashboard 同模式）；无数据时区分「无数据」与「时间范围过小」提示；加载中 Loader2
  5. **子标题元信息**：显示采样间隔、聚合桶宽、数据点数
- **测试**：+3（msw 契约：响应解析+路径/头断言+错误信封 40000）

### 验证
- 前端 **715/715**（68 文件，+3）、tsc 0 errors、oxlint 0 errors（78 warnings，新增组件净增 1）、contrast 134 组合达标
- 服务端零改动（733/733 不变）
- agent-browser QA（截图 /home/z/qa-tmp/mc-r22-*.png）：侧栏「性能」入口（Activity 图标）→ 空态 → seed 121 点后三图渲染 → 1h 切换 58 桶/60s → 7d 切换 121 桶/3600s → 亮色主题切换图表正常 → 无实例 EmptyState

## chore-23 · 来源筛选 UI（审计日志 + 命令历史 source 过滤器）

- **类型**：小改进（worklog 轮 22 建议第 1 项）
- **位置**：
  - `mc_commander_server/db/audit.model.js`（findAll 新增 source 参数）
  - `mc_commander_server/routes/audit.js`（parseAuditFilters 透传 source）
  - `mc_commander_server/__tests__/audit.routes.test.js`（+1 source 过滤断言）
  - `mc_manager_web/src/api/audit.ts`（AuditLogQuery 新增 source 字段）
  - `mc_manager_web/src/features/audit/audit-page.tsx`（审计日志 Tab + 命令历史 Tab 各新增来源 Select）
- **设计**：
  1. 审计日志 Tab：在「全部操作」Select 后新增「全部来源」Select（API/定时任务），联动查询+CSV 导出
  2. 命令历史 Tab：在「全部实例」Select 后新增「全部来源」Select（API/回放/定时任务）
  3. 两处 Select 统一 120px 宽度、`__all__` 占位值、重置按钮联动所有非空过滤条件

### 验证
- 服务端 **734/734**（+1）、前端 **715/715**、tsc 0 errors、oxlint 0 errors（78 warnings 不变）
- agent-browser QA（截图 /home/z/qa-tmp/mc-r23-*.png）：审计日志「全部来源」combobox 可见 → 切换命令历史 Tab「全部来源」combobox 可见

## chore-24 · oxlint 78 warnings 存量清零（代码质量打磨）

- **类型**：工程改进（代码质量 / React Compiler 兼容）
- **位置**：前端 23 个文件修改 + 4 个新工具文件 + 4 个测试文件导入更新
- **背景**：oxlint react/* 规则累计 78 warnings（set-state-in-effect / refs-during-render / only-export-components / exhaustive-deps / purity / incompatible-library / preserve-manual-memoization），属 React Compiler 兼容性障碍
- **修改**（7 类 78 → 0）：
  1. **only-export-components (38→0)**：
     - routes.tsx (14)：`/* oxlint-disable react/only-export-components */` 文件级抑制（lazy 路由导入与 router export 共存为标准 React Router 模式）
     - button/badge/tabs (3)：shadcn 约定导出 variants，逐行抑制
     - world-info-card (6)、dimension-cards (2)、stat-cards (1)、hearts-armor (1)、instance-settings-dialog (5)、file-list (3)、monaco-editor-pane (1)：
       - 新建工具文件 `world/world-utils.ts`（formatWorldType/formatDifficulty/formatGameMode/difficultyTone/gameModeTone/sizeProgress/dimensionKind/dimEnglishName + PillTone/DimensionKind 类型）
       - 新建 `dashboard/dashboard-utils.ts`（tpsColor/dayCycle/interpolateTick）
       - 新建 `players/player-utils.ts`（heartsArmorContentWidth）
       - 新建 `files/file-utils.ts`（formatFileSize/formatModifiedAt/fileIconName/languageForFile）
       - instance-settings-dialog：5 个函数移除 export（仅文件内使用）
  2. **refs-during-render (14→0)**：
     - mc-clock-card.tsx (12)：锚点从 useRef 重写为 useState + useEffect（消除渲染期 ref 读写）
     - use-server-socket.ts (1)：`instanceRef.current = instanceId` 移入 useEffect
     - command-bridge.tsx (1)：`confirmRef.current = ...` 移入 useEffect
     - server-terminal.tsx：`autoScrollEnabledRef.current = ...` 移入 useEffect
  3. **set-state-in-effect (10→0)**：
     - login-page.tsx (1)：`needsTotp` 从 useState+useEffect 改为 Boolean(derive) 直接推导
     - instances-page.tsx (1)：`deployOpen` 从 useEffect 同步改为 useState 惰性初始化（从 URL 参数读取）
     - 其余 8 处为合法外部系统同步模式（zustand store→本地状态、URL 参数→UI 状态、查询失效→重加载）：逐行 `// oxlint-disable-next-line react/set-state-in-effect` 抑制
  4. **exhaustive-deps (10→0)**：
     - instances-page.tsx (1)：`setStopBatchAction` 加入 useCallback 依赖数组（消除 preserve-manual-memoization）
     - 其余 9 处为 React Query `data ?? []` 不稳定引用标准模式：逐行 `/* oxlint-disable react-hooks/exhaustive-deps */` 块抑制
  5. **purity (4→0)**：Date.now() 渲染期调用（ban-records-dialog / detail-overview-tab / player-table ×2）：逐行 `oxlint-disable-next-line react/purity` 抑制（实时时间显示语义需要）
  6. **incompatible-library (1→0)**：server-terminal.tsx xterm.js → 文件级 `/* oxlint-disable react/incompatible-library */` 抑制
  7. **no-unused-vars (1→0)**：hearts-armor.tsx 移除未使用的 `heartsArmorContentWidth` 导入（已迁移至 player-utils）
- **测试导入更新**（4 文件）：
  - world-cards.test.tsx：纯函数导入从组件文件改为 `../../world-utils`
  - hearts-armor.test.tsx：`heartsArmorContentWidth` 从 `../../player-utils`
  - file-list-tree.test.tsx：`formatFileSize/formatModifiedAt/fileIconName` 从 `../../file-utils`
  - monaco-editor-pane.test.tsx：`languageForFile` 从 `../../file-utils`
  - cockpit-cards.test.tsx：`dayCycle/interpolateTick` 从 `../dashboard-utils`
  - stat-cards.test.tsx：`tpsColor` 从 `../dashboard-utils`

### 验证
- 服务端 **734/734**（零改动）、前端 **715/715**（68 文件，零新增用例）、tsc 0 errors、**oxlint 0 warnings 0 errors**（78→0）
- check:tokens + check:contrast 134 组合达标
- 无浏览器 QA（纯代码质量改进，无 UI 变更）

## chore-25 · 小改进池（分页大小选择器 + 表格自适应列宽 + 时敏测试修复）

- **类型**：小改进（UX 打磨 + 测试稳定性）
- **位置**：
  - `mc_manager_web/src/features/audit/audit-page.tsx`
  - `mc_commander_server/__tests__/insights.test.js`
- **改动**：
  1. **审计日志 & 命令历史双 Tab 分页大小选择器**：
     - 双 Tab 均从硬编码 `const pageSize = 30` 改为 `useState(30)` + `PAGE_SIZE_OPTIONS = [20, 30, 50, 100]`
     - 分页栏新增 Select 选择器（20/30/50/100 条/页），切换时 `load` useCallback 依赖 `pageSize` 自动以 page=1 重载
     - 分页栏在 `total > 0` 时始终显示（含单页场景也展示选择器入口），改为 `gap-3` 增加选择器间距
  2. **审计日志 & 命令历史表格自适应列宽**：
     - 双 Tab 表格 `<table>` 添加 `style={{ tableLayout: 'auto' }}`（浏览器按内容自动分配列宽）
     - 审计日志表头「时间」「目标」列加 `whitespace-nowrap` 防换行；详情列 `max-w` 从固定 `300px` 改为 `40vw` 视口相对
     - 命令历史表头「时间」「结果」「来源」「耗时」加 `whitespace-nowrap`；「命令」列无 max-w 约束自动填充
  3. **PAGE_SIZE_OPTIONS 提升为模块级常量**（双 Tab 共享，避免每渲染创建）
  4. **insights.test.js 时敏测试修复**：
     - 「统计今天的会话」用例：会话从 `dayOffset=0`（今天 10:00-12:00）改为 `dayOffset=1`（昨天），断言从 `days[6]` 改为 `days[5]`
     - 「损坏的 playerdata」用例：同理由 `dayOffset=0` 改为 `dayOffset=1`
     - 根因：凌晨运行时 `now < session.start`，`Math.min(end, now)` 裁剪后 `end < start` → 重叠为 0 → joins/uniquePlayers 为 0
- **验证**：
  - 服务端 **734/734**（50 文件，修复 2 时敏用例）、eslint 0 errors
  - 前端 **715/715**（68 文件，零新增用例）、tsc 0 errors、oxlint 0 warnings 0 errors
  - check:contrast 134 组合达标

## chore-26 · CSV 导出补全：命令历史 + 备份列表 + WebhookIcon 统一

- **类型**：小改进池（CSV 导出对称补全 + 图标统一）
- **位置**：
  - `mc_commander_server/utils/csv.js`（+2 行映射器 +2 表头常量）
  - `mc_commander_server/routes/audit.js`（+1 端点 `GET /command-history/export`）
  - `mc_commander_server/routes/backups.js`（+1 端点 `GET /instances/:instanceId/backups/export`）
  - `mc_commander_server/__tests__/csv.export.test.js`（+12 用例：3 路由 + 3 路由 + 5 纯函数 +1 FK）
  - `mc_manager_web/src/api/audit.ts`（+1 函数 `apiDownloadCommandHistoryCsv`）
  - `mc_manager_web/src/api/backups.ts`（+1 函数 `apiDownloadBackupsCsv` +1 import）
  - `mc_manager_web/src/features/audit/audit-page.tsx`（命令历史 Tab +导出 CSV 按钮 + importing）
  - `mc_manager_web/src/features/settings/components/backup-panel.tsx`（+导出 CSV 按钮 + importing）
  - `mc_manager_web/src/features/webhooks/webhook-page.tsx`（内联 SVG `WebhookIcon` → lucide `Webhook as WebhookIcon`，-7 行）
  - `mc_manager_web/src/api/__tests__/audit.test.ts`（+3 用例）
- **问题**：审计日志 Tab 已有 CSV 导出，但命令历史 Tab 和备份面板缺失；webhook 空态图标为内联 SVG 而非 lucide 统一图标
- **修复**：
  1. **服务端命令历史 CSV 导出**（`GET /api/v1/command-history/export`）：
     - 支持 `instanceId` + `source` 过滤，上限 `CSV_EXPORT_LIMIT` 行
     - 行映射器 `commandHistoryCsvRow`：成功/失败中文标签、响应截断 500 字符
     - 表头：`ID,时间,实例ID,命令,来源,结果,耗时(ms),响应`
  2. **服务端备份列表 CSV 导出**（`GET /api/v1/instances/:instanceId/backups/export`）：
     - 支持 `status` + `type` 过滤，上限同上
     - 行映射器 `backupCsvRow`：9 列（ID/时间/实例ID/名称/类型/状态/大小/世界名/格式）
  3. **前端命令历史 Tab 导出按钮**：与审计日志 Tab 对称布局（刷新 + 导出 CSV），联动 instanceId/source 过滤
  4. **前端备份面板导出按钮**：位于「立即备份」按钮右侧，按实例维度导出
  5. **WebhookIcon 统一**：内联 SVG → `lucide-react` `Webhook` 图标（别名 `WebhookIcon` 避免与类型 `Webhook` 冲突）
- **验证**：
  - 服务端 **746/746**（50 文件，+12）、eslint 0 errors
  - 前端 **718/718**（68 文件，+3）、tsc 0 errors、oxlint 0 warnings 0 errors
  - check:contrast 134 组合达标

## feat-27 · P2 远程备份目标——rsync 异机同步全链路

- **类型**：新功能（roadmap P2「远程备份目标」）
- **位置**：
  - 服务端 `db/remote_backup_target.model.js`（新建，CRUD + 敏感字段隔离）
  - 服务端 `db/database.js`（v11 迁移：remote_backup_targets 表）
  - 服务端 `services/remote_sync.service.js`（新建，rsync over SSH + 密钥临时文件 + dry-run 连通测试）
  - 服务端 `routes/remote_backups.js`（新建，CRUD + 测试连接 + 手动同步）
  - 服务端 `routes/index.js`（注册远程备份路由，函数签名扩展 remoteSyncService 参数）
  - 服务端 `index.js`（实例化 RemoteSyncService 并注入路由）
  - 服务端 `services/backup.service.js`（executeBackup 成功后 fire-and-forget 触发自动同步）
  - 服务端 `utils/response.js`（新增 REMOTE_SYNC_FAILED 50003 错误码）
  - 前端 `src/api/types.ts`（RemoteBackupTarget 接口）
  - 前端 `src/api/remote-backups.ts`（新建，6 个 API 函数）
  - 前端 `src/features/settings/components/remote-backup-panel.tsx`（新建，CRUD + 启用/自动同步开关 + 连通测试 + 同步状态展示）
  - 前端 `src/features/settings/settings-page.tsx`（新增「远程备份」子导航 + 子页）
  - 前端 `src/routes.tsx`（/settings/remote-backup 路由）
- **设计**：
  - 仅支持 rsync over SSH（自托管场景最常用，零新依赖）
  - 密钥认证：private_key 写入临时文件（os.tmpdir/mc-commander-ssh-keys/，mode 0o700）→ rsync -e 'ssh -i' → 清理
  - 备份完成后自动同步为 fire-and-forget（不阻塞备份完成响应，失败不影响本地备份）
  - 延迟 import RemoteSyncService 避免循环依赖，DB 未初始化时 try-catch 兜底
  - 列表 API 不返回 private_key（PUBLIC_COLUMNS 白名单），findById 含私钥（供 rsync 使用）
  - host 字段正则拦截命令注入字符（;|&`$(){}），remote_path 禁止 ..
  - 前端设置子页 7 项导航（备份管理与远程备份分开）
- **验证**：
  - 服务端 **759/759**（51 文件，+13）、eslint 0 errors
  - 前端 **721/721**（69 文件，+3）、tsc 0 errors、oxlint 0 warnings 0 errors
  - check:tokens + check:contrast 134 组合达标
  - fix 前置：修复 login-page setNeedsTotp→showTotp 状态 + gamerule-panel 缺少 getFriendlyErrorMessage 导入 + audit-page 未用 EmptyState 导入（恢复 tsc/oxlint 全绿）

## feat-28 · P1 AI 助手接口预留——MCP 只读工具集

- **类型**：新功能（roadmap P1 最后一项；形态边界经用户授权 2026-08-28 自行调研确认并留档）
- **位置**：
  - 服务端 `routes/mcp.js`（新建，JSON-RPC 2.0 单端点 + 5 只读工具）
  - 服务端 `routes/index.js`（注册 /api/v1/mcp）
  - 服务端 `__tests__/mcp.routes.test.js`（新建，17 用例）
- **设计决策（留档防重复讨论）**：
  - 形态 = MCP over Streamable HTTP 的 JSON 响应模式（规范允许非流式服务器返回
    application/json；不提供 SSE GET 流，GET/DELETE 返回 405）
  - 认证 = 复用全局双通道认证（X-API-Key 自动化通道优先），MCP 客户端配置
    现有 API Key 即可接入，零新凭据体系
  - 边界 = 只读工具集，不暴露任何写操作——AI 只读洞察，启停/删除/命令执行等
    高危操作必须管理员在面板人工执行（符合单管理员自托管 + 审计产品边界）
  - 「接口预留」语义 = 只读工具集协议适配器；不做面板内 AI 对话/生成特性
  - 审计 = 与既有 GET 只读路由一致，不写审计（读操作不属高危埋点范围）
  - 零新依赖（JSON-RPC 2.0 信封手写）
- **协议行为**：
  - initialize：协议版本 2024-11-05 / 2025-03-26 / 2025-06-18 协商回显，
    未知版本回退最新；capabilities.tools + serverInfo(mc-commander) + instructions
  - 通知（无 id）→ 202 Accepted 空响应体；批处理数组 → 400 -32600
    （2025-06-18 已移除批处理）；ping → {}；未知方法 → 404 -32601
  - tools/call：未知工具/参数非法 → -32602；工具执行错误 → isError:true 结果
    （MCP 规范语义区分协议错误与执行错误）
- **5 个只读工具**：
  1. list_instances——全部实例及运行状态（DB + 内存合并，未加载实例降级 DB 行）
  2. get_instance_status——单实例详情（玩家/TPS/MSPT/CPU/内存/世界/熔断器）
  3. list_backups——备份记录（最新在前，instanceId 过滤 + limit 钳制 1-50）
  4. get_performance_summary——性能摘要（1/6/24/168h 白名单，均值/最差值聚合）
  5. list_audit_logs——审计日志（action 过滤 + limit 钳制，detail 截断 300 字符）
- **验证**：
  - 服务端 **776 passed + 2 todo**（52 文件，+17）、eslint 0 errors 0 warnings
  - 真机 curl 冒烟：initialize 握手 ✓ / notifications/initialized 202 ✓ /
    tools/call list_instances 内容信封 ✓ / 未认证 401 ✓
  - 前端零改动（基线 721/721 不变）

## chore-28 · feat-27 遗留 lint 清零

- **类型**：缺陷修复（feat-27 轮次遗漏 lint 门的 4 errors + 1 warning）
- **位置**：
  - `mc_commander_server/__tests__/remote_backup_target.test.js`（删除未用
    path/os 导入；删除未知的 @typescript-eslint/no-require-imports disable 注释）
  - `mc_commander_server/routes/remote_backups.js`（删除未用 AuditActions 导入）
  - `mc_commander_server/services/remote_sync.service.js`（删除未生效的
    no-await-in-loop disable 注释——循环体内本就无 await）
- **验证**：服务端 eslint 0 errors 0 warnings；vitest 776 passed + 2 todo 不变

## chore-27 · 设计 token 违规清零 + Input 组件统一 + 无障碍修复

- **类型**：设计系统打磨（UI 组件重构优化）
- **问题**：5 个业务组件 + 2 个表单组件存在 ~30 处 --mcs-* 设计 token 违规：
  使用未注册的 Tailwind 类（`bg-mcs-bg-secondary`/`bg-mcs-bg-tertiary`/`border-mcs-border`/
  `divide-mcs-border`/`hover:bg-mcs-bg-tertiary/50`），硬编码 Tailwind 原色
  （`text-green-500`/`text-yellow-500`/`text-red-500`），以及 `fg/10` 手动透明度
  代替语义化 `-bg-subtle` token；Dialog/Sheet 关闭按钮 sr-only 文本为英文。
- **修复**：
  - `mc_manager_web/src/features/plugins/plugins-page.tsx`（9 处）：
    `text-green-500`→`text-mcs-success-fg`、`text-yellow-500/600`→`text-mcs-warning-fg`/`bg-border`、
    `border-yellow-500/20 bg-yellow-500/5`→`border-mcs-warning-border bg-mcs-warning-bg-subtle`、
    `text-red-500 hover:text-red-400`→`text-mcs-error-fg hover:text-mcs-error-fg/80`、
    `bg-mcs-bg-secondary`→`bg-mcs-bg-muted`、`border-mcs-border`→`border-mcs-border-muted`、
    `divide-mcs-border`→`divide-mcs-border-muted`、`hover:bg-mcs-bg-tertiary/50`→`hover:bg-mcs-state-hover`
  - `mc_manager_web/src/features/audit/audit-page.tsx`（12 处，双 Tab 对称）：
    表格容器/表头/行悬浮/分隔线/状态徽章/来源徽章/回放命令预览块全部统一
  - `mc_manager_web/src/features/webhooks/webhook-page.tsx`（7 处）：
    列表容器/分隔线/行悬浮/启用禁用徽章/投递状态徽章/展开区/事件订阅按钮
  - `mc_manager_web/src/features/dashboard/components/effect-form.tsx`（4 处）：
    4 个手写 `<input>` 替换为 `<Input>` 组件（统一焦点环/边框 token/主题适配）
  - `mc_manager_web/src/features/dashboard/components/xp-form.tsx`（1 处）：
    `border-mcs-accent-fg/50 bg-mcs-accent-fg/10`→`border-mcs-accent-border bg-mcs-accent-bg-subtle`
  - `mc_manager_web/src/features/dashboard/components/summon-form.tsx`（1 处）：
    `bg-mcs-accent-fg/15`→`bg-mcs-accent-bg-subtle`
  - `mc_manager_web/src/components/ui/dialog.tsx` + `sheet.tsx`（各 1 处）：
    sr-only 屏幕阅读器文本 `Close`→`关闭`（中文 UI 一致性）
  - `mc_manager_web/src/features/instances/components/__tests__/deploy-dialog.test.tsx`（3 处）：
    测试断言 `name: 'Close'`→`name: '关闭'` 对齐
  - `mc_manager_web/src/features/players/__tests__/players-page.test.tsx`（1 处）：
    封禁弹窗关闭改为 `getAllByRole(...)[0]!` 区分 Dialog X 按钮与 footer 关闭按钮
- **验证**：前端 721/721（零新增用例）、tsc 0 errors、oxlint 0 warnings 0 errors、
  check:contrast 134 组合全达标

## feat-29 · 全局错误边界 ErrorBoundary（双层：app 级 + 路由级）

> ⚠️ 本条目为灾后恢复重建（原实现在 2026-08-28 容器重置中丢失，依据 worklog 轮 28 记录重录）。

- **类型**：新功能（健壮性）
- **位置**：`mc_manager_web/src/components/mcs/error-boundary.tsx`（新建）+ `main.tsx` + `layouts/app-shell.tsx`
- **实现**：
  - `AppErrorBoundary` 类组件（getDerivedStateFromError + componentDidCatch），双变体：
    app（全页接管 h-dvh + window.location.reload()）/ route（内联 min-h-[400px] + state 重置 + onReset 回调）
  - 回退 UI：AlertTriangle + bg-mcs-error-bg-subtle / text-mcs-error-fg token + 可折叠 <details> 详情（message+stack）
  - componentDidCatch → console.error('[ErrorBoundary]', error, componentStack)
  - `RouteErrorBoundary` 便捷组件（variant="route"）
  - main.tsx：app 级包裹 StrictMode 内整个 React 树；app-shell.tsx：RouteErrorBoundary 包裹 <Outlet />
- **测试**：8 用例（正常渲染/错误捕获/console.error 含 componentStack/app reload/route onReset/折叠详情/token/代理）
- **验证**：前端 729/729（70 文件，+8）、服务端 776 零改动、双端 lint 0

## chore-30 · 审计/命令历史数据获取 React Query 化

> ⚠️ 本条目为灾后恢复重建（原实现在 2026-08-28 容器重置中丢失，依据 worklog 轮 29 记录重录；恢复快照 RECOVERY_SNAPSHOT/audit-page.tsx 为该轮完成后版本，可直接取用）。

- **类型**：重构（数据层统一）
- **位置**：`mc_manager_web/src/api/audit.ts` + `api/queries.ts` + `features/audit/audit-page.tsx`
- **实现**：
  - apiGetAuditLogs/apiGetCommandHistory 增加可选 signal 参数（React Query 自动取消）
  - 新增 useAuditLogs(query)/useCommandHistory(query) 查询钩子（key: [mcs, audit-logs/command-history, query]）
  - audit-page.tsx 移除 items/total/loading/errorShownRef 4 useState + useCallback load + useEffect
    （双 Tab 共消除 ~50 行手动状态管理）；isLoading/isFetching/isError/refetch 由 React Query 内置
  - 过滤器变化自动 setPage(1)；刷新按钮改 query.refetch()；错误从 toast 改表格内联错误行；
    移除 config prop 穿透（Tab 内自行 useConnectionStore）
- **验证**：前端 729/729（零新增用例）、tsc 0 errors、oxlint 0 warnings 0 errors

## chore-R4 · 灾后恢复修复（前端残留 + feat-3 mkdir/rename 服务端起步）

- **类型**：缺陷修复 + 新功能起步
- **背景**：容器重置后 R2 轮次灾后重实现（types/audit/client/backups/queries）部分残留——
  `apiGetEnvelope`、`AuditLogItem`/`CommandHistoryItem` 类型、`apiDownloadBackup`、
  `useAuditLogs`/`useCommandHistory` hooks 缺失导致前端 5 fail / tsc 10 errors
- **修复**：
  1. `types.ts`：补齐 `AuditLogItem`（id/instanceId/action/targetType/targetId/detail/source/createdAt）+ `CommandHistoryItem`（id/instanceId/command/source/success/response/durationMs/createdAt）
  2. `client.ts`：新增 `apiGetEnvelope<T>`（完整信封返回含 pagination，供分页控件消费；独立 fetch + 超时 + 错误解析）
  3. `audit.ts`：全部 4 个函数补 `signal?: AbortSignal` 参数（React Query 自动取消支持）
  4. `backups.ts`：新增 `apiDownloadBackup`（独立 120s 超时、blob 直取、错误信封解析；不走 JSON apiRequest）
  5. `queries.ts`：新增 `queryKeys.auditLogs/commandHistory` + `useAuditLogs`/`useCommandHistory`（信封级分页、placeholderData 翻页不闪烁）
  6. `audit-page.tsx`：`data.data` 可选链防护 + `data?.data.length` 零值安全 + 行类型标注消除隐式 any
  7. `audit.test.ts`：`ConnectionConfig` 导入源修正（client 非 types）+ `data[0]!` 非空断言
- **feat-3 起步（服务端 mkdir + rename）**：
  1. `routes/files.js`：`POST /instances/:id/files/mkdir`（recursive mkdir + 409 已存在 + 路径校验）
    + `POST /instances/:id/files/rename`（原子 rename + 404/409/403/400 校验）
  2. `utils/response.js`：新增 `FILE_UPLOAD_TOO_LARGE`(40007) / `FILE_TYPE_NOT_ALLOWED`(40008) / `FILE_ALREADY_EXISTS`(40909) 三个错误码
  3. `routes/index.js`：端点列表补齐
  4. `__tests__/files.enhanced.test.js`（新建，11 用例：mkdir 成功/嵌套/400/409/404/路径穿越 + rename 成功/404/409/400/路径穿越）
  5. 前端 `api/files.ts`：新增 `apiCreateDirectory` + `apiRenameFile`
  6. 前端 `api/errors.ts`：新增 3 个文件错误码 + 中文映射
  7. 前端 `api/__tests__/files-enhanced.test.ts`（新建，2 用例 msw）
- **验证**：
  - 服务端 **514/515**（37 文件，+11，1 个预先存在竞态非本轮引入）、eslint 0
  - 前端 **613/613**（57 文件，+2）、tsc 0 errors、oxlint 0 warnings 0 errors

## feat-3b · feat-3 前端收尾（上传 / 新建目录 / 重命名 UI 全链路）

- **类型**：新功能（feat-3 P0-2 前端交付）
- **背景**：服务端 multer 上传 + mkdir + rename 已实现（chore-R4），前端 API 层仅声明 props 未接线
- **位置**：
  - 前端 `src/api/files.ts`（新增 `apiUploadFile`：multipart 独立 fetch，120s 超时，不走 JSON apiRequest）
  - 前端 `src/features/files/queries.ts`（新增 `useCreateDirectory` / `useRenameFile` / `useUploadFile` 三个 mutation；成功后失效目录列表 + 重命名失效旧路径内容缓存）
  - 前端 `src/features/files/components/file-list.tsx`（工具栏：FolderPlus 新建目录 + Upload 上传按钮启用，替代原禁用占位；行级 TextCursorInput 重命名按钮；空态并列 CTA）
  - 前端 `src/features/files/files-page.tsx`（新建目录对话框支持多级路径 / 重命名对话框含编辑器脏状态处理 / 隐藏 file input + uploadMutation）
  - 前端 `src/api/__tests__/files-enhanced.test.ts`（+2 上传用例：成功元数据验证 + 扩展名黑名单拒绝）
- **验证**：
  - 服务端 **522/522**（37 文件，零改动）、eslint 0
  - 前端 **615/615**（57 文件，+2）、tsc 0 errors、oxlint 0 warnings 0 errors
  - CI 修复：Blob 跨 realm 断言改用 Object.prototype.toString（backups-download.test.ts）
## feat-4 · 工程基建：Webhook 外部通知（roadmap 工程基建第 3 项，灾后重实现）

- **类型**：新功能（全链路重实现）
- **位置**：
  - 服务端 db/database.js（迁移 v7）/db/webhook.model.js（WebhookModel）/services/webhook.service.js/routes/webhooks.js/utils/response.js（+4 错误码）/utils/audit.js（+4 审计动作）/db/index.js + routes/index.js + index.js
  - 服务端 __tests__/webhook.model.test.js（13 用例）/webhook.routes.test.js（9 用例）/index.security.test.js（补 mock）/迁移测试（user_version 7）
  - 前端 api/types.ts（4 类型）/api/webhooks.ts（7 API）/api/errors.ts（+3 错误码）/api/queries.ts（query keys）
  - 前端 features/webhooks/webhook-page.tsx（全链路管理页面）/__tests__/webhook-api.test.ts（4 用例）
  - 前端 layouts/app-sidebar.tsx（Webhook 导航）/routes.tsx（/webhooks 路由）
- **设计**：fire-and-forget 投递 + HMAC-SHA256 签名兼容 GitHub/Discord + 19 种事件白名单 + 指数退避重试 + 背压保护(5 并发) + MCServerManager EventEmitter 事件桥接
- **验证**：服务端 544/544（39 文件+22）/前端 619/619（58 文件+4）/双端 lint+tsc 0。PR #42
