# AGENTS.md — MC_Commander Agent 上手指南

MC_Commander 是一个自托管的 Minecraft 服务器管理面板：不装插件、不进游戏，
在浏览器里图形化完成玩家管理与服务器运维（Web 前端 + Node.js 服务端）。

## 项目构成

| 目录 | 说明 |
|---|---|
| `mc_manager_web/` | Web 前端（React 19 / TypeScript strict / Tailwind v4 / shadcn-ui / TanStack Query / zustand） |
| `mc_commander_server/` | 服务端（Express / WebSocket / better-sqlite3 / RCON 双通道 / cron 调度） |
| `scripts/` | 通用脚本（`local-check.sh` 一键本地检查） |
| `docs/` | 架构说明、路线图、架构决策记录（ADR） |

两个子项目各自独立安装依赖（无 workspace），分别 `npm ci`。

## 常用命令

```bash
# 一键检查（服务端 lint+test + 前端 lint+tsc+test）
bash scripts/local-check.sh

# 前端（mc_manager_web/ 下）
npm ci                       # 安装依赖
npm run dev                  # Vite 开发服务器
npx vitest run <文件>        # 只跑相关测试文件
npm run test                 # vitest 全量
npx tsc -b                   # 类型检查（strict）
npm run build                # 生产构建（tsc -b + vite build）
npm run test:e2e             # Playwright e2e（自动起 mock 后端 + dev server）

# 服务端（mc_commander_server/ 下）
npm ci && npm test           # vitest 全量
npm run lint                 # ESLint
npm run dev                  # node --watch 热重载
```

## 验证分级（重要：按改动范围选择，禁止小改动跑全量）

| 级别 | 场景 | 内容 | 耗时 |
|---|---|---|---|
| L1 | 单文件/小改动 | `npx tsc -b` + 相关测试文件（同目录 `__tests__/` 或直接依赖方） | ~15s |
| L2 | 组件/交互改动 | L1 + 前端 `npm run test` 全量 | ~2min |
| L3 | 里程碑/收尾 | L2 + 按需 e2e + 服务端 `npm test` + `npm run build` | ~5min |

- e2e 只跑受影响 spec；全量 e2e 仅 L3。
- 已知慢测试：`give-item-dialog.test.tsx`（重组件集成，~30s+），小改动不要因它触发全量。

## 工程纪律

- **设计 token**：前端颜色/间距/圆角一律使用 `src/styles/` 的 `--mcs-*` CSS token，
  禁止组件内硬编码色值，禁止引入未 token 化的第三方 UI 库。
- **测试数据**：测试与文档中严禁出现真实服务器信息（IP / API Key / 真实玩家数据），
  一律使用虚构数据（`1.2.3.4`、TEST-NET 网段、Steve/Alex 等官方示例名）。
- **MC 版本兼容**：排查问题优先考虑 MC 26.x 新版与旧版在目录结构、数据格式、
  命令行为上的差异；改动不得破坏对新旧版本的兼容。
- **注释边界**：注释只写「代码无法直观体现的设计意图、隐含约束、特殊边界、选型原因」；
  禁止写入迭代过程、方案对比、调试记录；单行优先，不复述代码行为。
- **最小改动**：遵循既有代码模式与风格，不夹带与目标无关的重构；
  修复缺陷时先验证问题存在性，局部缺陷打最小补丁，设计问题重构根因。

## e2e 说明

Playwright 配置（`mc_manager_web/playwright.config.ts`）会自动启动两个本地服务：
mock 后端（端口 5198）+ Vite dev（端口 5199），无需手工准备；浏览器通道自动降级
（Chrome → Edge → 内置 chromium）。断言优先用可访问性角色/名称，不用脆弱的 CSS 选择器。

## 提交规范

Conventional Commits（`feat`/`fix`/`refactor`/`docs`/`chore`/`test` + scope），
描述用中文，例：`feat(web): 玩家详情新增成就标签页`。详见 CONTRIBUTING.md。
