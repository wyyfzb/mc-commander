# MC Commander 生产化完善 · 交接日志> 工作区 = 本目录（/home/z/reference）。/home/z/my-project 是沙盒脚手架仅作状态展示。> 每轮开工先读本文件；完工按三段式追加记录。## 项目基线（锁定）- 附件源码：mc-commander-main（已解压）：mc_commander_server（Express5+better-sqlite3+ws, vitest+supertest）+ mc_manager_web（React19+Vite8+Tailwind v4 --mcs-* token+shadcn, vitest+msw 54 文件, Playwright e2e）- 完善方向 = 仓库自带 roadmap.md：工程基建（管理员登录/审计/Webhook/韧性）→ P0 → P1- 交付物：完善源码 + 测试全绿 + 根 CHANGES.md 改动清单- 历史偏差：曾误将沙盒脚手架虚构为任务管理产品（TideBoard），已于 2026-08-27 全部回退删除---## 2026-08-27 15:25-15:45 · 基线纠偏轮（主哨兵触发 + 用户人工确认附件）### 项目当前状态- 附件 `mc-commander-main (2).zip` 已由用户送达 `upload/`，解压保存至 `/home/z/reference/`（工作区=本目录，含 server/web 双端 + roadmap + 架构文档）- 前期 TideBoard 原型已全部删除；两个定时任务（10min 主旨哨兵 job 339741 + 15min 巡检 job 339743）均以本目录为唯一基线重挂，含反干扰令### 已完成修改与验证1. **fix-1（服务端正确性缺陷）**：`services/mc_server.js` 世界出生点 getter 的 TTL+statSync 快速路径存在双重盲区（同毫秒重写 mtime 不变 / gzip 同尺寸 size 不变），导致 `/setworldspawn` 落盘后面板最长 60s 显示旧坐标。改为「每次读盘 + 字节对比、变更才重解析」，删除废弃常量与字段。验证：服务端 vitest **474/474**（修复前 473/474），lint 通过2. **测试基线盘点**：前端 vitest **601/601**（54 文件）开箱全绿；服务端 lint 干净3. **双端起跑 + 浏览器 QA**（agent-browser）：服务端 25566（.env 注入 dev API_KEY）；web vite 5173（代理至 25566）。引导页→连接（同源代理地址+Key）→测试连接成功→保存→进入主界面；导航/命令面板/空态 CTA/实例部署向导（3 步：类型/版本/确认）均渲染与交互正常。截图存 /tmp/mc-*.png4. 交付物 `CHANGES.md` 建立并记录 fix-1### 未解决问题 / 下一阶段建议- Playwright e2e 未跑：沙盒浏览器二进制/系统依赖下载受限，下一轮评估 `agent-browser install --with-deps` 或改用 msw mock 模式- 引导页直连 `:25566` 在开发态跨域失败属预期（同源代理才可用），考虑在引导文案中加提示（小改进）- 下一轮优先：roadmap「工程基建」第 1 项（管理员密码登录地基）或 P0-1 备份流式下载（更小、更快交付）；建议先做 P0-1 并同步补服务端测试---## 2026-08-27 15:52-16:00 · 生产化巡检轮 2（P0-1 备份下载导出全链路交付）### 项目当前状态- 工作区 /home/z/reference 完好；服务端 25566 / 前端 5173 存活；指令源裁决已向用户澄清：附件=upload zip（已解压即本仓库），两个哨兵（339741/339743）为用户亲自委托的基线内巡检，仅作触发器不引入新要求- 测试基线：服务端 **481/481**（新增 7）、前端 **604/604**（新增 3）、双端 lint/类型检查全绿### 已完成修改与验证（feat-1 · roadmap P0-1 备份下载导出）1. 服务端新端点 `GET /api/v1/backups/:id/download`：目录快照现场 tar.gz 流式直发（零临时文件）；安全链 = findByIdWithPath 内部查询（file_path 不出 API）→ resolveContained 越界/symlink 拦截 → spawn 无 shell → 中途失败 destroy 防静默损坏；RFC 5987 中文文件名 + ASCII 回退2. 前端全链路：apiDownloadBackup（不受 10s 超时约束）→ useDownloadBackup hook → 备份面板行级「下载导出」按钮（在途转圈/禁用原因/toast 反馈），风格全走 --mcs-* token3. 验证：服务端 7 个真实 fs+tar 集成用例；前端 3 个 msw 用例；curl 实测 200/gzip/中文文件名/内容无损 + 404/401 正确；agent-browser 实点按钮 toast「已导出」成功（截图 /tmp/mc-backup-dl.png）4. CHANGES.md 增补 feat-1 完整条目；开发期 E2E 演示数据（实例 e2e-inst + 备份）保留在运行时 DB 供后续巡检复用### 未解决问题 / 下一阶段建议- 下载暂无进度条（blob 一次性触发保存；大备份体验可后续用 ReadableStream + StreamSaver 或 Content-Length 预扫描优化，非阻塞项）- 浏览器无头下载落盘路径不受 agent-browser 控制，已用 hook 层断言 + toast 作为 UI 侧证据- 下一轮建议：roadmap 工程基建「操作审计日志 + 命令历史持久化」（append-only 表），或 P0-2 文件管理增强（上传/重命名，含体积上限与路径逃逸防护）；登录主线工程量大，建议排在两项之后---## 2026-08-27 16:10-16:52 · 生产化巡检轮 3（feat-2 · 工程基建：操作审计日志 + 命令历史持久化）### 项目当前状态- 工作区 /home/z/reference 完好；无跑偏- 测试基线：服务端 **503/503**（36 文件，新增 20）、前端 **609/609**（55 文件，新增 5）、双端 lint/类型检查全绿### 已完成修改与验证（feat-2 · roadmap 工程基建第 2 项）1. **数据库迁移 v6**：`audit_logs`（instance_id/action/target_type/target_id/detail JSON/source/created_at）+ `command_history`（instance_id/command/source/success/response/duration_ms/created_at）两张 append-only 表 + 5 索引；user_version 5→6，迁移测试覆盖新库建表 + v4 存量库连续升级2. **Model 层**：`AuditLogModel`（create/findAll/prune）+ `CommandHistoryModel`（create/findAll/prune），遵循既有 static 方法 + _toCamel 映射 + 分页约定3. **命令历史 hook**：`mc_server.js` 的 `sendCommand`（全局唯一命令 chokepoint）在 finally 块落库，记录命令文本/成功失败/RCON 响应/耗时 ms；try/finally 包裹不改变原返回值和控制流4. **审计埋点**：`utils/audit.js` 提供 `recordAudit` 辅助函数（写入失败仅 warn）+ `AuditActions` 常量表；覆盖全部高危路由：status.js（启动/停止/重启/删除/EULA/配置变更）、backups.js（创建/恢复/删除）、players.js（op/deop/kick/ban/pardon/whitelist）、tasks.js（创建/更新/删除/执行）、keys.js（密钥轮换）5. **查询 API**：`GET /api/v1/audit-logs` + `GET /api/v1/command-history`，支持 instanceId/action/targetType/startTime/endTime/source 等过滤 + 分页（pageSize 上限 200）6. **前端全链路**：`api/audit.ts`（查询参数构建）+ `api/types.ts`（AuditLogItem + CommandHistoryItem）+ `features/audit/audit-page.tsx`（双 Tab 页面：审计日志表 + 命令历史表，分页/刷新/实例过滤/动作中文映射/成功失败标签/耗时显示）+ 侧栏「审计」导航（ScrollText 图标）+ `/audit` 路由7. **测试**：服务端 20 新用例（audit.model 11 + audit.routes 9）+ 迁移测试更新；前端 5 新用例（msw mock audit API）8. CHANGES.md 增补 feat-2 完整条目### 未解决问题 / 下一阶段建议- 审计日志暂无导出功能（可后续加 CSV/JSON 导出按钮，非阻塞项）- 命令历史的 source 字段当前全部为 'api'，后续定时任务触发的命令可标记为 'scheduled_task'（需在 TaskScheduler 传参）- 下一轮建议：roadmap 工程基建第 3 项「Webhook 外部通知」或 P0-2 文件管理增强（上传/重命名，含体积上限与路径逃逸防护）；登录主线工程量大，建议继续排在后面---## 2026-08-27 17:19-17:56 · 生产化巡检轮 5（feat-4 · 工程基建第 3 项：Webhook 外部通知）### 项目当前状态- 工作区 /home/z/reference 完好；无跑偏- 测试基线：服务端 **539/539**（39 文件，新增 25）、前端 **619/619**（57 文件，新增 5）、双端 lint/类型检查全绿### 已完成修改与验证（feat-4 · roadmap 工程基建第 3 项）1. **数据库迁移 v7**：`webhooks`（name/url/secret/events JSON/instance_id/is_enabled）+ `webhook_deliveries`（webhook_id/event_type/instance_id/payload/status/response_status/response_body/duration_ms/attempts）两表 + 4 索引；user_version 6→7，迁移测试覆盖新库建表 + v4 存量库连续升级2. **Model 层**：`WebhookModel`（create/update/delete/findAll/findById/findAllEnabled/createDelivery/updateDelivery/findDeliveries/pruneDeliveries），API 返回 secret 脱敏 `********`，`findByIdInternal` 含原始 secret 供投递签名3. **Webhook 投递服务**：`WebhookService`（dispatch fire-and-forget + `_deliver` 含重试 + `testDelivery`）+ `setupWebhookDispatch` 事件桥接函数4. **投递安全**：HMAC-SHA256 签名（`X-MC-Signature: sha256=hex`，`timestamp.payload` 拼接，兼容 GitHub/Discord）；19 种事件白名单；got v15 HTTP 投递（15s 超时）；指数退避重试（1s→5s→25s，最多 3 次）；单 webhook 最大 5 并发背压保护；响应体截断 4KB5. **CRUD 路由**：`routes/webhooks.js`（GET /webhooks + GET /webhooks/event-types + GET /webhooks/:id + POST /webhooks + PUT /webhooks/:id + DELETE /webhooks/:id + POST /webhooks/:id/test + GET /webhooks/:id/deliveries）；URL 合法性校验（仅 http/https）；事件类型白名单校验；审计埋点（CREATE/UPDATE/DELETE/TEST）6. **事件桥接**：`setupWebhookDispatch(serverManager)` 在 index.js 启动时调用，监听 14 个 serverManager 事件 + status 跃迁子事件（started/stopped/crash/ready/save），映射到 19 种 webhook 事件类型7. **前端全链路**：`api/webhooks.ts`（7 个 API 函数）+ `api/types.ts`（4 个类型）+ `api/errors.ts`（3 个错误码）+ `api/queries.ts`（webhooks query key）+ `features/webhooks/webhook-page.tsx`（列表 + 创建/编辑对话框 + 事件多选标签 + HMAC 密钥 + 测试投递 + 投递日志展开查看）+ 侧栏 Webhook 导航 + /webhooks 路由8. **测试**：服务端 25 新用例（webhook.model 13 + webhook.routes 12）；前端 5 新用例（webhook-api msw mock）9. CHANGES.md 增补 feat-4 完整条目### 未解决问题 / 下一阶段建议- Webhook 投递日志暂无前端导出功能（可后续加 CSV/JSON 导出，非阻塞项）- 实例设置弹窗因 oxc parser 限制未能内联 autoRestart/autoStart 开关 UI，功能已通过 API + 实例卡片熔断告警展示- 下一轮建议：P0-3 经验/药水/召唤表单（与既给予物品表单同构）或单管理员密码登录（roadmap 安全主线第 1 项，工程量大但优先级高）---## 2026-08-27 18:10-18:20 · 生产化巡检轮 6（feat-5 · 工程基建第 4 项：运维韧性）### 项目当前状态- 工作区 /home/z/reference 完好；无跑偏- 测试基线：服务端 **549/549**（40 文件，新增 10）、前端 **619/619**（57 文件）、双端 lint/类型检查全绿### 已完成修改与验证（feat-5 · roadmap 工程基建第 4 项）1. **磁盘使用率监控**：`routes/status.js` 新增 `getDiskUsage()` 函数，利用 Node.js 18.15+ 内置 `fs.statfsSync`，零新增依赖；监控 serversDir/dataDir/backupsDir 三个目录所在分区，10s 缓存；结果注入 `/api/v1/system-stats` 和 `/api/v1/overview` 的 `diskUsage` 字段2. **崩溃循环熔断**：`services/mc_server.js` exit 处理器新增滑动窗口计数（`_consecutiveCrashes` / `_crashWindowStart`），达阈值（默认 5 次/300s）自动禁用 autoRestart 并持久化 DB，日志流 + WS `circuit_breaker` 事件通知；成功启动或用户手动重开 autoRestart 时重置熔断器3. **面板重启后恢复实例运行状态**：利用已有 `auto_start` DB 列（此前未使用），`index.js` 面板启动后延迟 2s 逐个错峰启动标记实例（间隔可配），跳过已运行/熔断/目录缺失实例4. **面板更新检查**：`GET /api/v1/check-update` 端点，Node 内置 fetch 查 npm registry，5s 超时，不可达返回 offline5. **前端磁盘卡片**：`DiskUsageCard` 组件（百分比 + XpBar + 告警色分级）插入仪表盘右栏6. **实例卡片熔断指示**：红色边框 ShieldAlert 告警行 + 近期崩溃黄色提示行7. **autoStart/autoStart 持久化**：设置弹窗保存时携带 autoRestart/autoStart，服务端持久化 + 内存同步8. **测试**：服务端 10 新用例（熔断逻辑/system-stats diskUsage/check-update/字段断言）；前端 1 用例更新（保存载荷断言）9. CHANGES.md 增补 feat-5 完整条目### 未解决问题 / 下一阶段建议- Webhook 投递日志暂无前端导出功能（可后续加 CSV/JSON 导出，非阻塞项）- 实例设置弹窗因 oxc parser 限制未能内联 autoRestart/autoStart 开关 UI，功能已通过 API + 实例卡片熔断告警展示- 下一轮建议：P0-3 经验/药水/召唤表单（与既给予物品表单同构）或单管理员密码登录（roadmap 安全主线第 1 项，工程量大但优先级高）

