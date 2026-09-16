# 安全策略

## 报告漏洞

请勿通过公开 Issue 报告安全漏洞。请使用 [GitHub 私密安全报告](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-reviewing/privately-reporting-a-security-vulnerability)（仓库 Security 标签页 → Report a vulnerability），我们会在 7 天内响应。

## 支持版本

| 版本 | 支持状态 |
|------|---------|
| 最新 release | ✅ 支持 |
| 旧版本 | ❌ 不支持 |

## 信任模型（阅读已知设计边界后再报告）

MC Commander 是**单管理员自托管面板**，架构上不区分多租户/多角色：

- 认证模型有两条通道，任一条通过即视为完全信任的管理员：**管理员会话**（浏览器登录后持
  `Authorization: Bearer` 令牌，面板默认路径）与**全局 API Key**（`X-API-Key` 头，脚本/集成）。
  会话令牌仅以 SHA-256 落库，带滑动有效期与绝对存活期（超期强制重登）。
- 因此「实例 ID / 任务 ID 等资源标识来自请求且无租户绑定」类发现属于**设计使然**，不视为漏洞。
- 面板通过 RCON 与受管 Minecraft 服务端通信，构造并发送 MC 命令是产品核心功能，非命令注入。
- **部署建议**：面板端口（默认 25566）只应对可信网络开放，生产环境建议置于反向代理或防火墙之后，并使用强 API Key。
- **首访设密保护（一次性 SETUP_TOKEN）**：公网（0.0.0.0）部署时，「部署完成 → 管理员设密」窗口内
  任何发现端口者可抢先设密永久接管面板。部署脚本首次部署自动生成一次性 `SETUP_TOKEN` 写入 `.env`
  并随部署输出展示；配置后 `POST /auth/setup` 必须携带 `Authorization: SetupToken <token>`，
  校验通过立即作废（内存清空 + `.env` 行移除，重启后同样失效）。**公网部署必须确认 SETUP_TOKEN
  已生成**（部署输出会展示）；未配置 = 不校验，仅适用于本机/可信网络首发场景。
  存量部署可手动向 `.env` 添加 `SETUP_TOKEN=<openssl rand -hex 32 输出>` 后重启服务开启。

### API Key 的定位与信任模型（break-glass 机器凭据）

**API Key 不是「比登录更弱的旁路」，而是一把长期有效的全权凭据——请像对待管理员密码一样对待它。**

| 维度 | 实际行为 |
|---|---|
| 形态 | **单例全局凭据**：一个部署只有一把 Key（`API_KEY_HASH` 只存 SHA-256 摘要，明文仅在生成/轮换那一次响应里出现） |
| 权限范围 | **无 scope**：与管理员会话等价，可访问全部路由（含改密、关闭两步验证、删除实例、下载备份等） |
| 有效期 | **无过期**：不随会话 TTL/绝对存活期失效，也不会因管理员长期未使用而作废 |
| 与两步验证的关系 | **无条件绕过**：`middleware/auth.js` 的 API Key 分支直接放行，不要求 `totpCode`。这是**刻意为之**——两步验证保护的是交互式登录，若 Key 也要求第二因子，无人值守的自动化（备份、监控、CI）会在启用 2FA 的瞬间全部失效，用户只能被迫关闭 2FA |
| 整体关闭 | 服务端环境变量 `API_KEY_ENABLED=false`：**HTTP 与 WebSocket 上的 API Key 通道一律拒绝**（403，提示改用管理员会话登录），`POST /api/v1/rotate-key` 同样 403 且**不写 `.env`**（哈希保留，改回 `true` 即恢复） |
| 关闭后的信息面 | 设置页通过 `GET /api/v1/auth/capabilities`（认证域内，未认证 401）得知通道状态并隐藏轮换入口；未认证可达的 `/auth/status` 刻意不暴露任何部署配置 |

由此推出的操作纪律：

- **Key 泄露等同管理员密码泄露**：拿到 Key 的攻击者可以改管理员密码、关闭两步验证、读取全部
  实例文件与备份，并且**不受两步验证阻挡**。怀疑泄露时的唯一动作是立即轮换
  （`POST /api/v1/rotate-key`，旧 Key 立刻失效）或关闭通道（`API_KEY_ENABLED=false`）。
- **不要把 Key 写进会进版本库的文件**：面板配置文件、脚本、CI 变量以外的位置都算泄露面。
- **完全不需要自动化凭据的部署应当直接关闭该通道**：`API_KEY_ENABLED=false` 后浏览器登录是
  唯一入口，攻击面随之收窄（关闭不会作废已有 Key，随时可恢复）。
- **两步验证不能替代 Key 的保管**：启用 2FA 后，用 Key 通道仍可完全绕过它——这正是「Key 是
  break-glass 凭据」的含义，不是缺陷。若这个性质不可接受，请在部署层关闭 Key 通道。

### 只读机器凭据（`READONLY_API_KEY_HASH`）

需要「常驻的自动化读数」而不想交出全权凭据时使用。它与上面的全局 API Key **是两把独立凭据、
两条独立通道**：开关（`READONLY_API_KEY_ENABLED`）与 `API_KEY_ENABLED` 互不影响，关掉全权 Key
的部署仍可单独保留只读监控凭据。

