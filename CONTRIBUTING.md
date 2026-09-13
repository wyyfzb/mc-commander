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
cd mc-commander

# 共享契约包（服务端运行时消费其构建产物 dist，须先装）
cd mc-schemas
npm ci
npm test

# 服务端
cd ../mc_commander_server
cp .env.example .env       # 按需修改（本地默认即可跑测试）
npm ci
npm test

# 前端
cd ../mc_manager_web
npm ci
npm run build              # 或 npm run dev 起开发服务器
npm run test
```

三个包相互独立，各自安装依赖（无 workspace 根）。

`mc-schemas` 是 web 与服务端共用的 zod 契约包：改动其 `src/` 后必须 `npm run build`
重建 `dist/` 并连同源码一并提交——服务端运行时经 `file:` 链接消费 `dist`，前端则经
vite alias 直读 `src`，不重建会让服务端静默使用旧契约（本地一键检查与 CI 均有
dist 同步守卫拦截）。

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
| L1 | 单文件/小改动 | `npx tsc -b --noEmit` + 相关测试文件 |
| L2 | 组件/交互改动 | L1 + 前端 `npm run test` 全量 |
| L3 | 里程碑/收尾 | L2 + 按需 e2e + 服务端 `npm test` + `npm run build` |

一键本地检查（契约包 + 服务端 + 前端，lint + 类型检查 + test 全量）：

```bash
bash scripts/local-check.sh                     # Git Bash / Linux / macOS
bash scripts/local-check.sh --skip-frontend     # 仅契约包 + 服务端
bash scripts/local-check.sh --skip-schemas      # 跳过契约包
```

CI 会在 PR 上运行三套完整检查 + e2e + 密钥扫描，本地建议至少跑过 L1。

### 测试约定

- 新增/变更逻辑必须有测试覆盖（服务端 vitest + supertest；前端 vitest +
  @testing-library，e2e 用 Playwright）
- **测试数据一律虚构**：禁止出现真实服务器 IP、API Key、真实玩家数据
  （用 `1.2.3.4`、TEST-NET 网段、Steve/Alex 示例名）
- e2e 配置会自动启动 mock 后端（5198）与 dev server（5199），无需手工准备

### 前端设计约束

- 颜色/圆角/字号/动效/光影使用 `src/styles/` 的 `--mcs-*` 设计 token，**禁止硬编码色值**；
  间距不设 token，统一走 Tailwind 默认 4px 刻度（结构间距 4px 倍数）；
  文字两级（`text-mcs-text-default` / `text-mcs-text-muted`）、悬浮一档（`bg-mcs-state-hover`）、
  圆角一套档位（6/8/12/16px）
- 内容面 tint（`--mcs-{status,accent,dimension}-bg-subtle`，承载文字）**必须不透明**；
  交互覆盖层（`--mcs-state-*`、`--mcs-scrim*`）保持半透明；同一元素只允许一个内容面 tint；
  危险底用 `bg-mcs-error-bg-subtle`（禁 `bg-destructive/<alpha>`）
- 交互元素禁用 `outline-none` 抵消 `focus-visible:outline-*`（会导致焦点环不可见）；
  菜单/选项项须带 `focus:outline-2 focus:-outline-offset-2 focus:outline-mcs-focus-ring`
- Z 轴禁裸 `z-<数字>`，用 `z-(--mcs-z-*)` 阶梯
- 组件风格遵循既有 shadcn-ui + `mc_manager_web/src/components/mcs/` 模式
- 数据密集区域用实底背景；玻璃同屏 ≤2 层（顶栏 `glass-chrome` + 确认弹窗 `glass-overlay`，
  alpha ≤0.7；亮色 overlay ≤0.85），侧栏/抽屉/toast 用实底；门禁按「全站各 1 处」静态校验

## 行为准则

参与本项目即同意遵守 [行为准则](CODE_OF_CONDUCT.md)。保持友善、对事不对人。

## 安全问题

安全漏洞不要开公开 Issue，请走[私密安全报告](SECURITY.md)，并先阅读
SECURITY.md 中的信任模型（部分「越权」类发现属于单管理员架构的设计使然）。