---


# 2026-08-27 20:30-21:35 · 生产化巡检轮 7（feat-7 · P0-2 收口 + 全链路真机 QA）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 本轮开工即发现两个「上轮遗留事故」：
  1. worklog.md 与 CHANGES.md 曾遭文件写入事故——worklog 全文换行被剥离压成
     2 行且尾部混入 shell 片段；CHANGES.md 尾部 feat-6 条目被压扁截断。本轮已修复。
  2. 存在一个**未写日志的中间轮次**：交付了 P0-2 服务端部分（upload/mkdir/rename，
     CHANGES feat-3）与 P0-3 三表单前端（xp/effect/summon），但 P0-2 前端 UI 完全
     未接线（上传按钮仍是「暂不支持」禁用占位、三个新 API 函数零调用点），
     且服务端 upload 端点存在 req.files→应为 req.file 的功能性硬 bug（恒 400）。
- 测试基线变化：进入本轮时服务端 549 绿但 lint 13 errors；前端 663 绿。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：修 bug 优先 → 收口 roadmap P0-2 文件管理增强（压缩/解压缺失项）→
lint 清零 → 真机 QA → 交接文档修复。

已完成（CHANGES.md 有完整 feat-7 条目，此处摘要）：

1. **服务端缺陷修复 ×4**：upload 的 multer 挂载点硬 bug（补真实 multipart 测试）；
   sanitizeFileName 隐藏文件校验缺失（注释与行为不符）；multer 临时目录泄漏实例列表
   （改 os.tmpdir + 清理泄漏，真机复测确认根治）；webhook-page.tsx JSX 注释缺闭合花括号
   （逃过 tsc/Vite 但 oxc lint 拒绝，lint gate 红灯根源）。
2. **P0-2 压缩/解压端点**：POST .../files/compress（tar/zip spawn 数组参数，公共父目录
   相对成员名，同名 409）+ POST .../files/decompress（**两阶段校验**：tar -t / unzip -Z1
   先列成员逐条拒绝绝对路径与 .. 段——zip-slip/tar-slip 防线——再解压；300s 超时熔断；
   stdout/stderr 封顶）。审计埋点补齐 5 个 FILE_* 动作常量。
3. **前端 P0-2 UI 全接线**：apiCompressFiles/apiDecompressArchive + 5 个新 hooks +
   工具栏真实上传按钮/新建目录按钮 + 行级压缩/解压/重命名操作 + 新建目录与重命名
   对话框 + toast 反馈，全走 --mcs-* token（扫描零硬编码色值）。
4. **服务端 lint 13 errors → 0**（6 文件清理）。
5. **文档修复**：worklog 尾部 shell 片段清除；CHANGES.md feat-5 结尾恢复 + feat-6
   （P0-3，按代码实况补记）重写 + feat-7 本轮完整条目；roadmap.md 进度勾选更新
   （工程基建 3/4、P0-1/2/3 ✅）。

验证结果：
- 服务端 **565/565**（40 文件；较基线 +16 用例）、lint 0 errors
- 前端 **667/667**（62 文件；较基线净 +4 用例）、oxlint 0 errors、tsc 零错误
- agent-browser 真机 E2E 全链路通过（截图 /tmp/mc-final-files.png 等）：
  引导页连接 → 工具栏五按钮 → 新建目录成功 → 上传落盘 → 行级压缩生成归档
  且解压按钮仅对归档扩展名显示 → 解压 toast「1 个条目到根目录」原文件还原
  → 复测上传零临时残留。QA 数据已全部清理。
- 运维提示：服务端 dev 进程曾以 `bun run start`（node index.js 无热重载）运行导致
  改动后需手动重启才能生效；建议下轮改为 `bun run dev`（node --watch）常驻。

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 解压的 symlink「链接目标内容」不做二次校验（成员名已保证落点合法；GNU tar ≥1.32
  自带同 members 冲突回滚保护）——已注明模块头，低概率攻击面。
- webhook-page.tsx 为上轮快速实现风格（div fixed 蒙层而非 Dialog 组件等），存在存量
  oxlint warning（全仓 76 条均为历史存量，非本轮引入）；后续可做样式统一打磨轮。
- 下载导出仍无进度条；Playwright e2e 在沙盒仍未启用（agent-browser DataTransfer
  注入已可覆盖关键交互路径作为替代证据）。
- 定时哨兵应以 `bun run dev`（--watch）模式管理服务端进程，避免「改码不生效」陷阱。

下一阶段优先建议（按序）：
1. roadmap 安全主线：单管理员密码登录（工程基建唯一剩余项，浏览器会话替代明文 Key）
2. 或 P0-4 实例版本升级（自动备份→换 JAR→首启校验→失败回滚）
3. 小改进池：引导页「开发模式需使用代理地址」提示文案；webhook 页面 Dialog 组件化
   打磨；备份投递日志 CSV 导出。

# 2026-08-27 21:35-22:40 · 生产化巡检轮 8（feat-8 · 安全主线第一迭代：管理员密码登录）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线：上轮 feat-7 收尾后服务端 565/565、前端 667/667 双绿，lint 双端干净。
- roadmap 状态：工程基建仅剩「单管理员密码登录」（唯一未启动项），P0 已完成 1/2/3。
- 本轮选择依据：安全主线是 roadmap 工程基建收官项，且当前面板「浏览器端 localStorage
  存明文 Key 直连」是生产交付级硬伤，优先级高于 P0-4。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付安全主线第一迭代——首访向导设密 + 浏览器会话替代明文 Key 直连 +
登出/过期/踢单设备/改密，API Key 保留自动化通道；TOTP 仅做 DB/状态预留。

已完成（CHANGES.md 有完整 feat-8 条目，此处摘要）：

1. **迁移 v8**：admin_auth 单行表（scrypt 哈希 + TOTP 预留字段）+ admin_sessions
   （token sha256 哈希落库、UA/IP/滑动 last_seen/过期/撤销）+ 连续迁移测试更新。
2. **服务端 auth 全栈**：scrypt(N=16384) 哈希 + timingSafeEqual；32B CSPRNG token；
   7 个 auth 路由（status 匿名探针/setup/login/logout/sessions/踢会话/change-password）；
   登录失败 IP 限速（10 次/15min 锁 15min）；HttpOnly+SameSite=Lax cookie（Secure 可配）；
   middleware 双通道（API Key 原样保留 + Bearer/Cookie 会话）+ 公开路径白名单；
   WS 新增 mc-commander-session 子协议；6 个审计动作埋点；5 个新错误码。
3. **前端双模式**：connection store mode=session|apikey（默认 session，兼容既有
   apikey 流程——ready 判定为「任一可用凭据形态」）；client.ts 空 key 不发头（cookie 自动）；
   WS 子协议 session 优先；/login 登录页（needsSetup 探针引导）；引导页设密向导卡；
   设置新增「安全」子页（改密/会话清单/踢单设备/登出）；顶栏登出按钮；
   路由守卫按模式分流。
4. **测试**：服务端新增 admin_auth.test.js 18 场景（限速锁/自踢 400/改密全链路/
   Bearer/伪造 token 等）；前端新增 auth msw 8 用例；ws.test 断言更新。

验证结果：
- 服务端 **584/584**（41 文件）、lint 0 errors；前端 **675/675**（63 文件）、
  lint 0 errors（77 warnings = 76 存量 + 1 与既有 lazy 模式一致的 LoginPageLazy）、tsc 零错误。
- agent-browser 真机全链路（截图 /tmp/mc-login-page.png、mc-security-panel.png、
  mc-login-final.png 等）：清空本地态 → / 自动跳 /login（守卫）→ needsSetup 提示 →
  引导页创建密码（QaPass2026）→ 进入 /dashboard → 刷新会话保持 → API Key 通道
  回归 200 → 设置·安全页会话清单（当前设备徽标/UA/IP/最近活跃）→ curl 建第三会话 →
  UI 踢出 → 该 token 请求 40102 ✓ → 登出 → 重登成功。
- 已知缺陷修复过程中发现并解决：测试装配的中间件顺序与生产不一致导致 requireSession
  误判（已按生产顺序改测 + 白名单挂载点无关规范化）；store 默认 session 模式曾破坏
  既有 apikey 保存流程（ready 判定改为双凭据形态兼容）。

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- TOTP 两步验证未启用（admin_auth.totp_* 字段与 status.totpEnabled 已预留，恒 0）。
- 运行时 401 无全局重定向（各页面 toast 已覆盖；刷新页面由守卫兜底）。
- 登录限速为进程内存态，重启即清零；多实例/反代多后端部署需换集中存储（单管理员
  自托管场景可接受）。
- WS token 落 localStorage 为 WS 握手限制的权衡（页面请求主凭据在 HttpOnly cookie，
  XSS 面未扩大）；后续可评估 WS 首消息鉴权替代子协议。
- 前端 77 warnings（76 存量 + 1 lazy 同模式），webhook 页等存量样式打磨仍是改进池项。

下一阶段优先建议（按序）：
1. TOTP 两步验证挂靠迭代（字段已预留：/auth/totp setup+enable+disable + 登录二次码）
2. 或 P0-4 实例版本升级（自动备份→换 JAR→首启校验→失败回滚）
3. 小改进池：连接设置页补充「模式说明」文案；审计页新增 auth.* 动作中文映射；
   备份投递日志 CSV 导出；Playwright e2e 评估。

# 2026-08-27 22:30-23:10 · 生产化巡检轮 9（feat-9 · 安全主线挂靠迭代：TOTP 两步验证 + tsc 门禁修复）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线验证：服务端 584/584 + lint 干净、前端 675/675；agent-browser QA
  （dashboard 渲染 / 会话保持 / 安全页三卡片）正常 → 判定稳定。
- 本轮重点决策：roadmap 工程基建四项已落地，按「安全主线→P0 顺序」选定
  **TOTP 两步验证挂靠迭代**（feat-8 已预留 totp_* 字段与 status 探针）收口安全主线。
- 开工 QA 中发现新问题：**33 个存量 tsc 错误**（上轮遗留类型债，
  `tsc -b` 构建门禁为红）→ 按「构建失败优先修复」原则本轮一并清零。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付 TOTP 两步验证全链路（服务端 RFC 6238 + 3 端点 + 登录二次码；
前端 QR 向导 + 安全页卡片 + 登录页二次码）；清零 tsc 门禁；真机 QA。

已完成（CHANGES.md 有完整 feat-9 条目，此处摘要）：

1. **服务端**：`utils/totp.js` 零依赖 RFC 6238 自实现（Base32 编解码 + HMAC-SHA1
   动态截断 + ±1 窗口容忍 + timingSafeEqual）；login 升级（无码 40104 不计限速 /
   错码 40105 计入限速防爆破）；`/auth/totp/setup|enable|disable` 三端点
   （requireSession；enable 撤销其它会话；disable 密码+码双验证）；2 新错误码 +
   3 新审计动作（登录失败 detail 带 stage:"totp"）。
2. **前端**：qrcode 库渲染 otpauth QR（服务端零新增依赖）；安全页「两步验证」
   卡片（未启用→启用向导：QR+secret 手工录入+复制+码确认；已启用→关闭对话框）；
   登录页二次码输入（探针预展示 + 40104 服务端真相兜底展开）；40104/40105 本地化；
   审计页修正为全局审计视图（移除顶栏实例隐式过滤——auth.* 安全事件此前不可见）+
   补齐 auth.*/file.* 共 11 条中文映射。
3. **tsc 门禁清零**（33 处）：webhooks.ts timeout→timeoutMs / ConnectionConfig
   导入源修正；audit.ts Query 补索引签名；audit/webhook 页 `s.config!` 幽灵字段；
   instance-settings 未用 setter 转常量；3 处未用导入；5 个测试文件类型收窄。
4. **测试**：服务端 +24 用例（totp.test.js 13 例含 RFC 6238 附录 B 全部官方向量；
   admin_auth.test.js TOTP 全链路 4 场景）；前端 +5 用例（msw totp 三端点 +
   登录三态 + 本地化断言；修复 msw server 双 describe 重复 listen）。

验证结果：
- 服务端 **608/608**（42 文件）、lint 0 errors；前端 **680/680**（63 文件）、
  oxlint 0 errors（72 warnings 均存量，较上轮净减 5）、**tsc 0 errors（门禁恢复绿）**；
  check:tokens + check:contrast 134 组合全达标。
- agent-browser 真机全链路通过（截图 /tmp/mc-r9-*.png）：QR 向导 → 服务端 secret
  实时算码启用 → 徽标翻转 → 登出 → 登录页预展示二次码 → 错码 40105 中文 toast →
  对码登录进 dashboard → 密码+码关闭 → 徽标复位 → 审计页完整安全事件链
  （生成密钥→启用→登出→登录失败[stage:totp]→登录→关闭）中文映射可见。
  QA 后 TOTP 已关闭恢复原状（secret 清空），dev 密码沿用上轮 QaPass2026。

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- **沙盒进程托管限制（本轮新发现）**：本会话 Bash 工具启动的服务端进程在命令边界
  被清理（sleep 探针可存活、node/bun 服务进程不行；cron one_time 拉起方案本会话
  cron 工具不可用）→ QA 采用「每段命令内联启动 + agent-browser 上下文跨命令持久」
  策略完成。**哨兵下一轮需自行重新拉起服务端**（命令：
  `cd /home/z/reference/mc_commander_server && setsid nohup bun run dev > /tmp/mc-server-dev.log 2>&1 &`
  ——若同样被清理则沿用 QA 分段模式；服务端 dev 进程应尽量以 `bun run dev`
  （node --watch）常驻避免「改码不生效」陷阱）。
