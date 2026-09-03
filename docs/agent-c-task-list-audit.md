# Agent-C 任务清单 · 审计挖掘（源自 audit 2026-08-31）

> **用法（给 C 的协议）**：本清单由 C 于 2026-09-03 从 `docs/audit-2026-08-31.md`（62 条发现）挖掘生成。
> **甄别原则**：①先对照 dispatch-list Phase 0-5 与既有 closed issue，已闭环的登记证据不重复发布；
> ②审计「方案」列基于 2026-08-31 代码，**发布前必须按当前代码现状重新甄别**（本清单「C 甄别」列即修正结论）；
> ③按 Phase 顺序发布为 task issue（单 Tick ≤4，可领 <3 触发）；来源标注必填（如「来源：audit S-P0-1」）。
> 每个任务闭环后 C 在本清单对应行标注（issue 号 + 日期）。

## 甄别结论总览

| 类别 | 数量 |
|---|---|
| 审计发现总条数 | 62（P0×12 + P1×22 + P2×28） |
| 已闭环（无需发布，见下表） | 21 |
| 明确不做 | 1（P2-28 i18n，与 P6 关闭决策一致） |
| 整合为可发布任务 | 18 个任务覆盖其余 40 条 |

## 一、已闭环对照表（21 项，2026-09-03 代码级复核）

| 审计项 | 闭环证据 |
|---|---|
| S-P0-4 Webhook SSRF | issue #215（私网黑名单 + 投递限制） |
| S-P1-3 安全响应头 | issue #215（helmet 最小安全头就位） |
| D-P1-1 面板 DB 零备份 | issue #284（SQLite 快照 + .env 纳入备份） |
| U-P1-4 审计页无入口 | issue #138（/audit 注册 + 侧栏入口） |
| P2-18 升级进度单点依赖 WS | issue #150（GET 轮询兜底） |
| D-P0-1 版本号失真 | routes/index.js:19「版本号单一来源：package.json」注释 + check-update 已实现 |
| D-P0-3 端口占用裸崩溃 | index.js:176-177 `server.on('error')` EADDRINUSE 友好报错 |
| F-P0-1 无错误边界（主体） | components/mcs/error-boundary + main.tsx:49 根挂载（残留项见 A3-3） |
| F-P1-2 失败渲染成空态 | backup-panel.tsx:207 `backupsQuery.isError` 分支；player-table.tsx:476 isError 空态分支 |
| F-P1-4 编辑器草稿竞态 | files-page.tsx:112 切换时 `setDraft('')` + :173 加载完成后同步基线 |
| U-P1-6 卸载确认倒挂 | instances-page.tsx:47-48 卸载输入实例名强确认 |
| U-P1-7 窄屏崩坏 | Phase 3 #22/#23 闭环（移动分支 isMobile/Sheet/编辑器全屏覆盖；固定宽类仅存于桌面宽屏分支） |
| DS-P1-1 死 token 6 处 | grep `text-mcs-text-secondary/bg-mcs-bg-card/text-mcs-base` 零命中（Phase 0 #1 守门生效） |
| DS-P1-2 调色板残留 20 处 | 残留 grep 全部为注册过的 `mcs-purple-*` token（Phase 1 #16 色板瘦身）；emerald/orange 原始类零命中 |
| P2-13 mode 白名单 | players-page.tsx:89 `FILTER_MODE_OPTIONS.some(...)` 白名单校验 |
| P2-20 顶栏 0 实例死路 | app-topbar.tsx:139 直达 `/instances?tab=deploy` |
| P2-23 图标 aria-hidden 29 处 | 审计引用的 action-forms.tsx 已不存在（结构重构）；全站 95 处图标已带 aria-hidden（#117 批次） |
| P2-24 表格三轨 | Phase 1 #4 DataTableShell 收编三表 |
| P2-26 sonner 主题 | main.tsx:28-32 ThemedToaster 跟随主题 |
| P2-2 静态资源缓存 | middleware/static_serve.js:15 `maxAge:'7d'` + index.html no-cache |
| P2-3 优雅退出 | index.js shutdown：taskScheduler.stop → stopAll → wss.close → db.close → server.close |