| 维度 | 实际行为 |
|---|---|
| 形态 | **单例全局凭据**：一个部署只有一把只读 Key（`READONLY_API_KEY_HASH` 只存 SHA-256 摘要，明文仅在轮换那一次响应里出现），明文前缀 `mcro-`（仅便于运维辨认，鉴权只看摘要） |
| 权限范围 | **仅只读白名单 5 个端点**：`GET /overview`、`GET /system-stats`、`GET /instances`、`GET /instances/:id`、`GET /instances/:id/players`。其余 82 个端点中 **79 个一律 403**（`AUTH_INSUFFICIENT_ROLE`/40305），包括全部写操作与全部敏感读；另 3 个是认证前公开端点（`/auth/status`、`/auth/login`、`/auth/setup`），本就不经认证、与凭据角色无关 |
| 字段裁剪 | `GET /instances` 与 `GET /instances/:id` 对只读**按角色裁剪响应**：剔除 `jvmArgs`、`startCommand`（自由文本，运维常把 JMX/DB 口令写进 JVM 参数）、`javaPath`（主机目录布局）、`seed`（世界种子）；监控所需字段（`id`/`name`/`address`/`isRunning`/`playerCount`/`tps`/`mspt`/CPU/内存/`uptime`/版本等）全部保留。**管理员响应不裁剪、逐字节不变**。裁剪只发生在 `routes/status.js` 的出参构造处，角色门不改写响应体 |
| 明确不能做 | 读文件内容/目录（`files*`）、读日志原文（`logs`）、读配置内容（`properties`）、读世界数据（`world`）、读玩家存档明细与封禁记录（`players/:player/details`、`players/bans`）、下载或列出备份（`backups*`）、读命令史（`command-history`）、读审计明细（`audit-logs`）、读会话清单（`auth/sessions`）、读任务定义（`tasks*`）、读 Webhook 配置（`webhooks*`）、插件与升级/部署运维面、以及**任何**写操作 |
| 默认拒绝的方向 | 判定是「**不在白名单 ⇒ 要求 admin**」而非「逐个列举要拦谁」：新增路由无需登记即自动对只读关闭，漏登记只会更严、不会更松。回归测试从 Express 实际注册的路由表枚举全部端点并断言非白名单端点对只读 403，新端点自动纳入覆盖 |
| WebSocket | **一律拒绝握手**：Phase 1 不做事件级过滤，能开 WS 等于能订阅全量事件并借事件回执间接执行命令 |
| 有效期 | **无过期**：不随会话 TTL/绝对存活期失效 |
| 与两步验证的关系 | 与全局 API Key 相同，不走交互式登录 |
| 轮换 | `POST /api/v1/rotate-readonly-key`（**仅管理员可达**，只读凭据调用会 403/40305，无法自我提权或替换同类凭据）；明文只在响应里出现一次，旧只读 Key 立即失效；写入 `.env` 的 `READONLY_API_KEY_HASH` 行，其余键不动 |
| 通道关闭 | `READONLY_API_KEY_ENABLED=false`：**哈希已配置**时请求侧对该凭据一律 403（`READONLY_API_KEY_DISABLED`/40304），轮换端点同样 403 且**不写 `.env`**；哈希保留，设回 `true` 即恢复。该 40304 只在哈希已配置时可达——未配置时凭据恒不匹配，走下方 401 分支 |
| 未配置 | `READONLY_API_KEY_HASH` 为空 ⇒ **该通道不存在**（fail-closed）：携带任意值（含空串）都只按无效凭据处理（401/40101，**与 `READONLY_API_KEY_ENABLED` 取值无关**），不会因为「空哈希与空输入相等」而被放行 |
| 彻底关闭 | 删除 `.env` 的 `READONLY_API_KEY_HASH` 行并重启（通道消失、凭据不再被识别），或设 `READONLY_API_KEY_ENABLED=false`（保留哈希以便恢复）。**想先作废再观察**时，请用轮换端点生成新值（旧值立即失效）而不是手动删行 |

由此推出的操作纪律：

- **只读凭据也不是匿名的**：它仍是长期有效的常驻凭据，`GET /instances` 等白名单响应仍包含实例
  地址、玩家名单等运行信息——按「内部监控账号」而非「公开只读」对待。（`jvmArgs`/`startCommand`/
  `javaPath`/`seed` 已按角色裁剪，但**实例配置里不要放凭据**仍是基本原则：白名单是收窄面，不是
  凭据托管处的许可。）
- **只读凭据泄露的处置**：调用 `POST /api/v1/rotate-readonly-key` 立即轮换，或按上文彻底关闭。
- **需要敏感读请用管理员凭据**：白名单是刻意收窄的；把某个敏感端点加进白名单等同于把该数据的
  读取权交给一台常驻机器，必须作为一次安全评审来做（`middleware/auth.js` 的 `READONLY_ALLOWED`
  是唯一事实源，回归测试会钉住它的每一条）。

## 已知依赖豁免（跟踪中）

以下依赖告警目前仅有破坏性修复方案，升级方案在跟踪评估：

| 依赖 | 严重度 | 原因 | 计划 |
|------|-------|------|------|
| dompurify（monaco-editor 内置） | moderate | 修复需将 monaco-editor 从 0.56 降级到 0.53，损失编辑器能力；影响面为 Monaco 可信内容渲染 | 跟踪 monaco 上游修复 |
| uuid（exceljs 传递依赖） | moderate | exceljs 非运行时直接依赖，修复需降级 exceljs | 跟踪 exceljs 升级 |

## 安全实现要点（贡献者参考）

- 双通道认证中间件（Bearer 会话 / API Key）+ 双级速率限制（全局 + 鉴权失败）
- 玩家名白名单校验（`^[A-Za-z0-9_]{3,16}$`，同时阻断路径穿越）
- 管理命令 reason 字段清洗（移除 `; \| & \r \n` 等注入字符）
- 实例未运行时写操作守卫（统一 400 错误码，不泄露内部状态）
- 备份/恢复子进程参数化调用，不经 shell 拼接