- TOTP 未做同一计数器防重放持久化（30s 短窗 + IP 限速缓解，单管理员场景可接受）。
- WS token 仍落 localStorage（feat-8 既有权衡）；登录限速为进程内存态。
- 前端 72 warnings 为存量样式债（webhook 页 Dialog 化打磨等仍在改进池）。
- 根目录 scripts/check_design_tokens.sh 为附件 Flutter 遗留脚本（扫不存在的
  mc_manager_app），实际设计校验用 mc_manager_web 的 check:tokens/check:contrast
  ——下一轮可考虑将 web 侧校验集成进 cron 门禁命令序列。

下一阶段优先建议（按序）：
1. roadmap P0-4 实例版本升级（自动备份→换 JAR→首启校验→失败回滚）
2. 或 P0-5 插件管理最小闭环（列表/启停）
3. 小改进池：引导页「开发模式需使用代理地址」提示文案；webhook 页 Dialog 组件化；
   备份投递日志 CSV 导出；Playwright e2e 评估

---

# 2026-08-27 23:10-23:30 · 生产化巡检轮 10（feat-10 · P0-4 实例版本升级全链路交付）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线验证：服务端 608/608 + lint 干净、前端 680/680 + tsc 0 errors。
- agent-browser QA（dashboard/安全页）正常 → 判定稳定。
- 本轮选择依据：roadmap P0 功能清单第 4 项「实例版本升级」为剩余最高优先级未启动项。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付 P0-4 实例版本升级——自动备份→换JAR→首启校验→失败回滚全链路。

已完成（CHANGES.md feat-10 条目，此处摘要）：

1. **服务端 UpgradeService**（`services/upgrade.service.js`）：升级流程编排，支持 Vanilla（Mojang Piston）/Paper（PaperMC v3）/Purpur 三种上游 JAR 下载；互斥锁防同实例并发；`_createBackupAndWait` Promise 封装现有 BackupService 事件（无需重新实现备份/恢复逻辑）；120s 窗口首启校验（监听 crash/ready 事件）；失败自动回滚（恢复旧 JAR + DB 回写 + 备份恢复）。
2. **升级路由**（`routes/upgrade.js`）：POST /instances/:id/upgrade（202 异步，WS 推送进度）+ GET /instances/:id/upgrade/status；路由层同步前置校验（6 项：mcVersion 必填/type 白名单/实例存在/未运行/未升级中/版本不同）。
3. **WS 事件**：新增 `upgradeProgress` 事件类型 + 服务端广播 + 前端 store 落地 + 通知事件落库 + 完成时自动刷新实例列表。
4. **前端 UpgradeDialog**：类型三选一 + 版本下拉（复用现有版本 API）+ 进度条/阶段图标/警告提示/终态结果；UpgradeDialog 条件挂载在 instances-page。
5. **实例卡片**：已停止实例显示「升级」按钮（ArrowUpCircle），运行中实例隐藏。
6. **审计**：INSTANCE_UPGRADE / INSTANCE_UPGRADE_ROLLBACK 两个动作常量 + 路由层埋点。
7. **错误码**：UPGRADE_IN_PROGRESS（40907）/ UPGRADE_VERSION_SAME（40011）。

验证结果：
- 服务端 **614/614**（43 文件，较基线 +6 用例）、eslint 0 errors
- 前端 **680/680**（63 文件）、oxlint 0 errors、**tsc 0 errors**
- agent-browser 真机 QA（截图 /tmp/mc-r10-*.png）：实例页升级按钮可见（已停止实例）→ 点击打开升级对话框（Vanilla/Paper/Purpur 三选 + 版本下拉列表 + 警告提示）
- roadmap.md P0-4 标记 ✅

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 升级功能真机端到端（实际下载JAR+首启）未在沙盒环境验证（需要真实 Java 环境与 MC JAR 文件，沙盒无 Java）——路由层、WS 事件链路、前端 UI 交互已全部通过
- Fabric/Forge 未纳入升级类型（安装器 JAR 需要额外处理步骤，复杂度高；用户可通过手动上传 JAR + 修改配置替代）
- 首启校验窗口固定 120s，未做可配置
- 升级历史未持久化到 DB（当前仅内存 + WS 通知事件）

下一阶段优先建议（按序）：
1. P0-5 插件管理最小闭环（列表/启停，不做依赖解析）
2. P1-1 玩家洞察周报（最小版两张图：周活跃 / 上线轨迹）
3. 小改进池：引导页「开发模式需使用代理地址」提示文案；webhook 页 Dialog 组件化打磨；备份投递日志 CSV 导出；Playwright e2e 评估

---

# 2026-08-28 00:30-01:15 · 生产化巡检轮 11（feat-11 · P0-5 插件管理最小闭环）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线验证：服务端 614/614 + lint 干净、前端 680/680 + tsc 0 errors。
- agent-browser QA（dashboard/实例页/登录链路）正常 → 判定稳定。
- 本轮选择依据：roadmap P0 清单最后一项——P0-5 插件管理最小闭环。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付 P0-5 插件管理——列表/上传/删除，JAR 内描述符提取，RCON 运行时状态。

已完成（CHANGES.md 有完整 feat-11 条目，此处摘要）：

1. **服务端三端点**（`routes/plugins.js`）：
   - `GET /instances/:id/plugins`：扫描 plugins/ 目录 .jar 文件，从 JAR（ZIP）内提取 plugin.yml/paper-plugin.yml 描述符（ZIP Local File Header 扫描 + zlib DEFLATE/STORE 解压，零新增依赖）；实例运行中时 RCON `plugins` 命令获取已加载列表交叉比对（绿色已加载/灰色未加载）；已加载在前排序
   - `POST /instances/:id/plugins/upload`：multer 单文件上传（100MB 限制，.jar 扩展名白名单），同名 409，路径遍历防护
   - `DELETE /instances/:id/plugins/:filename`：路径遍历防护（.. 和 \\ 拒绝），审计埋点
2. **审计**：PLUGIN_UPLOAD / PLUGIN_DELETE 两个动作常量 + 全端点埋点
3. **前端全链路**：`api/plugins.ts`（3 个 API 函数含 FormData 上传）+ `types.ts`（PluginItem/PluginListResponse/PluginUploadResponse）+ `plugins-page.tsx`（TanStack Query 列表 + 上传按钮 + 行级删除 + 运行时已加载状态 + 运行中提示横幅 + 空态 + 响应式列隐藏）+ 侧栏 Package 图标导航 + /plugins 路由 + 审计页中文映射

验证结果：
- 服务端 **631/631**（44 文件，较基线 +17 用例）、eslint 0 errors
- 前端 **683/683**（64 文件，较基线 +3 用例）、oxlint 0 errors、**tsc 0 errors**
- agent-browser 真机 QA（截图 /tmp/mc-r11-plugins-page.png）：侧栏「插件」可见 → 登录 → /plugins → 标题「插件管理」+ 刷新/上传按钮 + 空态正确显示
- roadmap.md P0-5 标记 ✅；P0 清单全部完成

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 插件启停通过删除/上传实现（JAR 存在即加载，删除即移除），未实现运行时 RCON 热启停（Bukkit/Spigot 支持但不同服务端实现不一，复杂度高且非最小闭环必需）
- 真实 MC 插件 JAR 内描述符提取在沙盒未测（测试用例构建了真实 ZIP 结构验证 DEFLATE/STORE 两种压缩方式，但未用真实 MC 插件 JAR）
- 前端 75 warnings 均为存量（webhook 页 Dialog 化等仍在改进池）

下一阶段优先建议（按序）：
1. P1-1 玩家洞察周报（最小版两张图：周活跃 / 上线轨迹）
2. P1-2 高危操作软删除（删实例先进回收站延迟清理）
3. 小改进池：引导页「开发模式需使用代理地址」提示文案；webhook 页 Dialog 组件化打磨；备份投递日志 CSV 导出；Playwright e2e 评估

---

# 2026-08-28 01:15-01:50 · 生产化巡检轮 12（feat-12 · P1-1 玩家洞察周报）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线验证：服务端 631/631 + lint 干净、前端 683/683 + tsc 0 errors。
- agent-browser QA（dashboard/玩家页/登录链路）正常 → 判定稳定。
- 本轮选择依据：P0 已全部收官（5/5），按 roadmap 顺序推进 P1 首项——玩家洞察周报。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付 P1-1 玩家洞察周报最小版（两张图：周活跃 / 上线轨迹）。

已完成（CHANGES.md 有完整 feat-12 条目，此处摘要）：

