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

## 验证策略（一律全量）

改动不分大小，本地自测一律全量，禁止只跑相关测试就提交：

| 改动范围 | 验证内容 |
|---|---|
| 前端 | `npx tsc -b` + `npm run lint` + `npm run test`（全量） |
| 服务端 | `npm run lint` + `npm test`（全量） |
| 跨端 | 两者都跑；一键路径 `bash scripts/local-check.sh` |

- 涉及页面渲染 / 展示文案的改动，加跑相关 e2e spec（`npx playwright test <spec>`）。
- 全量 e2e 由 CI 兜底，本地按需。
- PR 自测清单必须附全量结果（通过数 / 总数），仅写「相关测试通过」视为自测未完成。

## 工程纪律

- **设计 token**：前端颜色/圆角/字号/动效/光影一律使用 `src/styles/` 的 `--mcs-*` CSS token
  （经 `src/index.css` 的 `@theme` 注册为工具类），禁止组件内硬编码色值，禁止引入未 token 化的第三方 UI 库。
  文字只有两级（`--mcs-text-default` / `--mcs-text-muted`；终端专用 `--mcs-terminal-*` 是独立深底调色板，
  不占文字档位）、交互悬浮只有一档（`--mcs-state-hover`，
  `--mcs-bg-secondary` 是静态次级面不是 hover 态）；圆角只有一套档位（6/8/12/16px，
  shadcn 的 `--radius-*` 直接绑定 `--mcs-radius-*`）。
- **tint 两类**：承载文字/图标的内容面（`--mcs-{status,accent,dimension}-bg-subtle`）**必须不透明**
  （`color-mix(色 N%, 基面)`）——半透明 tint 的有效色随宿主面漂移，最亮浮层上文字会跌破 4.5:1；
  不承载文字的交互覆盖层（`--mcs-state-hover/focus/pressed`、`--mcs-scrim*`）保持半透明。
  同一元素只允许一个内容面 tint（内容面 tint 不得互相叠加，也不得与玻璃面同元素）；
  危险语义色底（`--mcs-error-bg-subtle`）同样不透明，禁 `bg-destructive/<alpha>`。
- **间距**：不设 `--mcs-space-*`，统一走 Tailwind 默认 4px 刻度（`--spacing` 0.25rem）；
  结构间距必须 4px 倍数，组件内微节奏（2px 档）须在 PR 说明理由。
  容器档位固定：大面板 `p-6` / 标准卡 `p-4` / 紧凑卡 `p-3` / 横向卡 `px-4 py-3` /
  密集条 `px-3 py-2` / 内嵌块 `p-2`；语义告警条一律用 `components/mcs/notice-banner.tsx`
  （`px-2.5 py-1.5`），多行告警卡用 `p-3`。
- **Z 轴**：禁裸 `z-<数字>`，一律 `z-(--mcs-z-*)`（阶梯见 `semantic.css`：
  local 10 / overlay 40 / modal 50 / dropdown 60 / tooltip 70 / toast 80；
  下拉必须高于弹窗——Radix 弹层挂在 body 末尾，弹窗内的 Select 要盖过遮罩才可点）。
- **玻璃预算**：同屏 ≤2 层——常驻 1 处（顶栏 `glass-chrome`）+ 覆盖层 1 处（确认弹窗 `glass-overlay`）；
  门禁按「全站各 1 处」的静态口径校验（同屏无法静态判定），见 `check-design-tokens.mjs` 第 17 条；
  侧栏/通知抽屉/toast 一律实底（玻璃内含滚动容器时 backdrop 每次重绘都要重算模糊）。
- **焦点可见**：交互元素禁止用 `outline-none` 抵消 `focus-visible:outline-*`
  （Tailwind utilities 同层，`outline-none` 会把 `outline-style` 钉死为 `none`，焦点环实测不可见）；
  菜单/选项项用 `focus:outline-2 focus:-outline-offset-2 focus:outline-mcs-focus-ring` 承担高亮
  （仅靠 `focus:bg-accent` 在弹窗面上只有 1.1:1）。注意：Radix 指针移动也会移动 DOM 焦点，
  实测 Chromium 下 `focus-visible:` 对指针 hover 同样匹配 → 该环在指针悬停时也会出现，
  这是为可访问性接受的取舍，不要为此改回 `outline-hidden`。
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
mock 后端（端口 5198）+ 前端服务器（端口 5199，默认 dev；CI 与 `E2E_SERVER=preview`
时用 vite preview 服务构建产物，需先 `npm run build`），无需手工准备；浏览器通道
自动降级（Chrome → Edge → 内置 chromium）。断言优先用可访问性角色/名称，
不用脆弱的 CSS 选择器。

## 提交规范

Conventional Commits（`feat`/`fix`/`refactor`/`docs`/`chore`/`test` + scope），
描述用中文，例：`feat(web): 玩家详情新增成就标签页`。详见 CONTRIBUTING.md。

- **AI 协作署名（Co-authored-by）**：Agent 发起或协助生成的提交，在 commit footer 附带共同作者声明：
  ```text
  Co-authored-by: ZCode Agent <noreply@zcode.ai>
  ```
- **PR 与分支**：所有非 dependabot 改动均走特性分支 + PR，主干 squash 合并；合并后自动删除特性分支。