**不做**：P2-28 i18n（审计标「暂缓」；2026-09-03 所有者 directive 关闭 P6/i18n，一致）。

---

## Phase A1 · 安全加固（公网就绪）

- [x] **A1-1** [安全] /auth/setup 首访设密所有权证明（P0·bug修复）｜中｜来源：audit S-P0-1 ✅ #309 (2026-09-03)
  现状（2026-09-03 复核）：routes/auth.js:104-116 仍「仅未设密即可设密」，无凭证要求。
  **C 甄别**：审计原方案「携带 .env API_KEY 或一次性 setup token」前半已失效——API_KEY 已迁移为 API_KEY_HASH（#229），服务端无明文可比对。修正方案：部署脚本生成一次性 `SETUP_TOKEN` 写入 .env（或 stdout 提示），setup 请求必须携带且用后作废；未配置 token 时保持现有行为（本机首发场景）并在 README 安全章节说明公网部署必须配 token。better-sqlite3 同步 API，检查+写入间无 await 即可规避 TOCTOU，注释说明。
  验收：SETUP_TOKEN 生成/校验/作废全链路；token 错误 403；测试覆盖（正确/错误/缺失/已作废）。

- [x] **A1-2** [安全] 升级接口 mcVersion 白名单 + 路径收口（P0·bug修复）｜小｜来源：audit S-P0-2 ✅ #310 (2026-09-03)
  现状：routes/upgrade.js:22-24 仅「必填 + string」校验，无格式白名单。
  验收：路由层白名单 `/^\d{1,3}(\.\d{1,3}){0,3}$/`；jar 落地路径复用 resolveSafePath（或等价 contains 检查）；测试覆盖穿越 payload（`../`、绝对路径、编码变体）。

- [x] **A1-3** [安全] 网络暴露收口：rcon.port 实例派生 + HOST 可配 + 弱 Key 生产阻断（P0/P1·bug修复）｜中｜来源：audit S-P0-5 + S-P1-2 ✅ #315 (2026-09-03)
  现状：server-jar.js:134 `rcon.port=25575` 硬编码（server-port 已派生）；index.js:186 硬编码 '0.0.0.0'；无弱 Key 生产阻断。
  **C 甄别**：审计把 RCON 派生与弱 Key/HOST 分列，三者同属「网络暴露面」，合并一个任务一次验收。
  验收：rcon.port 按 server-port 同款规则派生且不冲突；`HOST` 环境变量（默认 127.0.0.1，文档说明公网部署显式设 0.0.0.0）；生产（NODE_ENV=production）弱 Key 默认拒绝启动、`ALLOW_WEAK_KEY=1` 显式豁免；.env.example 同步。

- [x] **A1-4** [安全] JAR 下载落地校验：sha256 + 体积上限 + 域名白名单（P1·bug修复）｜中｜来源：audit S-P1-1 ✅ #316 (2026-09-03, PR#326)
  现状：部署/升级 JAR 下载无完整性校验与上限（对比插件市场已有 100MB 截断+白名单）。
  验收：上游 sha256 校验（Piston-meta manifest 提供值）；流式体积上限（512MB）；下载域名白名单（mojang/piston 域）；失败即弃并给可读错误。