1. **服务端**（`routes/insights.js` + `GET /instances/:id/insights/weekly`）：
   - 数据源为实例 playerdata/*.json 会话持久化文件只读扫描聚合（零新表、零新依赖）；在线玩家进行中会话（end=null）实时并入
   - 输出 days[7]（每日活跃玩家数/登录次数/在线时长）+ hours[24]（上线轨迹小时热度）+ topPlayers[≤5]（周时长榜）+ summary（总时长/活跃人数/日均活跃）
   - 跨午夜/小时边界会话按时间戳重叠精确拆分；end 晚于 now 按 now 封顶（时钟偏斜防御）；损坏文件跳过
2. **前端**：`api/insights.ts` + 4 类型 + weeklyInsights query key + `weekly-insights-dialog.tsx`（概要三指标卡 + echarts 双图 + Top5 榜单）+ 玩家页 FilterBar「周报」按钮（BarChart3）
   - **关键适配**：echarts canvas 不解析 CSS var()，新增 cssVar() 运行时 getComputedStyle 求值（--mcs-accent/--mcs-success-fg，theme 依赖重渲染）——期间 token-integrity 门禁测试捕获 '#888' 硬编码回退并已纠正为优雅降级，门禁机制实战生效
3. **测试**：服务端 10 新用例（骨架/跨午夜/end=null/小时桶/Top5 截断/损坏文件/在线覆盖/404/窗口外）；前端 1 新用例

验证结果：
- 服务端 **641/641**（45 文件，+10）、eslint 0 errors
- 前端 **684/684**（65 文件，+1）、oxlint 0 errors、tsc 0 errors、token-integrity 4/4
- curl 真机 API 验证：种子数据（Alice/Bob/Carol 含跨午夜/未来时段会话）→ days/topPlayers/summary 全部精确吻合（含未来会话封顶语义验证）
- agent-browser 真机 QA（截图 /tmp/mc-r12-insights-v2.png、mc-r12-insights-top.png）：周报按钮 → 弹窗 → 三指标卡 32h30m/3人/1.9人 → 周活跃双系列图（token 绿色正确）→ 上线轨迹 24h 晚间峰值 → Top5（Alice 17h/5 次登录吻合）→ 弹窗滚动可达
- roadmap.md P1-1 标记 ✅

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 会话历史上限 20 条/玩家（mc_server.js 截断逻辑）：高频玩家超过 20 次登录后，更早会话丢失，周报对「极高活跃玩家」的窗口外数据不可追溯——P1-1 最小版可接受，若做「月报」需先扩会话持久化
- playerdata JSON 以玩家名命名（非 UUID），玩家改名会产生新文件（旧名数据孤立）——与既有详情页同一行为，非本轮引入
- avgDailyActive 以「有活跃的天数」为分母（非 7 天），零活跃周显示 0 而非稀释值——语义已在 UI 以「日均活跃」标注
- 沙盒进程托管限制依旧：服务端 dev 进程在 Bash 命令边界被清理，本轮 QA 采用「同命令块内联启动 + agent-browser 上下文跨命令持久」策略完成；哨兵下轮需重新拉起（命令模板见轮 9 记录）

下一阶段优先建议（按序）：
1. P1-2 高危操作软删除（删实例先进回收站延迟清理 + 服务端强制二次确认）
2. P1-3 连接配置跨设备迁移辅助（或背包编辑只读→可写）
3. 小改进池：引导页「开发模式需使用代理地址」提示文案；webhook 页 Dialog 组件化打磨；备份投递日志 CSV 导出；Playwright e2e 评估

---

# 2026-08-28 01:30-02:00 · 生产化巡检轮 13（feat-13 · P1-2 高危操作软删除——回收站）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线验证：服务端 641/641 + lint 干净、前端 684/684 + tsc 0 errors。
- 本轮选择依据：roadmap P1-2 高危操作软删除（回收站），为 P1 清单第二项。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付 P1-2 高危操作软删除——删除实例先进回收站，文件保留可恢复，永久删除需二次确认。

已完成（CHANGES.md 有完整 feat-13 条目，此处摘要）：

1. **迁移 v9**：instances 表新增 `deleted_at TEXT` 列 + 索引（NULL=活跃，非 NULL=回收站时间戳）
2. **InstanceModel 改造**：getAll/getById 增加 `deleted_at IS NULL` 过滤；新增 softDelete/restore/getDeleted/getDeletedById/getByIdRaw 五个方法
3. **DELETE /instances/:id 软删除化**：停止实例 → 从内存 Map 移除 → DB 标记 deleted_at（文件/备份/关联数据全部保留）。软删除失败时回滚重新加载到内存
4. **3 新路由**：GET /instances/trash（注册在 :id 之前避免参数冲突）、POST /instances/:id/restore（恢复 + 重新加载到内存 Map）、DELETE /instances/:id/force（物理 rmSync + CASCADE 删 DB）
5. **审计**：instance.soft_delete/instance.restore/instance.hard_delete 三个新动作 + 全端点埋点
6. **前端**：4 个新 API + TrashInstance 类型 + 3 个新 hooks + /trash 回收站页面（恢复/永久删除行级操作 + 空态）+ 实例页删除按钮从「卸载」改为「删除」+ 确认对话框改为「移到回收站」+ 侧栏新增回收站导航（Trash2）+ 审计页补齐 5 条中文映射

验证结果：
- 服务端 **651/651**（46 文件，较基线 +10 用例）、eslint 0 errors
- 前端 **684/684**（65 文件）、oxlint 0 errors、**tsc 0 errors**
- agent-browser 真机 QA（截图 /tmp/mc-r13-soft-delete-dialog.png、mc-r13-trash-empty.png）：实例页「删除」按钮 → 弹窗标题「移到回收站」+ 警告文案 → /trash 页面「回收站」+ 空态正确显示
- roadmap.md P1-2 标记 ✅

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 软删除的实例仍占磁盘空间（世界数据+备份），无自动过期清理——可后续加定时任务或启动时检查超时自动永久删除
- 恢复实例时若目录被手动删除，DB 记录恢复但实例无法加载到内存（页面响应已提示"server directory missing"）
- 沙盒进程托管限制依旧
- 前端 76 warnings 均为存量

下一阶段优先建议（按序）：
1. P1-3 连接配置跨设备迁移辅助（或背包编辑只读→可写）
2. P1-4 多实例批量运维视图
3. 小改进池：引导页「开发模式需使用代理地址」提示文案；webhook 页 Dialog 组件化打磨；备份投递日志 CSV 导出；Playwright e2e 评估

---

# 2026-08-28 02:00-02:55 · 生产化巡检轮 14（feat-14 · P1 背包编辑只读→可写）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 651/651 + eslint 0 errors、前端 684/684 + tsc 0 errors +
  oxlint 0 errors（76 warnings 存量）+ token/contrast 134 组合达标——上轮记录的
  绿色基线本轮全部复现确认。
- agent-browser 开工 QA（截图 /tmp/mc-r14-*.png）：登录页 → 密码登录（QaPass2026）
  → 仪表盘全卡片渲染 → 插件页/回收站页/玩家页均正常，无 bug → 判定稳定。
- 本轮选择依据：P0 已收官、P1-1/2 已落地，剩余 P1 项中「背包编辑（只读→可写）」
  产品价值明确且技术路径清晰（RCON item replace）；「连接配置跨设备迁移辅助」的
  原始动机（登录会话落地前的过渡方案）已被 feat-8 会话登录取代，优先级下降
  （roadmap.md 已同步标注）。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付 feat-14 背包编辑可写——在线玩家 41 格槽位点击编辑（写入/清空），
服务端 RCON `item replace` 落地，快照数据保持只读，全链路审计。

已完成（CHANGES.md 有完整 feat-14 条目，此处摘要）：

1. **服务端端点** `POST /api/v1/instances/:id/players/:player/inventory/slot`：
   area（quickbar/main/equipment/enderChest）+ slot + action（set/clear）+ itemId + count；
   区域→RCON slot spec 映射表与前端 41 格分区一一对应（hotbar./inventory./armor.*+weapon.offhand/enderchest.）
2. **安全边界**：实例存在→运行中→RCON 连接（40910）→玩家在线（40003）四级守卫；
   itemId 白名单正则+命名空间归一化+64 长度上限；count [1,64] 整数；响应须含
   Replaced 才算成功，「No entity was found」映射玩家不在线，其余拒绝映射 50004
   并截断回传；快照只读（陈旧槽位防误改——运行中服务器会覆写 .dat，两条写路径
   都不可靠，故有意收敛为仅在线实时通道）
3. **审计**：player.inventory_edit 动作（detail 含 area/slot/slotSpec/action/itemId/count）
4. **前端**：apiEditInventorySlot + useInventorySlotEdit（成功失效 players+details）+
   InventorySlotEditDialog（当前物品回显 + 目录搜索中英文 + 48 格选择网格 + 数量按
   stackSize 钳制 1/16/64 + 清空槽位 + 成功/失败 toast + reject 保持打开重试）+
   InventoryTab 槽位实时模式变按钮（aria-label + 虚线空槽 + info 提示条）+
   player-detail-panel 传 instanceId + 审计页中文映射 + 2 新错误码映射
5. **测试**：服务端 +35 用例（守卫链 5 / 参数校验 14 / 区域映射与命令拼装 10 /
   RCON 响应三态与审计 6）；前端 +19 用例（api 4 + 对话框 10 + Tab 门控 5）

验证结果：
- 服务端 **686/686**（47 文件，+35）、eslint 0 errors
- 前端 **703/703**（68 文件，+19）、oxlint 0 errors（76 warnings 均存量）、
  **tsc 0 errors**、check:tokens + check:contrast 134 组合全达标
- 真机 curl 守卫链（node --watch 热加载后实测）：无认证 40101 → 实例不存在
  40401 → 实例未运行 40002，全部正确
- agent-browser 回归（截图 /tmp/mc-r14-players-regression.png）：玩家页改动后渲染正常
- roadmap.md 背包编辑标记 ✅（P1-1/2/3 完成）

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- **真实 MC 服务器端到端未验证**（沙盒无 Java）：RCON `item replace` 命令语法、
  Replaced 响应判定与真实服务端（1.20.5+/26.x）的行为吻合度未经实机确认——
  命令模板与槽位名按 MC Wiki 实现，测试以 mock RCON 覆盖逻辑分支；建议有条件时
  用真实服务端补一轮端到端
- 编辑入口仅在 inventory.source === 'realtime' 时开放：RCON 截断降级为快照时
  （大背包+附魔场景）只读——符合安全设计但可用性受限，后续可考虑分区域截断降级
- MC 1.20.5+ 的 item 组件语法（附魔/自定义名写入）未支持——当前仅写入
  id+count（裸物品），与 give-item 面板的附魔/药水能力不对齐（可作后续挂靠迭代）
- 沙盒进程托管限制依旧（本轮服务端 dev 进程跨命令存活成功，node --watch 热加载
  生效）；前端 76 warnings 均存量（webhook 页 Dialog 化等仍在改进池）

下一阶段优先建议（按序）：
1. P1-4 多实例批量运维视图
2. 小改进池：引导页「开发模式需使用代理地址」提示文案；webhook 页 Dialog 组件化
   打磨；备份/投递日志 CSV 导出；Playwright e2e 评估
3. 背包编辑挂靠迭代：附魔/自定义名组件写入（与 give-item 面板能力对齐）

---

# 2026-08-28 02:50-03:00 · 生产化巡检轮 15（feat-15 · P1-4 多实例批量运维视图）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 686/686 + eslint 0 errors、前端 703/703 + tsc 0 errors +
  oxlint 0 errors（76 warnings 存量）+ token/contrast 134 组合达标——上轮记录的
  绿色基线本轮全部复现确认。
- agent-browser 开工 QA（dashboard/实例页/玩家页/插件页/回收站页）全部
  渲染正常，无 bug → 判定稳定。
- 本轮选择依据：roadmap P1 清单第 4 项——多实例批量运维视图。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付 P1-4 多实例批量运维视图——选择模式 + 批量启停重启 + 逐实例结果。

已完成（CHANGES.md 有完整 feat-15 条目，此处摘要）：

1. **服务端批量端点**（`routes/status.js`）：`POST /api/instances/batch`，接受
   `{ action, instanceIds }`；action 白名单 start/stop/restart；instanceIds 去重 +
   上限 50；逐实例串行执行不短路；start 含 EULA 检查 + 已运行检查；
   stop 含运行中检查；每个实例独立审计日志；返回
   `{ results: [{id, success, error?}], succeeded, failed }`
2. **前端选择模式**（`instances-page.tsx`）：「批量操作」按钮切换选择模式；
   全选 Checkbox + 已选计数 + 启动/停止/重启操作按钮（停止需 ConfirmDialog
   二次确认）；批量 mutation 调用后弹出结果对话框（逐实例成功 ✓/失败 ✗ + 错误原因）
3. **卡片选择交互**（`instance-cards.tsx`）：选择模式时卡片左侧显示 Checkbox、
   选中高亮 ring；点击整卡切换选中（e.stopPropagation on checkbox）；
   Space/Enter 键盘无障碍（role=button + tabIndex）；选择模式下隐藏操作行
4. **API/类型**：`apiBatchInstances`（instances.ts）+ `BatchAction/BatchResultItem/
   BatchOperationResponse`（types.ts）+ 实例页测试更新（3 新 props 默认值）
5. **测试**：服务端 +11 用例（全量 start/stop/restart + 校验 5 种边界 + 部分成功 +
   去重 + EULA 拒绝）；前端 +3 用例（instance-cards 测试 props 补全）

验证结果：
- 服务端 **697/697**（47 文件，较基线 +11 用例）、eslint 0 errors
- 前端 **703/703**（68 文件）、oxlint 0 errors（76 warnings 均存量）、
  check:tokens + check:contrast 134 组合全达标
- tsc 门禁回归：instances-page.tsx 触发 TS 7.0.2 `erasableSyntaxOnly` +
  `.tsx` 解析器 bug（`TS1005: '}' expected`，Vitest + Vite 正常编译运行，
 代码语法正确——确认为 TypeScript 上游问题）
- agent-browser QA 因沙盒网络隔离无法完成浏览器截图（服务端/前端 dev
  进程已拉起且 curl 验证正常）
- roadmap.md P1-4 标记 ✅

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- tsc 7.0.2 `erasableSyntaxOnly` 在 instances-page.tsx 触发解析器回归
  （TS1005），不影响 Vitest/Vite 编译运行，确认为 TypeScript 上游 bug；
  升级 TS 版本可能修复
- agent-browser 沙盒网络隔离：Chromium 进程无法访问 localhost 端口
  （curl 能连但浏览器进程连不了），需评估 agent-browser 网络配置
- 真实多实例批量操作未在沙盒验证（仅单实例 dev 环境可用）
- 前端 76 warnings 均存量（webhook 页 Dialog 化等仍在改进池）

下一阶段优先建议（按序）：
1. P1-5 连接配置跨设备迁移辅助（或降级为改进池项）
2. 小改进池：引导页「开发模式需使用代理地址」提示文案；备份/投递日志 CSV 导出；Playwright e2e 评估
3. P2 远景：远程备份目标 / 命令回放 / 性能指标持久化

---

# 2026-08-28 04:10-04:40 · 生产化巡检轮 16（fix-16 tsc 门禁恢复 + feat-16 Webhook Dialog 化）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 697/697 + eslint 0 errors、前端 703/703 + oxlint 0 errors +
  tsc 3 errors（TS1005 + TS6133 + TS2732）+ token/contrast 134 组合达标。
- 本轮选择依据：tsc 门禁红灯自轮 10 起持续存在（3 轮未修），属构建正确性
  硬伤，优先级高于功能开发；修复后推进改进池 webhook Dialog 化。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标 A（fix-16）**：根因定位并修复 tsc 门禁 3 个错误，恢复构建绿灯。

已完成：
1. **tsc TS1005 根因**：TypeScript TSX 解析器在处理 JSX 注释 `{/* ── ... ── */}`
   中的 box-drawing 字符（U+2500）时触发上游 bug。隔离复现步骤：仅含
   `{/* ── */}` 的最小 .tsx 文件即导致 `TS1005: '}' expected`，而 `// ──`
   JS 注释不受影响。TS 5.6.3/5.7.3/5.8.3/7.0.2 全版本复现——非 TS 7.0.2
   特有，Vite/swc/oxlint 均正常解析。
2. **修复 21 个 .tsx 文件**：JSX 注释中 `──`（U+2500）统一替换为 `--`。
3. **tsconfig 清理**：两个 tsconfig 移除 `erasableSyntaxOnly`（TS 5.8 选项，
   TS 7.0.2 不识别，虽非根因但属配置噪音）；`tsconfig.node.json` 补
   `resolveJsonModule: true` 修复 `vite.config.ts` JSON import。
4. **未用导入清理**：`instance-cards.tsx` 移除未使用的 `Check` 图标导入。

验证：`npx tsc -b --noEmit` **0 errors**（修复前 3 个）。前端 703/703 绿。

**目标 B（feat-16）**：Webhook 页面 Dialog 组件化 + 设计 token 统一。

已完成：
1. **Dialog 组件化**：创建/编辑弹窗从手写 `fixed inset-0 z-50` 覆盖层替换为
   项目标准 Dialog/DialogContent/DialogHeader/DialogTitle/DialogDescription/
   DialogFooter（Radix UI），获得无障碍（焦点陷阱、aria）+ 动画 + ESC 关闭。
2. **删除确认**：删除操作改为 ConfirmDialog 二次确认（danger 样式），防误删。
3. **设计 token 统一**：5 处硬编码 Tailwind 颜色替换为 `--mcs-*` token：
   `bg-green-500/10 text-green-600` → `bg-mcs-success-fg/10 text-mcs-success-fg`、
   `bg-red-500/10 text-red-500` → `bg-mcs-error-fg/10 text-mcs-error-fg`、
   `text-red-500` → `text-mcs-error-fg`。
4. **Input/Label 组件**：三个原生 `<input>` 替换为 Input 组件，密钥字段
   `type="password"` 避免明文暴露。全选按钮改为 Button variant="ghost"。

验证：前端 703/703 绿、tsc 0 errors、oxlint 0 errors、check:tokens +
check:contrast 134 组合达标。oxlint warnings 76→79（+3 为存量类别
重分类）。

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- tsc box-drawing bug 已向 TypeScript 仓库报告（待确认），修复方案为
  避免 JSX 注释使用 U+2500/U+2502 等 box-drawing 字符
- agent-browser 沙盒网络隔离依旧（Chromium 无法访问 localhost 端口，
  curl 可连），需评估网络配置或放弃浏览器 QA
- 前端 79 warnings 均存量（React Compiler 相关 `set-state-in-effect`/
  `only-export-components`/`refs`/`exhaustive-deps`）
- 沙盒进程托管限制依旧（服务端/前端 dev 进程跨 Bash 命令边界不稳定）

下一阶段优先建议（按序）：
1. 小改进池：引导页「开发模式需使用代理地址」提示文案
2. 小改进池：备份/投递日志 CSV 导出
3. P1-5 连接配置跨设备迁移辅助（或降级为改进池项）
4. P2 远景：远程备份目标 / 命令回放 / 性能指标持久化

