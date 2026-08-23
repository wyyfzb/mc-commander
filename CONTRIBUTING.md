# 贡献指南

感谢参与 MC_Commander！无论提交 Issue、修复 Bug 还是开发新功能，都欢迎。

## 快速上手

### 环境要求

| 依赖 | 版本 |
|------|------|
| Node.js | 22+ |
| Java | 17 / 21 / 25（运行 Minecraft 实例用，按 MC 版本自动选择） |
| 操作系统 | Windows / Linux / macOS 均可开发 |

### 搭建步骤

```bash
git clone <仓库地址>
cd mc_commander

# 服务端
cd mc_commander_server
cp .env.example .env       # 按需修改（本地默认即可跑测试）
npm ci
npm test

# 前端
cd ../mc_manager_web
npm ci
npm run build              # 或 npm run dev 起开发服务器
npm run test
```

两个子项目相互独立，各自安装依赖（无 workspace）。

## 开发工作流

### 分支与提交

- 从 `main` 拉功能分支：`feat/<主题>` / `fix/<主题>` / `docs/<主题>`
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，
  描述用中文：
  - `feat(web): 玩家详情新增成就标签页`
  - `fix(server): 实例未运行时白名单操作返回 400 而非 500`
  - scope 可选：`web` / `server` / `ci` / `docs` 等
- PR 目标分支为 `main`；较大变更建议先开 Issue 或 Discussion 对齐

### 验证分级（按改动范围选择，避免无谓全量）

| 级别 | 场景 | 内容 |
|---|---|---|
| L1 | 单文件/小改动 | `npx tsc -b` + 相关测试文件 |
| L2 | 组件/交互改动 | L1 + 前端 `npm run test` 全量 |
| L3 | 里程碑/收尾 | L2 + 按需 e2e + 服务端 `npm test` + `npm run build` |

一键本地检查（lint + test 全量）：

```bash
bash scripts/local-check.sh            # Git Bash / Linux / macOS
# 或 --skip-frontend 仅跑服务端
```

CI 会在 PR 上运行与服务端/前端两套完整检查 + e2e + 密钥扫描，本地建议至少跑过 L1。

### 测试约定

- 新增/变更逻辑必须有测试覆盖（服务端 vitest + supertest；前端 vitest +
  @testing-library，e2e 用 Playwright）
- **测试数据一律虚构**：禁止出现真实服务器 IP、API Key、真实玩家数据
  （用 `1.2.3.4`、TEST-NET 网段、Steve/Alex 示例名）
- e2e 配置会自动启动 mock 后端（5198）与 dev server（5199），无需手工准备

### 前端设计约束

- 颜色/间距/圆角使用 `src/styles/` 的 `--mcs-*` 设计 token，**禁止硬编码色值**
- 组件风格遵循既有 shadcn-ui + `components/mcs/` 模式
- 数据密集区域用实底背景；玻璃拟态仅用于侧栏/顶栏/命令面板/弹窗/toast

## 行为准则

参与本项目即同意遵守 [行为准则](CODE_OF_CONDUCT.md)。保持友善、对事不对人。

## 安全问题

安全漏洞不要开公开 Issue，请走[私密安全报告](SECURITY.md)，并先阅读
SECURITY.md 中的信任模型（部分「越权」类发现属于单管理员架构的设计使然）。
