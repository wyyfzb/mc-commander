# MC Commander Web 端（mc_manager_web）

MC_Commander 的 Web 管理面板。设计规范与审查准则见 [docs/design-review-guidelines.md](docs/design-review-guidelines.md)。

## 技术栈

React 19 + TypeScript（strict）+ Vite 8 + Tailwind CSS v4 + shadcn/ui（radix-nova）
+ react-router v8（data mode）+ TanStack Query v5 + zustand v5
+ Vitest/RTL/MSW + Playwright（系统 Chrome）

## 常用命令

```bash
npm run dev            # 开发（默认 5173，proxy /api 与 /ws 到 localhost:25566）
npm run build          # tsc strict + vite 构建
npm run test           # Vitest 单测/组件测试（jsdom）
npm run test:e2e       # Playwright E2E（使用系统 Chrome，免下载 Chromium）
npm run check:contrast # token 对比度批量校验（116 组合，exit 非 0 阻止合并）
npm run check:tokens   # OKLCH 色值生成器（设计文档 §4.1 的色值来源）
```

## 目录结构

```
src/
├── api/            # 数据层：client（信封解析）/ types（服务端契约）/ errors（错误码映射）/ ws / queries
├── components/     # ui/（shadcn 基座）+ mcs/（MCS 设计语言组件）
├── features/       # 领域目录：dashboard/ players/ world/ files/ tasks/ instances/ settings/
├── layouts/        # AppShell（顶栏/侧栏/Cmd+K 命令面板）
├── stores/         # zustand：ui（主题/侧栏/面板）+ connection（面板连接配置）
├── styles/         # token 三层：tokens/reference.css → semantic.css（--mcs-*）→ theme.css（shadcn 映射）+ glass/density/fonts
├── test/           # Vitest setup + MSW handlers
├── routes.tsx      # react-router v8 data mode 路由表
└── main.tsx        # 入口（QueryClient + Tooltip + Router + Toaster）
e2e/                # Playwright E2E（冒烟；视觉截图走 `npm run capture`，输出到 gitignore 的 .ai/vision/）
scripts/            # gen-token-colors（色值生成）/ check-contrast（对比度校验）/ check-design-tokens（token 门禁）/ capture（截图）
```

## 设计纪律（CLAUDE.md 规则 1/13/14 强制）

- 组件禁止硬编码色值/圆角/间距，一律消费 `--mcs-*` 语义 token（`text-mcs-*`/`bg-mcs-*` 工具类）
- token 三层单向依赖：reference（原始值，组件禁用）← semantic（--mcs-*，组件唯一合法来源）← theme（shadcn 映射）
- 玻璃仅侧栏/顶栏/命令面板/弹窗（blur ≤20px、alpha ≤0.3），表格/终端/表单/图表实底
- 深色优先：html 默认 `.dark`，`.light` 为亮色覆盖
- 新页面/大改必须过四重审查（功能等价清单/对比度脚本/截图+vision-bridge/独立子代理 8 维度审查）

## 连接配置

- 默认同源：dev 经 Vite proxy 转发 `/api`、`/ws`（目标 `VITE_PROXY_TARGET`，默认 `http://localhost:25566`）；生产由 Express 同源托管（M7）
- 面板地址/API Key 存 localStorage（`useConnectionStore`），配置 UI 在 M6 onboarding
- WS 鉴权：subprotocol `mc-commander-apikey.<key>`（服务端 websocket.js 契约）

## 里程碑状态

- **M1 地基 ✅（2026-08-14）**：Vite/React/TS 骨架、token 体系（OKLCH 三层 + 116 组合对比度全达标）、AppShell（顶栏/侧栏/Cmd+K）、API 数据层（HTTP+WS 连通验证）、测试基座（23 Vitest + 5 Playwright 全绿）
- M2 仪表盘：统计卡 + xterm 终端 + 启停管理 + 通知抽屉
- M3 玩家（最重）：表格/详情/给予/传送/封禁 + NBT 命令迁移
- M4 世界/文件：66 属性表单 + 三栏文件管理器 + Monaco
- M5 任务/实例：cron 编辑器 + 部署 Stepper
- M6 设置/onboarding/PWA/响应式
- M7 服务端配套：Express 静态托管 + SPA fallback