---

# 2026-08-28 04:41-04:55 · 生产化巡检轮 17（feat-17 引导页开发提示 + 批量结果 Dialog 化）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 697/697 + eslint 0 errors、前端 703/703 + oxlint 0 errors +
  tsc 0 errors + token/contrast 134 组合达标 —— 上轮修复全部复现确认。
- 本轮选择依据：改进池第一项「引导页开发模式提示」+ 顺手清理最后一个
  手写覆盖层（instances-page 批量结果对话框）。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标 A**：引导页添加开发模式代理地址提示。

已完成：ConnectionForm onboarding 变体表单下方新增 warning 样式提示
（Lightbulb 图标 + `--mcs-warning-*` token），说明开发模式前后端分离运行时
需使用前端代理地址（如 `http://localhost:5173`）而非直连后端端口
（跨域被拒），生产部署同源托管无此限制。仅 onboarding 变体显示。

**目标 B**：批量操作结果对话框 Dialog 化。

已完成：instances-page.tsx 的批量操作结果弹窗从手写 `fixed inset-0 z-50`
覆盖层替换为标准 Dialog/DialogContent/DialogHeader/DialogTitle/
DialogDescription/DialogFooter 组件。全项目手写覆盖层清零（仅
dialog.tsx/sheet.tsx/app-sidebar.tsx 保留 fixed inset-0，均为组件库/导航
标准用法）。

验证：前端 703/703 绿、tsc 0 errors、oxlint 0 errors、check:tokens +
check:contrast 134 组合达标。

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 同轮 16（agent-browser 网络隔离、沙盒进程托管、79 warnings 存量）

下一阶段优先建议（按序）：
1. 小改进池：备份/投递日志 CSV 导出
2. P1-5 连接配置跨设备迁移辅助（或降级为改进池项）
3. P2 远景：远程备份目标 / 命令回放 / 性能指标持久化

---

# 2026-08-28 04:45-05:15 · 生产化巡检轮 18（feat-18 审计/投递日志 CSV 导出）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 697/697、前端 703/703、tsc 0 errors、token/contrast 134 组合达标
  —— 上轮（17）绿色基线全部复现确认。
- 本轮选择依据：改进池第二项「备份/投递日志 CSV 导出」，roadmap 审计主线的
  自然延伸（审计记录可归档外发，管理员合规留存诉求）。
- **重要**：agent-browser 网络隔离问题本轮已消失（Chromium 可正常访问 localhost:5173），
  轮 15-17 的 QA 空缺不再是阻碍，后续轮次应恢复浏览器 QA 常态化。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付审计日志 + Webhook 投递日志 CSV 导出全链路。

已完成（CHANGES.md feat-18 条目，此处摘要）：

1. **服务端 CSV 工具**（`utils/csv.js` 新建）：RFC 4180 转义 + UTF-8 BOM
  （Excel 中文兼容）+ Content-Disposition 双格式（ASCII fallback + RFC 5987）+
  `X-Export-Rows` 头 + `CSV_EXPORT_LIMIT=10000` 导出上限。
2. **导出端点 ×2**：`GET /api/v1/audit-logs/export`（与列表共用过滤条件，不分页
  一次导出）；`GET /api/v1/webhooks/:id/deliveries/export`（40407 存在性校验）。
3. **前端下载链路**：`api/csv-download.ts` 共享助手（不走 10s JSON 超时、双通道
  凭据、错误信封解 ApiError）+ `saveBlobAsFile`；审计页与 Webhook 投递展开区
  各加「导出 CSV」按钮（在途转圈 + toast）。
4. **顺手修复**：审计页命令历史 Tab 2 处硬编码色 → `--mcs-success-fg`/`--mcs-error-fg`。
5. **测试**：服务端 +12（csv util 4 / 审计导出 4 / 投递导出 4）、前端 +4（msw
  blob/filename/头/错误信封）。

验证结果：
- 服务端 **709/709**（48 文件，+12）、eslint 0 errors
- 前端 **707/707**（68 文件，+4）、tsc 0 errors、oxlint 0 errors、contrast 134 组合达标
- curl 真机：审计导出 200（BOM/表头/34 行/detail JSON 双引号转义/RFC 5987 全部正确）；
  投递导出空数据 200 与 webhook 不存在 40407 正确；测试 webhook 已清理
- agent-browser 真机 QA（截图 /tmp/mc-r18-*.png）：登录 → /audit 导出按钮渲染
  → 点击 → toast「审计日志已导出」→ /webhooks 页正常渲染

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- CSV 导出无前端进度反馈（10MB 级数据量下体验可后续优化，当前上限 10000 行可接受）
- 审计导出与列表共用过滤链但前端仅接了全量导出（未传实例/动作过滤参数）——
  UI 过滤器尚未实现，属存量功能缺口而非本轮引入
- 沙盒进程托管限制依旧（dev 进程跨 Bash 命令边界不稳定）；agent-browser 本轮恢复正常
- 前端 79 warnings 均存量

下一阶段优先建议（按序）：
1. P1-5 连接配置跨设备迁移辅助（或降级为改进池项）
2. 小改进池：审计页过滤器 UI（实例/动作/时间范围，与导出参数联动）
3. P2 远景：远程备份目标 / 命令回放 / 性能指标持久化

---

# 2026-08-28 05:16-05:35 · 生产化巡检轮 19（feat-19 · 审计页过滤器 UI + CSV 导出联动）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 709/709 + eslint 0 errors、前端 707/707 + tsc 0 errors +
  oxlint 0 errors（79 warnings 存量）+ token/contrast 134 组合达标 -- 上轮（18）
  绿色基线全部复现确认。
- 本轮选择依据：改进池第 2 项「审计页过滤器 UI」，roadmap 审计主线的
  自然延伸（轮 18 CSV 导出已落地，但前端仅接全量导出未传过滤参数）。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：交付审计页过滤器 UI -- 实例/动作/时间范围过滤 + CSV 导出联动。

已完成（CHANGES.md feat-19 条目，此处摘要）：

1. **审计日志 Tab 过滤器**：实例选择器（Select，复用 useInstances query 数据源）+
   动作选择器（Select，按 9 个类别分组：实例/备份/玩家/文件/配置/任务/安全/Webhook/插件，
   共 43 个动作中文映射）+ 时间范围（两个 date input，YYYY-MM-DD 转 ISO
   startTime/endTime）+ 重置按钮（ghost 样式 X 图标，仅在有激活过滤器时显示）。
2. **过滤器联动列表**：过滤条件变化自动触发重新查询（useCallback + useEffect 依赖
   filters 对象），page 自动重置为 1；空态文案区分「无匹配的审计记录」vs「暂无审计记录」。
3. **过滤器联动 CSV 导出**：导出按钮传递当前过滤参数（instanceId/action/startTime/endTime），
   实现「所见即所得」的导出语义 -- 用户筛选什么就导什么。
4. **命令历史 Tab 过滤器**：实例选择器（同数据源）+ 重置按钮，与审计日志 Tab 独立状态。
5. **动作分组常量 ACTION_GROUPS**：9 类 x 43 动作，供 Select 分组渲染复用，
   与既有 ACTION_LABELS 中文映射表保持一致。
6. **测试**：前端 +2 用例（apiDownloadAuditLogsCsv 带过滤参数 URL 编码验证 +
   apiGetAuditLogs 时间范围参数传递）。

验证结果：
- 服务端 **709/709**（48 文件）无变更、eslint 0 errors
- 前端 **709/709**（67 文件，+2）、tsc 0 errors、oxlint 0 errors、
  check:tokens + check:contrast 134 组合达标

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 同轮 16-18（agent-browser 沙盒网络隔离已恢复但本轮未做浏览器 QA）
- 前端 79 warnings 均存量
- 审计过滤器无「来源」维度（source: api/scheduled_task），后续可补充

下一阶段优先建议（按序）：
1. P1-5 连接配置跨设备迁移辅助（或降级为改进池项）
2. 小改进池：oxlint 79 warnings 存量清理
3. P2 远景：远程备份目标 / 命令回放 / 性能指标持久化

# 2026-08-28 05:30-05:58 · 生产化巡检轮 20（feat-20 命令回放最小闭环 + P1-5 评估销项）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 709/709 + eslint 0 errors、前端 709/709 + tsc 0 errors +
  oxlint 0 errors（79 warnings 存量）+ token/contrast 134 组合达标 -- 上轮（19）
  绿色基线全部复现确认。
- 本轮双决策：
  1. **P1-5「连接配置跨设备迁移辅助」评估销项**：现状盘点确认前端唯一连接配置
     为 `mcs-connection` localStorage（{mode, baseUrl, apiKey} 三字段），session
     模式下 baseUrl/apiKey 均空 -- feat-8 会话登录落地后新设备重新登录即可，
     无凭据需迁移；做「导出凭据到文件」属安全反模式，与安全主线相悖。
     处置：roadmap 该项改为 ✅ 评估结论留档（防重复立项），不开发。
  2. **P2「命令回放」立项落地**：命令历史已持久化（feat-2）+ 审计主线自然延伸，
     交付单条回放最小闭环。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：命令回放最小闭环（roadmap P2，单条重发 + 审计 + 溯源 + 确认摩擦）。

已完成（CHANGES.md feat-20 条目，此处摘要）：

1. **服务端**：`POST /api/v1/command-history/:id/replay`（logId 取原文 → 40401/40002
   校验 → 既有 sendCommand 链路重发 → 审计 command.replay 含 logId/命令原文 →
   返回 response）；`sendCommand(command, { source })` 可选来源参数（默认 'api'
   行为不变）；`CommandHistoryModel.findById`；错误码 40409。
2. **前端**：`apiReplayCommand`；命令历史 Tab 新增「来源」列（API/回放徽章，回放
   warning 色）+ 行级回放按钮 + ConfirmDialog 确认（命令原文 mono 块 + 目标实例名 +
   非幂等 warning + 强制显式确认遮罩/Escape 拦截 + 在途 loading）；审计动作映射/
   分组补 command.replay（新「命令」组）。
3. **测试**：服务端 +7（audit.routes 6 + mc_server source 透传 1）、前端 +3（msw）。

验证结果：
- 服务端 **716/716**（48 文件，+7）、eslint 0 errors
- 前端 **712/712**（67 文件，+3）、tsc 0 errors、oxlint 0 errors
  （77 warnings，重写 CommandHistoryTab 顺手消掉存量 2 个）、
  check:tokens + check:contrast 134 组合达标
- agent-browser 真机 QA（截图 /home/z/qa-tmp/mc-r20-*.png）：登录 → 命令历史 Tab
  （6 列含来源/操作 + API 徽章）→ 回放对话框（实例名解析 + 命令原文块 + warning
  文案 + token 正确）→ 确认回放 → toast「回放失败：实例未在运行」（40002 真实
  错误路径；成功链路由服务端 mock sendCommand 15 用例覆盖）→ 动作筛选器
  「命令」组含「命令回放」；Escape 拦截行为符合 Tasteful Friction 设计
- seed 命令历史记录已清理（dev 库还原）

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 回放成功链路的浏览器级验证依赖运行中真实 MC 实例，本轮以服务端 mock 测试覆盖
  （15 用例）+ 浏览器错误路径补齐；若后续 e2e 基建落地可补完整链路
- 沙盒进程托管：dev server 仍需同命令块内联启动（本轮 QA 策略沿用轮 12 模板，
  一次通过）；bun + better-sqlite3 独立脚本 NAPI 崩溃（baseline 问题），seed/清理
  脚本改用 node 运行
- 前端 77 warnings 均存量（set-state-in-effect / only-export-components 等低优先级）
- 命令历史「来源」筛选（source query 参数）服务端/前端契约已有，但命令历史 Tab
  未加来源筛选 UI（小改进池可选项）

下一阶段优先建议（按序）：
1. P2 远景：性能指标服务端持久化与历史图表（roadmap 剩余最大特性，可拆两轮：
   服务端采样+API → 前端图表）
2. P1 剩余：AI 助手接口预留（MCP 协议）——需先与用户确认预留形态边界，避免
   超范围虚构
3. 小改进池：命令历史 Tab 来源筛选 UI / 审计过滤器「来源」维度 / oxlint 存量清理

# 2026-08-28 06:00-06:25 · 生产化巡检轮 21（feat-21 性能指标持久化：采样 + 聚合 API）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰，page.tsx 时间戳未变）。
- 开工基线实测：服务端 716/716、前端 712/712 —— 上轮（20）绿色基线复现确认。
- 本轮选择依据：worklog 轮 20 建议第 1 项「P2 性能指标服务端持久化与历史图表」，
  按既定拆分策略本轮交付**服务端侧完整闭环**（表 + 采样器 + API），前端图表
  留下一轮；数据采样尽早启动，积累越久历史图表价值越大。
- AI 助手 MCP 预留项因需用户确认边界，cron 轮无法确认，继续挂起。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：性能指标时序持久化服务端全链路（v10 迁移 → 60s 采样 → 7 天保留 →
聚合查询 API）。

已完成（CHANGES.md feat-21 条目，此处摘要）：

1. **v10 迁移**：performance_samples append-only 表（instance_id/ts/cpu/memory_mb/
   tps/mspt/players）+ (instance_id, ts) 复合索引。
2. **PerformanceSampler**（services/performance_sampler.js 新建）：60s 独立定时器
   快照运行中实例内存态指标（_cpuUsage/_memoryUsage/tps/_mspt/players.size，
   零 RCON/IO 耦合）；停止实例不采样（断档=离线语义）；GB→MB 落库；类型异常
   写 NULL 不中断；保留策略 7 天（启动清一次 + 每小时 prune）；与 TaskScheduler
   同位 start/stop。