- [x] **A1-5** [安全] 认证通道残留收口：锁定键对齐 + trust proxy 可配 + WS 会话周期复验（P0/P1·bug修复）｜中｜来源：audit S-P0-3 残留 + S-P1-4 ✅ #320 (2026-09-03)
  现状：auth.js:33 仍 `req.ip || socket.remoteAddress`（XFF 可伪造优先）；index.js:99 `trust proxy` 硬编码 1；websocket.js 仅握手鉴权（1008 在 :155 仅握手拒绝用），踢会话后长连接仍存活。
  **C 甄别**：#231 已加 LRU 容量上限（部分闭环），残留即锁定键与复验。合并为「认证通道」一个任务。
  验收：锁定键改 `socket.remoteAddress`；`TRUST_PROXY` 环境变量（默认 1 兼容现网）；WS 心跳周期内抽样复验会话有效性，失效 `close(1008)`；测试覆盖踢出后 WS 断开。

- [x] **A1-6** [安全] P2 安全小批打包（P2·加固）｜小｜来源：audit P2-5/6/7/8/9/10/11 ✅ #324 (2026-09-03, PR#331)
  现状（逐项复核）：password.js:12 `SCRYPT_N=16384`；password.js:44 safeEqual 长度不等提前返回；index.js:153 全局 10mb；/health 返回 instanceCount+nodeVersion+uptime（routes/index.js:26-33）；deploy 脚本 :446 完整打印 API Key；会话无绝对过期/并发上限/惰性清理。
  **C 甄别**：七项均为小改，打包一个任务；/health 保留 `status+version`（check-update 依赖），去掉 instanceCount/nodeVersion/uptime。
  验收：scrypt N 提至 2^17（旧哈希按存储参数校验后透明升级）；safeEqual 先 SHA-256 再恒时比较；认证前 body 1MB（文件路由单独放宽）；/health 精简；部署日志 Key 掩码（前 4 位）；会话 30 天绝对存活 + 5 会话上限挤最旧 + 登录路径惰性清理过期会话；全部带测试。

## Phase A2 · 交付就绪

- [x] **A2-1** [交付] 轻量结构化日志系统（P0·功能闭环）｜中｜来源：audit D-P0-2 ✅ #325 (2026-09-03, PR#332)
  现状：全服务端裸 console.log/error；config.js:18 logLevel 零消费。
  **C 甄别**：审计给「pino 或 console 包装器」二选一。项目极简依赖哲学（utils/password.js 注释自证），**选 console 包装器、不引 pino**：logger 模块 debug/info/warn/error 四级消费 config.logLevel；error 分流独立文件；单文件 20MB×5 简单轮转；安全日志（启动横幅等）保持 stderr 习惯。systemd 场景 journalctl 说明进 README。
  验收：全服务端 console.* 收口至 logger（保留启动横幅白名单）；LOG_LEVEL 生效；error 文件分流+轮转；测试覆盖级别过滤与轮转。

- [x] **A2-2** [交付] 文档与配置纠偏批（P0/P1·bug修复）｜中｜来源：audit D-P0-4 + D-P0-5 + D-P1-2 ✅ #327 (2026-09-03, PR#336)
  现状：README.md:33 仍 gitee **master** 路径（分支 main → 404）；无升级章节；.env.example 16 项 vs config.js 实际约 20 项、NODE_ENV 未引导。
  **C 甄别**：审计 D-P0-4 的「Docker 卡片」部分已过时——onboarding 卡片已重构为「官方镜像发布后可用」引导（DeployMode 含 docker/manual），与 roadmap「不做 Docker 化」的矛盾点弱化为文案问题，仅要求：镜像真正发布前卡片不得宣称立即可用。三项合并一个任务（文档同域）。
  验收：master→main 修复；README 新增「升级」章节（重跑脚本/保留项/回滚/sha256 PR 顺序）；.env.example 补齐对齐 config.js 全量 + NODE_ENV 引导注释；手动部署补「前端 dist → public/」整合步骤；Docker 卡片文案核对。

- [x] **A2-3** [交付] 用户向导 + 核心页面截图（P1·体验升级）｜中｜来源：audit D-P1-3 ✅ #337 (2026-09-04, PR#371)
  现状：README.md:14 截图节为占位；docs/ 无 user-guide。
  验收：6-8 张核心页面截图（onboarding/仪表盘/文件/玩家/备份/审计）+「首次使用 10 分钟」docs/user-guide.md（部署→设密→建实例→启动→连服）。

