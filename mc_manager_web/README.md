# MC Commander Web 端（mc_manager_web）

MC_Commander 的 Web 管理面板。设计规范与审查准则见 [docs/design-review-guidelines.md](docs/design-review-guidelines.md)。

## 技术栈

React 19 + TypeScript（strict）+ Vite 8 + Tailwind CSS v4 + shadcn/ui（radix-nova）
+ react-router v8（data mode）+ TanStack Query v5 + zustand v5
+ Vitest/RTL/MSW + Playwright（系统 Chrome）

## 常用命令

```bash
npm run dev            # 开发（默认 5173，proxy /api 与 /ws 到 localhost:25566）
npm run build          # tsc -b strict + vite 构建
npm run lint           # oxlint
npm run test           # Vitest 单测/组件测试（jsdom）
npm run test:e2e       # Playwright E2E（使用系统 Chrome，免下载 Chromium）
npm run capture        # 截图（mock 数据 + dev server，输出到 gitignore 的 .ai/vision/）
npm run check:contrast # token 对比度批量校验（258 组合，exit 非 0 阻止合并）
npm run check:design-tokens # 设计 token 门禁（硬编码色值 / z 轴 / 玻璃预算等）
npm run check:size     # 构建体积预算（gzip 口径，对入口 + 路由 chunk 闭包求和）
npm run check:tokens   # OKLCH 色值生成器（设计文档 §4.1 的色值来源）
```

## 目录结构

```
src/
├── api/            # 数据层：client（信封解析）/ types（服务端契约）/ errors（错误码映射）/ ws / queries
├── components/     # ui/（shadcn 基座）+ mcs/（MCS 设计语言组件）
├── features/       # 领域目录：dashboard/ players/ world/ files/ tasks/ instances/ plugins/ webhooks/
│                   #           audit/ settings/ onboarding/ auth/
├── layouts/        # AppShell（顶栏/侧栏/Ctrl/⌘+K 命令面板）
├── stores/         # zustand：auth（会话令牌）/ connection（面板地址 + API Key）/ ui（主题/侧栏/面板）
│                   #          + server / deploy / notifications / terminal / upgrade / command-bus
├── styles/         # token 三层：tokens/reference.css → semantic.css（--mcs-*）→ theme.css（shadcn 映射）+ glass/density/fonts
├── test/           # Vitest setup + MSW handlers
├── routes.tsx      # react-router v8 data mode 路由表
└── main.tsx        # 入口（QueryClient + Tooltip + Router + Toaster）
e2e/                # Playwright E2E（冒烟；视觉截图走 `npm run capture`，输出到 gitignore 的 .ai/vision/）
scripts/            # gen-token-colors（色值生成）/ check-contrast（对比度校验）/ check-design-tokens（token 门禁）
                    # / check-bundle-size（体积预算）/ capture（截图）
```

## 设计纪律

工程纪律的单一事实源是仓库根 `AGENTS.md` 的「工程纪律」节（token 角色矩阵、tint 两类、间距刻度、
z 轴阶梯、玻璃预算、焦点可见、测试数据禁真实信息）。本节只记 Web 端特有的落地口径，避免双轨漂移。

- 组件禁止硬编码色值/圆角/间距，一律消费 `--mcs-*` 语义 token（`text-mcs-*`/`bg-mcs-*` 工具类）；
  `npm run check:design-tokens` 拦截硬编码色值、裸 `z-<数字>` 与玻璃超预算
- token 三层单向依赖：reference（原始值，组件禁用）← semantic（`--mcs-*`，组件唯一合法来源）← theme（shadcn 映射）
- 深色优先：`index.html` 默认 `.dark`，`.light` 为亮色覆盖（见 `useTheme`）
- 玻璃同屏 ≤2 层：常驻仅顶栏、覆盖层仅确认弹窗；侧栏/通知抽屉/toast 一律实底
- 新页面/大改须过对比度脚本（`npm run check:contrast`）与独立审查；页面级变更不得自审自过

## 连接配置

- 默认同源：dev 经 Vite proxy 转发 `/api`、`/ws`（目标 `VITE_PROXY_TARGET`，默认 `http://localhost:25566`）；生产由 Express 同源托管（`PUBLIC_DIR`）
- 凭据双通道（**管理员会话为面板主线**）：登录后的会话令牌存 localStorage（`useAuthStore`，键 `mcs-session`，刷新/新标签页保持登录），面板地址与 API Key 存 `useConnectionStore`（键 `mcs-connection`，脚本/集成通道）
- WS 鉴权：subprotocol `mc-commander-session.<token>`（面板主线）或 `mc-commander-apikey.<key>`

## 里程碑状态

M1-M7 已全部完成，当前版本 **v0.2.1**（AGPL-3.0）。里程碑与架构决策的过程记录维护在
Basic Memory 图谱（personal 项目 `mc-commander/`），仓库内只保留使用与架构文档。