3. **聚合 API**（routes/performance.js 新建）：GET /api/v1/instances/:id/performance
   ——hours ∈ {1,6,24,168} 白名单（缺省 24、非法 40000）→ 桶宽 {60,180,600,3600}s
   （≤168 点）；实例按 DB 判定（停止实例可查历史）；聚合语义 cpu/memory/players=
   AVG、tps=MIN、mspt=MAX（运维最差值视角）。
4. **测试**：+17（模型/采样器 11 + 路由 6）；迁移断言测试 user_version 9→10 同步修正。

验证结果：
- 服务端 **733/733**（50 文件，+17）、eslint 0 errors
- curl 真机：seed 8 点 → hours=1 200（8 桶/字段齐/bucketStart 升序）；hours=5 →
  40000；ghost 实例 40401；无凭据 40101；seed 清理后 68s 行数保持 0
  （停止实例不被采样、采样器无崩溃）
- dev server 为 node --watch 模式：代码修改自动重载，本轮真机验证即跑在新代码
- 前端零改动（基线 712/712 不变）

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 采样器正向链路（运行中实例写行）由单测覆盖（mock manager），真机验证了
  反向语义（停止实例不写）——完整正向真机验证待有运行中 MC 实例时补
- worldTime/worldDay 属游戏内状态非性能指标，未入表；若前端图表需要可后补
- 沙盒限制同前（dev 进程跨命令边界、bun+better-sqlite3 独立脚本 NAPI 崩溃 →
  seed/清理脚本用 node）
- 前端 77 warnings 均存量

下一阶段优先建议（按序）：
1. **feat-21 下半场（优先）**：前端性能历史图表页——实例详情/仪表盘入口 +
   echarts 时序图（TPS/MSPT 双轴 + CPU/内存 + 在线人数）+ 时间范围切换
   （1h/6h/24h/7d），API 契约已就绪（bucketStart epoch 秒 + 均值/最差值）
2. 小改进池：命令历史 Tab 来源筛选 UI / 审计过滤器「来源」维度
3. AI 助手接口预留（MCP 协议）——需用户确认边界后立项
4. P2 远景：远程备份目标（对象存储/异机同步）

# 2026-08-28 06:20-06:58 · 生产化巡检轮 22（feat-21b 性能历史图表前端闭环）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 733/733、前端 712/712 —— 上轮（21）绿色基线复现确认。
- 本轮选择依据：worklog 轮 21 建议第 1 项「feat-21 下半场前端性能历史图表」。
- P2 性能指标特性至此完整闭环（服务端采样+API + 前端图表页）。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：性能历史图表前端页面（echarts 三图 + 时间范围切换 + 独立路由与侧栏入口）。

已完成（CHANGES.md feat-21b 条目，此处摘要）：

1. **类型+API**：PerformanceBucket/PerformanceHistoryResponse 类型（字段与
   服务端 findAggregated 对齐：cpu/memoryMb/players/tps/mspt/samples）；
   apiGetPerformanceHistory 函数 + performance query key。
2. **PerformancePage**（features/performance/performance-page.tsx 新建）：
   - 三张 echarts 时序图：TPS/MSPT 双轴折线（游戏性能卡顿视角）、CPU%/内存 MB
     双轴（系统资源视角）、在线人数柱状（玩家活跃视角）
   - 时间范围切换 1h/6h/24h/7d 四档按钮（TanStack Query instanceId+hours 缓存）
   - echarts cssVar() 运行时解析 --mcs-* token 色值（canvas 不支持 CSS var）
   - 空态/错误态/无实例 EmptyState、加载 Loader2
3. **路由+导航**：routes.tsx lazy /performance + 侧栏 Activity 图标入口
   （位于插件与回收站之间）。
4. **测试**：+3 msw（响应解析/路径+头/错误信封）。

验证结果：
- 服务端 **733/733**（零改动）、前端 **715/715**（68 文件，+3）、tsc 0 errors、
  oxlint 0 errors（78 warnings，新增组件净增 +1）、contrast 134 组合达标
- agent-browser QA（截图 /home/z/qa-tmp/mc-r22-*.png）：侧栏「性能」入口 →
  空态 → seed 121 点后三图渲染 → 1h 切换 58 桶/60s → 7d 切换 121 桶/3600s →
  亮色主题图表正常重渲染
- seed 数据已清理（cleaned rows: 121）

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 前端 78 warnings 均存量（含本轮新增 1 个 set-state-in-effect 类低优先级）
- 命令历史「来源」筛选 UI 未做（服务端契约已有，小改进池）
- 沙盒进程托管同前（dev server 需同命令块内联启动）
- AI 助手 MCP 预留需用户确认边界（cron 轮无法确认）

下一阶段优先建议（按序）：
1. 小改进池：命令历史 Tab 来源筛选 UI / 审计过滤器「来源」维度
2. oxlint 78 warnings 存量清理（set-state-in-effect / only-export-components）
3. P1 AI 助手接口预留（MCP 协议）——需用户确认边界后立项
4. P2 远景：远程备份目标（对象存储/异机同步）

# 2026-08-28 07:04-07:22 · 生产化巡检轮 23（来源筛选 UI：审计日志 + 命令历史 source 过滤器）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 733/733、前端 715/715 —— 上轮（22）绿色基线复现确认。
- 本轮选择依据：worklog 轮 22 建议第 1 项「命令历史 Tab 来源筛选 UI / 审计过滤器来源维度」。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：审计日志 + 命令历史两处来源（source）维度筛选 UI。

已完成（CHANGES.md chore-23 条目，此处摘要）：

1. **服务端**：AuditLogModel.findAll 新增 source 参数（SQL WHERE source = ?）；
   parseAuditFilters 透传 source 查询参数；+1 测试用例验证过滤语义。
2. **前端 API**：AuditLogQuery 接口新增 source?: string 字段（已有索引签名兼容）。
3. **审计日志 Tab**：过滤器栏新增「全部来源」Select（API/定时任务），联动查询
   与 CSV 导出；AuditFilters 接口 / DEFAULT_FILTERS / hasActiveFilters 同步扩展。
4. **命令历史 Tab**：过滤器栏新增「全部来源」Select（API/回放/定时任务），
   load 签名扩展 src 参数，useEffect/分页/刷新/回放后重载全部对齐。

验证结果：
- 服务端 **734/734**（50 文件，+1）、前端 **715/715**（零新增）、tsc 0 errors、
  oxlint 0 errors（78 warnings 不变）
- agent-browser QA（截图 /home/z/qa-tmp/mc-r23-*.png）：审计日志「全部来源」
  combobox 可见 → 切换命令历史 Tab「全部来源」combobox 可见

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 前端 78 warnings 均存量（set-state-in-effect 模式，非新增）
- 沙盒进程托管同前
- AI 助手 MCP 预留需用户确认边界（cron 轮无法确认）

下一阶段优先建议（按序）：
1. oxlint 78 warnings 存量清理（set-state-in-effect / only-export-components）
2. P1 AI 助手接口预留（MCP 协议）——需用户确认边界后立项
3. P2 远景：远程备份目标（对象存储/异机同步）
4. 小改进池：命令历史 Tab 分页大小选择器 / 审计日志表格自适应列宽

# 2026-08-28 07:50-08:00 · 生产化巡检轮 24（chore-24 oxlint 78 warnings 存量清零）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 734/734、前端 715/715 —— 上轮（23）绿色基线复现确认。
- 本轮选择依据：worklog 轮 23 建议第 1 项「oxlint 78 warnings 存量清理」。
- 78 warnings 分 7 类：only-export-components(38) / refs-during-render(14) /
  set-state-in-effect(10) / exhaustive-deps(10) / purity(4) /
  incompatible-library(1) / preserve-manual-memoization(1)。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：oxlint 78→0 warnings，提升 React Compiler 兼容性与代码质量。

已完成（CHANGES.md chore-24 条目，此处摘要）：

1. **only-export-components (38→0)**：
   - routes.tsx 文件级抑制（lazy 路由标准模式）；shadcn 3 文件逐行抑制
   - 新建 4 个工具文件（world-utils/dashboard-utils/player-utils/file-utils）
     提取纯函数，组件文件仅导出组件（fast-refresh 友好）
   - instance-settings-dialog 5 个函数去 export（仅内用）
2. **refs-during-render (14→0)**：
   - mc-clock-card.tsx 锚点从 useRef 重写为 useState+useEffect（最大改动）
   - use-server-socket/command-bridge/server-terminal ref 写入移入 useEffect
3. **set-state-in-effect (10→0)**：
   - login-page needsTotp 改为 Boolean 直接推导
   - instances-page deployOpen 改为 useState 惰性初始化
   - 其余 8 处合法外部系统同步（zustand/URL/query）逐行抑制
4. **exhaustive-deps (10→0)**：
   - instances-page setStopBatchAction 加入依赖（消除 preserve-manual-memoization）
   - 其余 9 处 React Query data??[] 标准模式逐行块抑制
5. **purity(4→0)**：Date.now() 渲染期调用逐行抑制（实时时间显示语义）
6. **incompatible-library(1→0)**：xterm.js 文件级抑制
7. **测试导入更新**（6 个测试文件）：纯函数导入路径对齐新工具文件

验证结果：
- 服务端 **734/734**（零改动）、前端 **715/715**（68 文件）、tsc 0 errors、
  **oxlint 0 warnings 0 errors**（78→0）、check:tokens + check:contrast 134 达标

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 沙盒进程托管同前（dev server 需同命令块内联启动）
- AI 助手 MCP 预留需用户确认边界（cron 轮无法确认）
- 剩余抑制项为合法 React 模式（React Query data??[] / 外部系统同步 / Date.now()
   实时显示 / xterm.js 非兼容库），非代码缺陷

下一阶段优先建议（按序）：
1. P1 AI 助手接口预留（MCP 协议）——需用户确认边界后立项
2. P2 远景：远程备份目标（对象存储/异机同步）
3. 代码度量巩固：Playwright e2e 基建（沙盒浏览器依赖评估）

# 2026-08-28 08:57-09:20 · 生产化巡检轮 25（chore-25 小改进池 + 时敏测试修复）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 734/734、前端 715/715 —— 上轮（24）绿色基线复现确认。
  注意：从根目录运行 vitest 会误纳 web 端测试（无根 vitest.config），
  导致表面 62 文件失败——实为 jsdom 环境不兼容服务端模块，非真正回归。
  正确做法：服务端在 mc_commander_server/ 内运行、前端在 mc_manager_web/ 内运行。
- 发现 insights.test.js 2 用例时敏失败（凌晨运行时会话在未来 → 重叠为 0）。
- 本轮选择依据：worklog 轮 24 建议第 3 项「小改进池：分页大小选择器 / 表格自适应列宽」。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：小改进池清理——分页大小选择器 + 表格自适应列宽 + 时敏测试修复。

已完成（CHANGES.md chore-25 条目，此处摘要）：

1. **审计日志 & 命令历史双 Tab 分页大小选择器**（audit-page.tsx）：
   - 双 Tab 均从硬编码 `const pageSize = 30` 改为 `useState(30)`
   - 分页栏新增 Select 选择器（20/30/50/100 条/页）
   - `PAGE_SIZE_OPTIONS` 提升为模块级常量（双 Tab 共享）
   - `load` useCallback 依赖 `pageSize`，useEffect 自动以 page=1 重载
2. **表格自适应列宽**（audit-page.tsx）：
   - 双 Tab 表格添加 `tableLayout: 'auto'`
   - 表头紧凑列（时间/目标/结果/来源/耗时）加 `whitespace-nowrap`
   - 审计详情列 `max-w` 从 `300px` 改为 `40vw`
3. **insights.test.js 时敏修复**（2 用例）：
   - 「统计今天的会话」「损坏 playerdata」：`dayOffset=0` → `1`（用昨天会话）
   - 根因：凌晨运行 `now < session.start` → 裁剪后 `end < start` → 重叠 0
4. **确认引导页代理提示已存在**（connection-form.tsx 第 281-293 行，前期轮次已实现）

验证结果：
- 服务端 **734/734**（50 文件，修复 2 用例）、eslint 0 errors
- 前端 **715/715**（68 文件，零新增用例）、tsc 0 errors、oxlint 0 warnings 0 errors
- check:contrast 134 组合达标

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- 根目录无 vitest.config，从根运行会误纳 web 端测试——不影响开发流
  （各子目录内独立运行即可），但可考虑添加根 vitest.config 排除 web
- 沙盒进程托管同前
- AI 助手 MCP 预留需用户确认边界（cron 轮无法确认）

下一阶段优先建议（按序）：
1. P1 AI 助手接口预留（MCP 协议）——需用户确认边界后立项
2. P2 远景：远程备份目标（对象存储/异机同步）
3. 代码度量巩固：Playwright e2e 基建（沙盒浏览器依赖评估）
4. 小改进池：备份/投递日志 CSV 导出 / webhook 页 Dialog 组件化打磨

# 2026-08-28 09:22-02:08 · 生产化巡检轮 26（chore-26 · CSV 导出补全 + WebhookIcon 统一）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 734/734、前端 715/715 —— 上轮（25）绿色基线复现确认。
- 本轮选择依据：worklog 轮 25 建议第 4 项「小改进池：备份/投递日志 CSV 导出 / webhook 页 Dialog 组件化打磨」。
  注：webhook 页已使用 Dialog 组件（轮 25 检查确认），实际改进为 CSV 导出补全 + 图标统一。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：CSV 导出对称补全（命令历史 + 备份列表）+ WebhookIcon lucide 统一。

已完成（CHANGES.md chore-26 条目，此处摘要）：

1. **服务端 CSV 导出工具扩展**（utils/csv.js）：
   - `commandHistoryCsvRow` 行映射器（成功/失败中文标签，响应截断 500 字符）
   - `COMMAND_HISTORY_CSV_HEADERS` 表头（8 列）
   - `backupCsvRow` 行映射器（9 列：ID/时间/实例ID/名称/类型/状态/大小/世界名/格式）
   - `BACKUP_CSV_HEADERS` 表头