- [x] **A2-4** [交付] CI 小批：覆盖率门禁 + Windows 标注 + WS 上限文档（P2·加固）｜小｜来源：audit P2-1 + D-P1-4 + P2-4 ✅ #338 (2026-09-03, PR#362)
  **C 甄别**：Windows 原生编译验证（windows-latest job）成本高、受众窄；按审计备选路线**选「README 标注实验性」**，不加 Windows job；与覆盖率门禁、WS 多设备说明合并为 CI/文档小批。
  验收：ci.yml 覆盖率上传+阈值 70%；README Windows 实验性标注；WS 32 连接多设备说明入 README。

## Phase A3 · 前端质量

- [x] **A3-1** [前端] WS 单例治理：connect 幂等 + 凭据变更重建 + 登出关闭（P0/P1·bug修复）｜中｜来源：audit F-P0-2 + F-P1-1 ✅ #311 (2026-09-03, PR#318)
  现状（2026-09-03 复核）：api/ws.ts:81-89 connect 直接 `new WebSocketImpl` 无 readyState 检查（双连接/重复派发/泄漏）；use-server-socket.ts effect 内 socketSingleton 复用旧凭据（注释称「session 变更触发重建」但实现未重建）。
  **C 甄别**：审计两条同文件同根因（单例生命周期），合并一个任务。
  验收：connect 入口 readyState 检查（CONNECTING/OPEN 直接返回既有 promise）；重连前 close 旧连接清 timer；凭据不一致时 close+重建单例；登出显式关闭；测试覆盖双 connect/换 token 重连/登出。

- [x] **A3-2** [前端] 文件上传冲突确认（P1·交互优化）｜小｜来源：audit F-P1-3 ✅ #328 (2026-09-03, PR#330)
  现状：files-page.tsx:329 注释自述「服务端落地到当前浏览目录同名覆盖」。
  验收：对齐插件页 40912 冲突流程——上传前探测同名，命中弹确认（覆盖/跳过）；危险扩展名沿用既有上传防护；测试覆盖冲突中断与确认覆盖两路径。

- [x] **A3-3** [前端] 代码卫生批：exhaustive-deps 开启 + onerror 全局兜底 + 断言清理（P1/P2·技术债）｜中｜来源：audit F-P1-5 + F-P0-1 残留 + P2-14 + P2-15 ✅ #333 (2026-09-03, PR#340)
  现状：oxlint 未启用 react-hooks/exhaustive-deps（12 处 disable 形同虚设）；main.tsx 无 onerror/unhandledrejection 注册；webhook-page.tsx:116-117 两处 `as unknown as`。
  **C 甄别**：F-P0-1 渲染崩溃兜底已闭环，残留的「事件处理器/异步异常全局兜底」并本批。
  验收：oxlint 开启 exhaustive-deps 且逐处清理 12 处 disable（确实该豁免的写明理由）；main.tsx 注册 onerror/unhandledrejection → 中文错误提示 + ErrorBoundary 引导；webhook 表单显式 payload 映射函数；P2-15 低危随批清理并在 PR 列明细。

## Phase A4 · 体验补强

- [x] **A4-1** [UX] 实例页 EULA 首启闭环（P1·交互优化）｜小｜来源：audit U-P1-1 ✅ #312 (2026-09-03)
  现状：instances-page.tsx 无 EULA 处理（仪表盘 instance-controls.tsx:80-84 已有特例）。
  **C 甄别**：审计方案合理（抽共享 mutation + 部署向导内置同意），性价比最高，优先发布。
  验收：EULA 特例抽共享 mutation；实例页启动命中 EULA 弹同意（同意即续启）；部署向导「部署并启动」闭环；测试覆盖两入口。

