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

- 认证模型为全局 API Key（`X-API-Key` 头）。持有 API Key 的主体即被视为完全信任的管理员。
- 因此「实例 ID / 任务 ID 等资源标识来自请求且无租户绑定」类发现属于**设计使然**，不视为漏洞。
- 面板通过 RCON 与受管 Minecraft 服务端通信，构造并发送 MC 命令是产品核心功能，非命令注入。
- **部署建议**：面板端口（默认 25566）只应对可信网络开放，生产环境建议置于反向代理或防火墙之后，并使用强 API Key。
- **首访设密保护（一次性 SETUP_TOKEN）**：公网（0.0.0.0）部署时，「部署完成 → 管理员设密」窗口内
  任何发现端口者可抢先设密永久接管面板。部署脚本首次部署自动生成一次性 `SETUP_TOKEN` 写入 `.env`
  并随部署输出展示；配置后 `POST /auth/setup` 必须携带 `Authorization: SetupToken <token>`，
  校验通过立即作废（内存清空 + `.env` 行移除，重启后同样失效）。**公网部署必须确认 SETUP_TOKEN
  已生成**（部署输出会展示）；未配置 = 不校验，仅适用于本机/可信网络首发场景。
  存量部署可手动向 `.env` 添加 `SETUP_TOKEN=<openssl rand -hex 32 输出>` 后重启服务开启。

## 已知依赖豁免（跟踪中）

以下依赖告警目前仅有破坏性修复方案，升级方案在跟踪评估：

| 依赖 | 严重度 | 原因 | 计划 |
|------|-------|------|------|
| dompurify（monaco-editor 内置） | moderate | 修复需将 monaco-editor 从 0.56 降级到 0.53，损失编辑器能力；影响面为 Monaco 可信内容渲染 | 跟踪 monaco 上游修复 |
| uuid（exceljs 传递依赖） | moderate | exceljs 非运行时直接依赖，修复需降级 exceljs | 跟踪 exceljs 升级 |

## 安全实现要点（贡献者参考）

- API Key 认证中间件 + 双级速率限制（全局 + 鉴权失败）
- 玩家名白名单校验（`^[A-Za-z0-9_]{3,16}$`，同时阻断路径穿越）
- 管理命令 reason 字段清洗（移除 `; \| & \r \n` 等注入字符）
- 实例未运行时写操作守卫（统一 400 错误码，不泄露内部状态）
- 备份/恢复子进程参数化调用，不经 shell 拼接