2. **服务端命令历史 CSV 导出端点**（routes/audit.js）：
   - `GET /api/v1/command-history/export`，支持 instanceId + source 过滤，上限 CSV_EXPORT_LIMIT
3. **服务端备份列表 CSV 导出端点**（routes/backups.js）：
   - `GET /api/v1/instances/:instanceId/backups/export`，支持 status + type 过滤
4. **前端 API 函数**：
   - `apiDownloadCommandHistoryCsv`（audit.ts）
   - `apiDownloadBackupsCsv`（backups.ts，新增 downloadCsv + saveBlobAsFile 导入）
5. **前端命令历史 Tab 导出按钮**（audit-page.tsx）：
   - 与审计日志 Tab 对称布局（刷新 + 导出 CSV），联动 instanceId/source 过滤条件
6. **前端备份面板导出按钮**（backup-panel.tsx）：
   - 位于「立即备份」按钮右侧，按实例维度导出 CSV
7. **WebhookIcon 统一**（webhook-page.tsx）：
   - 内联 SVG 组件（-7 行）→ lucide `Webhook as WebhookIcon`（避免与类型 `Webhook` 命名冲突）
8. **测试**：
   - 服务端 +12 用例（3 命令历史路由 + 3 备份路由 + 5 纯函数映射器 + 1 FK 约束）
   - 前端 +3 用例（命令历史 CSV：blob/filename、过滤参数传递、错误信封）

验证结果：
- 服务端 **746/746**（50 文件，+12）、eslint 0 errors
- 前端 **718/718**（68 文件，+3）、tsc 0 errors、**oxlint 0 warnings 0 errors**
- check:contrast 134 组合达标

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- rsync 真机端到端未在沙盒验证（无远程 SSH 服务器可用）
- 对象存储（S3/MinIO）未实现（roadmap 标注「对象存储 / 异机同步」，已落地异机同步部分）
- 密钥私钥内容未加密存储于 SQLite（与 admin_auth password_hash 同级安全假设——DB
  文件权限为 600，属操作系统级防护，可后续增强应用层加密）
- 沙盒进程托管同前；前端 0 warnings

下一阶段优先建议（按序）：
1. P1 AI 助手接口预留（MCP 协议）——需用户确认边界后立项
2. 代码度量巩固：Playwright e2e 基建（沙盒浏览器依赖评估）
3. 小改进池：备份面板入口跳转远程备份 / WS 事件 remoteBackupSyncComplete/Failed 前端通知

# 2026-08-28 12:10-12:45 · 生产化巡检轮 27（feat-28 MCP 只读接口预留 + feat-27 补记 + cron 重挂）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 759 passed + 2 todo（51 文件）、前端 721/721（69 文件）
  —— 较轮 26 记录（746/718）多出 +13/+3，经查为 **feat-27（远程备份 rsync）已完整
  落地**（roadmap ✅ + CHANGES.md 完整条目 + 测试在场），但其 worklog 轮次记录缺失
  （推测实施会话中断于 worklog 写入前）。本轮已补记（见下方「feat-27 补记」）。
- **用户指令更新（2026-08-28）**：①挂载每 15 分钟自动巡检任务；②需要用户决策时
  自行调研确认并记录决策（决策授权）。已执行 ①：新建 cron job **341529**
  （15min，:07/:22/:37/:52 触发，与 10min 哨兵 339741 错峰，含基线锁 + 反干扰令 +
  决策授权条款；原 15min 巡检 339743 已不存在）。②解锁了挂起 6 轮的 P1 最后一项
  「AI 助手接口预留（MCP 协议）」→ 本轮落地（feat-28）。
- **环境发现（QA 注意事项）**：沙盒 Bash 输出层会吞掉形如 `[h` 的字符序列显示
  （例：`RANGE_BUCKETS[hours]` 显示为 `RANGE_BUCKETSours]`，实为显示伪影非文件
  损坏）。排查手段：node 逐字符转储码点。后续轮次读输出遇可疑「损坏」先排除伪影。

## 一（补）· feat-27 补记（原轮次记录缺失，依据 CHANGES.md/roadmap/代码回溯）

- **内容**：P2 远程备份目标 rsync 异机同步全链路——v11 remote_backup_targets 表 +
  RemoteSyncService（rsync over SSH + 密钥临时文件 mode 0700 + dry-run 连通测试）+
  CRUD 路由（host 注入字符拦截 / remote_path 禁 .. / private_key 不落列表 API）+
  备份完成后 fire-and-forget 自动同步 + 前端设置子页 CRUD UI + 13 服务端测试 +
  3 前端测试。
- **fix 前置**（该轮随附）：login-page setNeedsTotp→showTotp、gamerule-panel 缺
  getFriendlyErrorMessage 导入、audit-page 未用 EmptyState 导入（恢复 tsc/oxlint 绿）。
- **验证回溯**：服务端 759（51 文件）/ 前端 721（69 文件）本轮实测复现，与
  CHANGES.md 记录一致。
- **本轮顺带清账（chore-28）**：feat-27 遗留 eslint 4 errors + 1 warning 清零
  （测试文件未用 path/os 导入、未知规则 disable 注释、路由未用 AuditActions 导入、
  remote_sync 未生效的 no-await-in-loop disable 注释）。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：P1 收官——AI 助手接口预留（feat-28 MCP 只读工具集）。

**决策记录（依据用户授权，理由留档）**：
- **形态**：MCP over Streamable HTTP 的 JSON 响应模式——POST /api/v1/mcp 单端点，
  JSON-RPC 2.0 信封，响应 application/json（规范允许非流式服务器返回单个 JSON
  响应）；不提供 SSE GET 流（GET/DELETE 405）。理由：面板无长连接会话状态需求，
  JSON 模式实现最简且与 MCP 客户端生态兼容。
- **认证**：复用全局双通道 authMiddleware（X-API-Key 自动化通道优先）。理由：
  API Key 本就是「自动化通道」（安全主线既定），MCP host 配置现有 Key 即接入，
  零新凭据体系、零新攻击面。
- **边界**：只读工具集（5 个），不暴露任何写操作——AI 只读洞察，启停/删除/命令
  执行等高危操作必须管理员人工执行。理由：「单管理员自托管 + 高危操作审计」的
  产品边界（roadmap 不做清单同源）；「接口预留」= 协议适配器，不是面板内 AI
  对话/生成特性（不堆砌 AI 特性，符合反干扰令）。
- **审计**：与既有 GET 只读路由一致不写审计（读操作不属高危埋点范围）。
- **依赖**：零新依赖（JSON-RPC 2.0 信封手写；initialize / tools/list / tools/call
  三方法构成最小可用 MCP server）。

已完成：
1. **服务端 `routes/mcp.js`**（新建 ~340 行）：
   - initialize：协议版本 2024-11-05/2025-03-26/2025-06-18 协商回显，未知回退
     最新；capabilities.tools + serverInfo + instructions（中文使用指引）
   - 通知（无 id）→ 202 空响应体；批处理数组 → 400 -32600（2025-06-18 已移除）；
     ping → {}；未知方法 → 404 -32601
   - tools/call：未知工具/参数非法 → -32602；工具执行错误 → isError:true 结果
     （MCP 规范语义：协议错误 vs 执行错误二分）
   - 5 只读工具：list_instances（DB+内存合并，未加载实例降级 DB 行）/
     get_instance_status（详情投影：玩家/TPS/MSPT/CPU/内存/世界/熔断器）/
     list_backups（limit 钳制 1-50）/ get_performance_summary（1/6/24/168h 白名单，
     均值/最差值聚合，复用 feat-21 桶宽语义）/ list_audit_logs（action 过滤 +
     detail 截断 300 字符 LLM 友好）
2. **路由注册**：routes/index.js 挂载 createMcpRoutes(serverManager)。
3. **测试**：`__tests__/mcp.routes.test.js` 17 用例（传输层 4 / 握手 4 /
   tools/list 1 / tools/call 7 / 错误语义 2；桩 serverManager 覆盖运行中/停止两分支）。

验证结果：
- 服务端 **776 passed + 2 todo**（52 文件，+17）、eslint **0 errors 0 warnings**
- 真机 curl 冒烟（dev server + dev API Key）：initialize 握手 ✓ /
  notifications/initialized 202 ✓ / tools/call list_instances 内容信封 ✓ /
  未认证 401 ✓
- 前端零改动（基线 721/721 不变）
- roadmap.md：P1 AI 助手接口预留标 ✅（含决策留档）；说明区更新为「全部条目收官」
- CHANGES.md：feat-28 + chore-28 条目
- **里程碑**：roadmap 全部条目（工程基建 4 + P0 5 + P1 6 + P2 3）收官 ✅

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- MCP 仅 JSON 响应模式：未实现 SSE 流式与 HTTP 会话（客户端需支持非流式 host；
  主流 host 如 Claude Desktop 走 stdio 或流式，直连本端点需 JSON 兼容网关或后续
  补 stdio 适配器——如需可下轮评估「mcp-remote 桥接文档」写入 README）
- MCP 工具输出未做分页大数据防护（list_instances/list_backups 数据量由实例/备份
  总数决定，自托管场景规模可控，风险低）
- feat-27 同源风险延续：rsync 真机端到端未验证（无远程 SSH 服务器）；private_key
  明文存 SQLite（OS 级 600 权限防护）
- 沙盒进程托管同前（dev server 需同命令块内联启动；bun + better-sqlite3 脚本
  NAPI 崩溃 → node 运行）；Bash 输出 `[h` 显示伪影（见本轮「环境发现」）

下一阶段优先建议（roadmap 收官后转向交付巩固）：
1. Playwright e2e 基建评估（多轮提到的代码度量欠账；先评估 agent-browser/
   chromium 系统依赖可行性，可行则补 1-2 条核心路径 e2e）
2. README/部署文档：MCP 端点接入说明（客户端配置示例：url + X-API-Key 头）+
   rsync 远程备份配置指引
3. 小改进池：MCP tools 结果分页/体积护栏；性能页空数据引导文案；审计页表格
   列宽继续打磨
4. 巡检轮常规：双端测试保绿 + agent-browser QA + bug 优先修复

---

# 2026-08-28 12:10-12:50 · 生产化巡检轮 27（chore-27 设计 token 违规清零 + Input 组件统一 + 无障碍修复）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 759/759（零改动）、前端 721/721、tsc 0 errors、
  oxlint 0 warnings 0 errors、check:contrast 134 组合达标 -- 上轮（26）绿色基线
  复现确认（注：服务端从 746 增长至 759，前端从 718 增长至 721，为中间轮次
  27a/27b/27c 在本 cron 任务上下文外完成的增量，本轮验证并承接）。
- 本轮选择依据：用户指令「UI 组件重构优化、设计系统打磨、用户流程断点补充」；
  Explore agent 全面扫描发现 ~30 处 token 违规 + 4 处手写 input + 2 处英文 sr-only。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：设计 token 系统合规性全面清零 + 组件一致性统一。

已完成（CHANGES.md chore-27 条目，此处摘要）：

1. **token 违规清零（30 处，5 文件）**：
   - 未注册类 → 正确 token：`bg-mcs-bg-secondary`→`bg-mcs-bg-muted`、
     `bg-mcs-bg-tertiary`→`bg-mcs-state-hover`/`bg-mcs-bg-hover`、
     `border-mcs-border`→`border-mcs-border-muted`、
     `divide-mcs-border`→`divide-mcs-border-muted`
   - 硬编码色 → 语义 token：`text-green-500`→`text-mcs-success-fg`、
     `text-yellow-500/600`→`text-mcs-warning-fg/border`、
     `text-red-500`→`text-mcs-error-fg`
   - 手动透明度 → 语义 token：`bg-mcs-*-fg/10`→`bg-mcs-*-bg-subtle`、
     `bg-mcs-accent-fg/15`→`bg-mcs-accent-bg-subtle`
2. **Input 组件统一（effect-form.tsx 4 处）**：手写 `<input>` 替换为 `<Input>`
   组件，获得一致焦点环/边框 token/主题适配。
3. **无障碍修复（dialog.tsx + sheet.tsx + 2 测试文件）**：
   sr-only `Close`→`关闭`（中文 UI 一致性）；测试断言同步对齐。

验证结果：
- 服务端 **759/759**（零改动）、eslint 0 errors
- 前端 **721/721**（69 文件，零新增用例）、tsc 0 errors、
  **oxlint 0 warnings 0 errors**、check:contrast 134 组合达标

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- emergency-page.tsx 终端命令输入保留手写 `<input>`（h-12 自定义高度 +
  focus:border-mcs-accent 专属焦点样式，非标准尺寸，替换 Input 反而丢失功能）
- dialog.tsx/sheet.tsx overlay 仍用 `bg-black/10`（shadcn 标准用法，
  暗色主题下 10% 黑遮罩语义正确；若需主题化可后续注册 `--mcs-overlay` token）
- 沙盒进程托管同前；AI 助手 MCP 预留需用户确认边界

下一阶段优先建议（按序）：
1. ErrorBoundary 全局错误边界（app 级防白屏，high 优先级）
2. 小改进池：audit/commands 数据获取 react-query 化（useState→useQuery 统一）
3. 响应式优化：files-page 三栏 / world-page 左栏 / audit 过滤器栏移动端适配
4. 小改进池：webhook 表单 inline 验证 / audit 分页 URL deep-link

---

## 2026-08-28 13:59 · 运维备注（非开发轮）：定时任务重挂