- [x] **A4-2** [UX] 实例状态触达：启停中间态 + 崩溃事件三断裂（P1·交互优化）｜大｜来源：audit U-P1-2 + U-P1-3 ✅ #334 (2026-09-03, PR#345)
  现状：stores 无 phase/starting/stopping；use-server-socket.ts 无 circuit_breaker case、非当前实例崩溃事件丢弃、通知条目不可跳转。
  **C 甄别**：两审计项同为「WS 状态事件 → 前端呈现」断点，同 store/事件链路，合并一个任务。
  验收：store 增 phase 字段（WS started/stopped 确认后清除），两处启停收敛同一 mutation + 按钮中间态禁用；critical 事件（crash/circuit_breaker）按实例广播入通知中心 + 条目可跳转实例页 + 持久 toast；非当前实例事件不丢弃。

- [x] **A4-3** [UX] 备份入口提升：仪表盘最近备份卡（P1·体验升级）｜中｜来源：audit U-P1-5 残留 ✅ #335 (2026-09-03, PR#342)
  现状（复核）：backup-panel.tsx:112 已有 `showAll` 展开机制（审计「硬截断 10 条」部分缓解）；残留 = 入口在设置二级页过深 + 无总数显示。
  **C 甄别**：审计原两条（分页 + 入口）收敛为入口提升一条；列表总数与展开机制补足即可，不必引入完整分页。
  验收：仪表盘增「最近备份」卡（最近 3-5 条 + 立即备份按钮 + 跳转设置）；列表显示总数。

## Phase A5 · 打磨批（P2 残余）

- [x] **A5-1** [UX] 排障与快捷路径批（P2·体验升级）｜中｜来源：audit P2-16 + P2-17 + P2-19 ✅ #343 (2026-09-03, PR#348)
  现状：command-palette 无实例操作分组（已有玩家操作与导航）；无 lastOutput/级别过滤；空态深链部分到位（topbar 已直达，6 处空态待复查）。
  验收：命令面板增「实例操作」分组（重启/备份/停止，带实例名）；崩溃横幅「查看末尾日志」（消费 lastOutput）+ 终端级别过滤 chips；复查 6 处空态 CTA 深链并补齐。

- [x] **A5-2** [设计] 组件打磨批：通知筛选 + 字号越档 + icon-button 抽象 + JVM 回填（P2·一致性）｜中｜来源：audit P2-21 + P2-22 + P2-25 + P2-12 + P2-27 ✅ #344 (2026-09-03, PR#346)
  现状（逐项复核）：notification-drawer 有「清除全部」无确认无严重度筛选；stat-cards text-3xl ×4、emergency text-5xl/extrabold；mcs/ 无 icon-button 抽象；server-terminal 渲染仍增量过滤（JVM 开关切换后历史行是否回填待复现验证）；P2-27 重复代码函数名已变待重新定位。
  **C 甄别**：P2-12 先复现再修（若 #21 屏读镜像重构已顺带修复则记录证据关闭该项）；P2-27 重新定位后若已抽公共模块同样记录关闭。
  验收：通知抽屉 severity chips + 清除全部确认；KPI ≤2xl/紧急页字重 400-600（check-design-tokens 扩展字号断言防复发）；icon-button 抽象消化高频裸按钮（清单化，不求一次清零）；JVM/重复代码两项给出复现结论。

---

## 分发顺序建议

```
A1-1 / A1-2 / A3-1 / A4-1（第一批：P0×3 + 性价比王）→ A1-3 / A1-4 / A1-5 / A2-1（第二批）
→ A4-2 / A2-2 / A3-2 / A1-6（第三批）→ A3-3 / A4-3 / A2-3 / A2-4（第四批）→ A5-1 / A5-2（收尾）
```

> 并行提示：A1-3/A1-5/A1-6 同触服务端认证/网络文件，避免同 agent 同时持有；
> A3-1 与 A4-2 都触 use-server-socket，注意先后。