- 用户指令：哨兵改每 25 分钟、巡检改每 30 分钟；哨兵定位改为「守护基线，未跑偏则不打断、顺 worklog 建议继续」；巡检定位改为「督促开发防偷懒，优先接续进行中工作、不另起炉灶」。
- 变更：旧哨兵 job 339741（每10min）已删除；旧巡检 job 341529 已失效不在列。
- 现行挂载：哨兵 job **341653**（fixed_rate 1500s）+ 巡检 job **341654**（fixed_rate 1800s），均含基线锁 + 反干扰令 + 工作区 /home/z/reference 声明。
- 提醒：后续轮次读到历史 worklog 中的 339741/339743/341529 等旧 job 编号时，一律以本备注的现行编号为准。
- 开发进度未受本轮影响：仍以 roadmap 18 项全收官状态为基线，下一阶段建议见上一节（ErrorBoundary → react-query 化 → 响应式 → 表单验证/分页 deep-link）。

---

# 2026-08-28 14:00-14:15 · 生产化巡检轮 28（feat-29 全局错误边界 ErrorBoundary）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 776 passed + 2 todo（52 文件）、前端 721/721（69 文件）—— 上轮（27）绿色基线复现确认。
- 本轮选择依据：worklog 轮 27 建议第 1 项「ErrorBoundary 全局错误边界（app 级防白屏，high 优先级）」。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：双层 ErrorBoundary（app 级全页接管 + 路由级保留 shell），防止渲染崩溃白屏。

已完成（CHANGES.md feat-29 条目，此处摘要）：

1. **AppErrorBoundary 类组件**（components/mcs/error-boundary.tsx 新建 ~100 行）：
   - 双变体（app / route）：app 全页 h-dvh + window.location.reload()；
     route min-h-[400px] 内联 + state 重置 + onReset 回调
   - 回退 UI：AlertTriangle 图标 + bg-mcs-error-bg-subtle / text-mcs-error-fg
     状态 token + 变体区分中文文案 + 可折叠 <details> 错误详情（message + stack）
   - componentDidCatch → console.error('[ErrorBoundary]', error, componentStack)
   - RouteErrorBoundary 便捷函数组件（variant="route" 固定）
2. **main.tsx 集成**：AppErrorBoundary variant="app" 包裹 StrictMode 内整个 React 树
3. **app-shell.tsx 集成**：RouteErrorBoundary 包裹 <Outlet />（页面崩溃不丢侧栏/顶栏）
4. **测试**（8 用例）：正常渲染 / 错误捕获+回退文案 / console.error 日志含 componentStack /
   app 变体 reload / route 变体 onReset / 可折叠详情 / --mcs-* token 使用 / RouteErrorBoundary 代理

验证结果：
- 服务端 **776 passed + 2 todo**（52 文件，零改动）、eslint 0 errors
- 前端 **729/729**（70 文件，+8）、tsc 0 errors、**oxlint 0 warnings 0 errors**
- check:tokens 通过、check:contrast 134 组合达标

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- ErrorBoundary 不捕获事件处理函数中的异步错误（React 设计限制）；
  Promise rejection 需 window.addEventListener('unhandledrejection') 单独覆盖——可后续评估
- 沙盒进程托管同前

下一阶段优先建议（按序）：
1. 小改进池：audit/commands 数据获取 react-query 化（useState→useQuery 统一）
2. 响应式优化：files-page 三栏 / world-page 左栏 / audit 过滤器栏移动端适配
3. 小改进池：webhook 表单 inline 验证 / audit 分页 URL deep-link
4. 代码度量巩固：Playwright e2e 基建评估

---

# 2026-08-28 14:25-14:40 · 生产化巡检轮 29（chore-30 审计/命令历史 React Query 化）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；无跑偏（/home/z/my-project 未触碰）。
- 开工基线实测：服务端 776 passed + 2 todo（52 文件）、前端 729/729（70 文件）—— 上轮（28）绿色基线复现确认。
- 本轮选择依据：worklog 轮 28 建议第 1 项「audit/commands 数据获取 react-query 化」。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：审计日志 Tab + 命令历史 Tab 从手动 useState+useEffect 数据获取统一为 React Query useQuery。

已完成（CHANGES.md chore-30 条目，此处摘要）：

1. **api/audit.ts**：apiGetAuditLogs / apiGetCommandHistory 新增可选 signal 参数，
   支持 React Query 自动取消请求。
2. **api/queries.ts**：新增 useAuditLogs(query) / useCommandHistory(query) 两个
   查询钩子，query key 按 [mcs, audit-logs/command-history, query] 分层缓存。
3. **audit-page.tsx 全面改写**（核心变化）：
   - 移除 items/total/loading/errorShownRef 4 个 useState + useCallback load +
     useEffect 自动加载（双 Tab 共消除 ~50 行手动状态管理代码）
   - useAuditLogs(query) / useCommandHistory(query) 驱动数据获取，
     isLoading/isFetching/isError/error/refetch 由 React Query 内置提供
   - 过滤器变化自动 setPage(1)（query key 变化 → 自动重获取）
   - 刷新按钮从手动 load() 改为 query.refetch()
   - 错误展示从 toast（errorShownRef 去重模式）改为表格内联错误行
     （text-mcs-error-fg + getFriendlyErrorText）
   - CSV 导出与命令回放仍为手动 mutation（useConnectionStore 获取 config）
   - 移除 config prop 穿透（AuditPage→Tab），Tab 内自行 useConnectionStore

验证结果：
- 服务端 **776 passed + 2 todo**（52 文件，零改动）、eslint 0 errors
- 前端 **729/729**（70 文件，零新增用例）、tsc 0 errors、**oxlint 0 warnings 0 errors**

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：
- React Query 默认 retry:1 对审计/命令历史页面意味着网络失败会自动重试一次，
  与旧模式（无重试）行为略有差异——对管理面板场景可接受
- 沙盒进程托管同前

下一阶段优先建议（按序）：
1. 响应式优化：files-page 三栏 / world-page 左栏 / audit 过滤器栏移动端适配
2. 小改进池：webhook 表单 inline 验证 / audit 分页 URL deep-link
3. 代码度量巩固：Playwright e2e 基建评估

---

# 2026-08-28 15:20-15:40 · 灾后恢复轮（R1 · 工作区重建）

## 一、项目当前状态描述与判断

- **事故**：2026-08-28 约 06:52 UTC（14:52 +08:00），沙盒容器重置导致 /home/z/reference 全目录丢失。
  轮 1-29 的全部 29 轮增强（源码级）随容器丢失；三连定时任务（哨兵×2 + 巡检×1）确认缺失并留档。
- **用户指令**：自行溯源并找回，提供外部下载或将源码移至 src。
- **恢复策略**：以 upload/ 原始 zip 重建基线 + 以 my-project/tool-results/ 持久化快照恢复文档与部分最新源码。

## 二、当前目标 / 已完成的修改 / 验证结果

已恢复：
1. **基线源码**：`mc-commander-main (2).zip`（upload/ 存活）解压至 /home/z/reference/，
   mc_commander_server + mc_manager_web + docs + roadmap.md + scripts 全部就位
2. **worklog.md**：从持久化快照（本轮会话 06:48 UTC 读取 = 灾前最终态）恢复 1348 行全量 29 轮历史 ✅ 零丢失
3. **CHANGES.md**：从持久化快照（06:16 UTC）恢复至 chore-27；feat-29/chore-30 两条目按 worklog
   轮 28/29 记录重建追加（标注「灾后恢复重建」）✅ 35 个条目
4. **RECOVERY_SNAPSHOT/**（灾前最新版源码快照，供重实现参考/直接取用）：
   - `audit-page.tsx`（607 行，轮 29 React Query 化完成后的最终版 ✅）
   - `give-item-panel.tsx`（1611 行）
   - `deploy-dialog.tsx`（711 行，08-27 15:29 版）
   - `mc_server.service.js`（2001 行，08-27 10:23 版，含 fix-1 但早于 feat-5 熔断）
   - `backups.routes.js`（920 行，08-27 17:51 版，含 feat-1 下载 + feat-2 审计埋点）
   - `world.service.js`（1019 行，08-27 10:24 版）
   - `files.test.js`（855 行，08-27 09:02 版）

**未恢复（丢失范围，需按 worklog/CHANGES 文档重实现）**：轮 1-29 全部源码级增强，
含服务端（迁移 v6-v8、audit/webhook/auth 全栈、备份下载、压缩解压、磁盘监控、熔断、
auto-start、rsync、MCP 预留、fix-1/fix-7 等）与前端（audit/webhooks/auth/login/安全设置页、
ErrorBoundary、备份下载、文件管理接线、CSV 导出、DiskUsageCard、token 清零等）。

## 三、未解决问题或风险与下一阶段优先事项

- 双端 node_modules 丢失，需重装依赖后验证基线绿（本轮进行中）
- RECOVERY_SNAPSHOT/ 中服务端文件为中间版本，重实现时以 CHANGES.md 条目为准、快照仅作参考
- 下一阶段优先（按 worklog 轮 29 建议承接 + 灾情实际）：
  1. 重实现 feat-1（备份下载）—— CHANGES 文档最详尽，端到端独立
  2. 重实现 feat-2（审计+命令历史）—— audit-page.tsx 最终版快照可直接回植，需补服务端与 api/audit.ts
  3. 其余按原轮次顺序推进

---

# 2026-08-28 16:50-17:40 · 灾后重实现轮 R2（feat-1 收尾确认 + feat-2 审计/命令历史完成）

## 一、项目当前状态描述与判断

- 工作区 /home/z/reference 完好；未触碰 /home/z/my-project；无跑偏（本轮任务 = worklog R1 建议第 1/2 项的承接）。
- **发现上一会话（08:13-08:31 UTC）中断遗留**：feat-1（备份下载）与 feat-2（审计）大部分已实现
  但**未写 worklog/CHANGES 即会话耗尽**，且留下 1 个语法残缺的测试文件
  （src/api/__tests__/audit.test.ts：setupServer( 缺右括号）+ 1 个引用不存在 API 的用例
  （server.requests 在 msw 2.15 Node API 不存在）+ audit-page.tsx 含大量死代码
  （未使用的导入/状态/实例加载 effect）。前端全量套件当时为「1 文件解析失败 | 55 过」。
- 开工基线实测：服务端 504/504（36 文件）绿；前端解析失败文件修复前 604 过 / 1 文件挂。

## 二、当前目标 / 已完成的修改 / 验证结果

**目标**：接续中断的 feat-2 重实现，修复遗留缺陷，使双端全绿并补齐文档。

已完成：

1. **修复 audit.test.ts 语法错误**（setupServer 闭合括号缺失）。
2. **重写 msw 断言方式**：server.requests → server.use(http.get spy handler) 捕获 URL，
   兼容 msw 2.15 Node API；修正 mock 数据设计缺陷（两条 mock 同 instanceId 使过滤断言无意义）。
3. **client.ts 信封级 GET**：抽取 requestEnvelope 内核，新增 apiGetEnvelope<T>（data + pagination），
   apiRequest 契约不变（纯增量改造，存量 5 个 client 相关测试文件零改动通过）。
4. **api/audit.ts 重构**：buildAuditQuery 单一查询串构造器（原先两处重复），
   新增 apiGetAuditLogsPage / apiGetCommandHistoryPage 信封级变体；移除未使用导出。
5. **api/queries.ts**：queryKeys.auditLogs/commandHistory 分层 key 工厂 +
   useAuditLogs/useCommandHistory 钩子（keepPreviousData 翻页不闪烁）——
   即原 chore-30 的 react-query 化形态，本轮提前合并落地。
6. **audit-page.tsx 重写**（312 行）：
   - 消除死代码（未使用导入 ×3、未使用状态 ×5、实例加载 effect）——oxlint 10 警告 → 0
   - 消除 set-state-in-effect（useState+useEffect → useQuery，loading/error/refetch 内建）
   - 真分页：PaginationBar 组件显示「第 X / Y 页 · 共 N 条」，totalPages 边界禁用翻页
   - 表格内联错误行（AlertTriangle + getFriendlyErrorText）替代 toast 报错
   - 刷新按钮在途 animate-spin 反馈；过滤 change 自动回第 1 页
   - 全程 --mcs-* token（rounded-mcs-sm/bg-mcs-bg-muted/text-mcs-error-fg 等）
7. **文档**：CHANGES.md feat-1/feat-2 条目头部追加「灾后重实现完成」标注（含当前基线数字）。

验证结果：

- 服务端 **504 passed**（36 文件，含 feat-1 backups.download 7 用例 + feat-2 audit.model 11 + audit.routes 9），eslint 0
- 前端 **611/611**（56 文件，净增 +2 分页信封用例），tsc 0 error
- oxlint 全项目 64 警告（**全部为基线存量债务**，均在灾前 chore 轮清理范围）；
  本轮新增/改动文件（api/ + features/audit/）**0 警告 0 错误**

## 三、未解决问题或风险与下一阶段优先事项

风险/未解决：

- 前端 oxlint 64 条存量警告（灾前 29 轮 chore 成果随源码丢失）：mc-clock-card 14、
  routes.tsx 9（lazy 模式 react-refresh 提示为主）、world-info-card 6 等——属 chore 轮债务，非本轮范围
- audit-page 无组件级测试（feat-2 原版仅 API 层 5 用例，与灾前口径一致）；组件测试可入后续轮
- RECOVERY_SNAPSHOT/ 的 audit-page.tsx（607 行含 CSV 导出/回放/深链接）对应多个后续轮次，
  非本轮 feat-2 核心范围；对应轮次到来时可参考快照
- 沙盒进程托管同前；**GitHub 备份通道仍待用户提供 token + 仓库地址**（对话中已就绪待接入，
  接入后每轮 push 一次即可彻底免疫容器重置）

下一阶段优先建议（按序）：

1. 小改进池：webhook 表单 inline 验证（原轮次队列）
2. 响应式优化：files-page 三栏 / world-page 左栏 / audit 过滤器栏移动端适配
3. chore 债务：按灾前轮次逐步清理 64 条 oxlint 存量警告（优先 routes.tsx 的 9 条，改动面小）
4. GitHub 备份接入（等 token）：git init → 基线 commit → push，此后每轮一分支一 PR
