# AGENTS.md — MC\_Commander Agent 上手指南

MC\_Commander 是一个自托管的 Minecraft 服务器管理面板：不装插件、不进游戏，
在浏览器里图形化完成玩家管理与服务器运维（Web 前端 + Node.js 服务端）。

## 项目构成

| 目录                     | 说明                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `mc_manager_web/`      | Web 前端（React 19 / TypeScript strict / Tailwind v4 / shadcn-ui / TanStack Query / zustand） |
| `mc_commander_server/` | 服务端（Express / WebSocket / better-sqlite3 / RCON 双通道 / cron 调度）                            |
| `mc-schemas/`          | 共享契约包（zod，包名 `@mc-commander/schemas`）：web 经 vite alias 直读 `src`，服务端经 `file:` 链接消费 `dist`  |
| `scripts/`             | 通用脚本（`local-check.sh` 一键本地检查）                                                             |
| `docs/`                | 使用者文档（`architecture.md` 架构说明、`user-guide.md` 用户指南）与入库的审查指南（`mc_manager_web/docs/design-review-guidelines.md`：CTA 配额、圆角守门、字号档位适用面、反馈级别等**无门禁、靠审查口径统一**的规则）；开发意图类（ADR/审查报告/任务清单）不入库，走本机 `.ai/`     |

三个包各自独立安装依赖（无 workspace 根），分别 `npm ci`。**改动** **`mc-schemas/src`** **后必须
`npm run build`** **重建** **`dist/`** **并一并提交**——服务端运行时消费的是 `dist`，前端读的是 `src`，
不重建会让服务端静默使用旧契约（`local-check.sh` 与 CI 均有 dist 同步守卫拦截）。

## 常用命令

```bash
# 一键检查（代码格式 + 契约包 + 服务端 + 前端：lint / 类型检查 / 全量 test）
# 依赖 bash：若 `bash` 不在 PATH（Windows 上 Git 自带的 bash 默认不进 PATH），
# 把 Git 安装目录下的 `bin` 或 `usr/bin` 加入 PATH 后即可直接跑；
# 无 bash 环境按下方「验证策略」的三包命令序列逐包降级执行
bash scripts/local-check.sh

# 仓库根（工具包，只装 Biome；不是 workspace 根，三包依赖仍各自安装）
npm ci                       # 安装格式化器（首次）
npm run format               # 按 biome.jsonc 格式化全仓代码
npm run format:check         # 只检查不改写（CI 与 local-check 用这条）

# 契约包（mc-schemas/ 下）——改 src 后必须 build 并提交 dist
npm ci && npm run lint && npm test
npm run build

# 前端（mc_manager_web/ 下）
npm ci                       # 安装依赖
npm run dev                  # Vite 开发服务器
npx vitest run <文件>        # 只跑相关测试文件
npm run test                 # vitest 全量
npx tsc -b --noEmit          # 类型检查（strict）
npm run build                # 生产构建（tsc -b + vite build）
npm run test:e2e             # Playwright e2e（自动起 mock 后端 + dev server）

# 服务端（mc_commander_server/ 下）
npm ci && npm test           # vitest 全量
npm run lint                 # oxlint
npm run dev                  # node --watch 热重载
```

## 验证策略（静态检查与单测一律全量）

改动不分大小，本地自测一律全量，禁止只跑相关测试就提交：

| 改动范围         | 验证内容                                                         |
| ------------ | ------------------------------------------------------------ |
| 前端           | `npx tsc -b --noEmit` + `npm run lint` + `npm run test`（全量）  |
| 服务端          | `npm run lint` + `npm test`（全量）                              |
| 契约包          | `npm run lint` + `npm test` + `npm run build`（dist 与 src 同步） |
| 任何代码改动（含单文件） | 根目录 `npm run format`（写入后）——格式检查在 CI 与一键路径内                   |
| 跨端           | 以上都跑；一键路径 `bash scripts/local-check.sh`                      |

- 一键路径：`bash scripts/local-check.sh`（代码格式 + 三包 lint（oxlint）/ 类型检查 / 全量 test + 契约 dist 同步守卫）；
  `bash` 不在 PATH 时先按「常用命令」把它加进 PATH，未装 bash 的环境则按上表逐包执行（格式检查用
  根目录 `npm run format:check`，其余命令见「常用命令」）。
  本机另有等价的私有入口 `.ai/tools/verify.ps1`（四条泳道并行＝格式 + 三包 + 三项门禁，出证据块与
  `summary.json`；不入库）。
- 涉及页面渲染 / 展示文案的改动，加跑相关 e2e spec（`npx playwright test <spec>`）。
- 全量 e2e 由 CI 兜底，本地按需。
- 自测证据必须附全量结果（通过数 / 总数），仅写「相关测试通过」视为自测未完成；
  本地单线开发下证据落在提交信息或任务回复里（PR 流已退役，见「提交规范」）。

## 工程纪律

> 本节前端路径均相对 `mc_manager_web/`（如 `src/styles/`、`components/mcs/`、`scripts/check-design-tokens.mjs`）。

- **设计 token**：前端颜色/圆角/字号/动效/光影一律使用 `src/styles/` 的 `--mcs-*` CSS token
  （经 `src/index.css` 的 `@theme` 注册为工具类），禁止组件内硬编码色值，禁止引入未 token 化的第三方 UI 库。
  文字只有两级（`--mcs-text-default` / `--mcs-text-muted`；终端专用 `--mcs-terminal-*` 是独立深底调色板，
  不占文字档位）、交互悬浮只有覆盖层（中性 `--mcs-state-hover` 一档，外加危险族升温用的
  `--mcs-state-hover-error`；`--mcs-bg-secondary` 是静态次级面不是 hover 态，内容面 tint
  （`--mcs-*-bg-subtle`）不得出现在 `hover:` 上，口径见 `mc_manager_web/docs/design-review-guidelines.md`
  「交互悬浮只走覆盖层」）；圆角档位是 6/8/12/16px（另有 20px
  `@reserved` 档，当前 0 消费），shadcn 的 `--radius-*` **逐档错位**绑定（`--radius-sm` ←
  `--mcs-radius-xs` 6px、`--radius-md` ← 8px、`--radius-lg` ← 12px、`--radius-xl` ← 16px），
  所以 `rounded-md` 不是卡片档（8px），卡片是 `rounded-mcs-md`／`rounded-lg`（12px）。
  字号只有 6 个**文字档**（22/18/14/14/12/10，逐档配对行高：xl 1.3 / lg 1.4 / md 1.5 /
  sm 1.6 / xs 1.5 / 2xs 1.5），两个 14px 档语义不同——`sm` 是正文基准、`md` 是强调正文
  （同尺寸靠字重与收紧行高区分），标题层次口径：页面 `xl` / 区块与卡片标题 `lg` / 正文 `sm`，
  `md` 不用于标题；`display`（30px）是**非文字数字档**，只随 `.mcs-num`
  用于 KPI 等数字面板，不占文字档位。
  **2xs（10px）的适用面**：只用于可扫读的角标、单位、短标签与 mono 元数据（徽章计数、
  列头词、`{n} 种可用` 这类数量单位、IP/耗时）；**完整句子最低 xs（12px）**——
  提示语、错误说明、帮助文本一律不用 2xs（CJK 笔画在 10px 下屏显发糊，且 12px 才是
  中文正文的常规下限）。判据是「短语 vs 句子」，不是「有没有中文」：列头「严重度」
  这类词正确；「事件类型加载失败，无法勾选事件」这类句子越界。灰区的兜底口径：
  **含 `，／；／。` 分句标点、或中文 ≥15 字者按句子处理**（`连接正常 · 延迟 12ms`
  这类以单位收尾的省略式状态行仍算元数据）；只判可见文本，`title=`／`aria-label`
  里的句子不计。此条无门禁（长度/标点只是代理量，精度不足以做拦截），由独立审查把关。
  两个输入控件基座（`ui/input.tsx`、`ui/textarea.tsx`）各保留
  1 处原生 `text-base`（16px）——输入控件字号小于该值时 iOS 聚焦会自动放大整页；该额度受门禁
  第 27 条约束（`check-design-tokens.mjs` 的 `TEXT_BASE_ALLOWLIST`，超出额度即报错），不得扩散。
- **tint 两类**：承载文字/图标的内容面（`--mcs-{status,accent,dimension}-bg-subtle`）**必须不透明**
  （`color-mix(色 N%, 基面)`）——半透明 tint 的有效色随宿主面漂移，最亮浮层上文字会跌破 4.5:1；
  不承载文字的交互覆盖层（`--mcs-state-hover/focus/pressed`、`--mcs-scrim*`）保持半透明。
  同一元素只允许一个内容面 tint（内容面 tint 不得互相叠加，也不得与玻璃面同元素）；
  危险语义色底（`--mcs-error-bg-subtle`）同样不透明，禁 `bg-destructive/<alpha>`——
  危险按钮配方的唯一声明源是 `ui/button` 的 destructive 变体，不得手写
  （门禁第 28 条静态拦截「弱档 error 描边与按钮语义同行」，扫描面＝`src/`，排除 `ui/`、`tone.ts` 与 `__tests__`）。
- **标签与状态展示**：只读状态用 `components/mcs/status-pill.tsx`（`StatusPill`），
  可交互/通用标签用 `components/mcs/chip.tsx`（`Chip`），计数用 `components/mcs/count-badge.tsx`
  （`CountBadge`，定位＝数量/条数；不是状态，也不是版本号、百分比与带单位规格值）——只允许这三件，
  不存在第四套标签组件，也不要再造（门禁第 22 条拦新导出的 `*Badge/*Pill/*Tag` 组件、
  已删除的 shadcn `ui/badge` 的引用与重建；正则判**单数结尾**，`PlayerBadges` 这类
  复数领域部件在判定面外）。
  语义色唯一声明源是 `components/mcs/tone.ts`（六档 accent/success/warning/error/info/purple，
  各含 border + bg-subtle + fg；另有 accent 的选中/激活形态 `TONE_SELECTED_CLASSES`
  三件套与 `TONE_SELECTED_SURFACE_CLASSES` 两件套容器——强档描边 `-border-strong`
  承担「已选中」的可辨识信息，弱档仅装饰）；图标底块、徽章、通知气泡这类不套组件的着色点
  必须走它，禁止在 feature 里再手写 tone → 类名映射（门禁第 11c 条静态拦截）。
- **卡片容器**：卡片容器基座是 `components/mcs/card.tsx`（`Card`/`CardHeader`/`CardTitle`/`CardBody`）
  ——卡片面（圆角 + 描边 + 卡片底色 + 卡阴影）在基座声明，padding 与内部布局（flex/间距）仍由调用点
  按容器档位用 `className` 给；默认元素 `section`，元素语义不同时用 `as` 声明。
  卡片面配方不得在别处另写一份（门禁第 21 条以 `shadow-mcs-card` 为标记拦截）；现网有 7 处
  共用该标记的非卡片面现场（空态插画底座、侧栏摘要条、终端深底面、卡内数值栅格、设置页
  子导航轨道、表单内嵌块 ×2）已在门禁里登记豁免额度——那是在豁免具体现场（额度外的第 N 处
  照样报错），不是允许新写卡片面。
- **间距**：不设 `--mcs-space-*`，统一走 Tailwind 默认 4px 刻度（`--spacing` 0.25rem）；
  结构间距走 4px 刻度，半档（`.5` 后缀，如 `gap-1.5`/`px-2.5`/`mt-0.5`）是全站常态、
  基座自己就在用（`ui/button` 的 `px-2.5`、`ui/input` 的 `py-1.5`），允许直接写；
  要避免的是**非刻度任意值**（`size-5.5`、`max-w-35` 这类），它绕过刻度体系、无人能推其来处。
  卡片内距三档（大面板 / 标准卡 / 紧凑卡），**唯一声明处是 `components/mcs/card.tsx` 的
  `CARD_SIZE_CLASSES`，本文件不列具体值**（列了就必然与它漂移）。`Card` 的 `size` 是 opt-in：
  默认不给内距，给成默认值会把全站既有卡一起推离现状；`className` 里的 `p-*` 仍覆盖它。
  **卡内半档的切档维度已定**（owner 2026-09-26 拍板）：不按"密度"切，按两个可推导的维度分别切，
  且**不新增命名档位、不设 density token**——纵向 `py` 由**行内最高交互控件**反推
  （含标准档控件 `h-10` → `py-2.5`；含紧凑档 `h-7`/`h-6` → `py-2`；无控件 → `py-2`），
  横向 `px` 由**容器在嵌套树里的位置**定（卡内 4 / 嵌块 3 / 文本块 2.5~2）。
  选它的理由是与既有「控件高度档位」同构（不多引入第二个变量），且每一维都有能当场回答的问句。
  表格单元格的 `px-3 py-2` 属行列距、`ui/textarea` 的 `px-2.5 py-2` 属控件内距，都不参与容器切档；
  具体盘点数字与复核口径见 `mc_manager_web/docs/design-review-guidelines.md`「容器内距」
  （**引数字前先重采**：旧版的 `px-4 py-2 = 13` 是子串匹配产物，真实代码点为 5）。
  语义提示一律用 `components/mcs/notice-banner.tsx`——**唯一容器**，调用点不再手写
  `border + tint + p-*` 组合。`form` 两档按**内容是不是块级**选（不按长度：长度给不出稳定
  边界，同一条文案换个容器宽度就从一行变三行）：行内流（单句/短语，可折行）用默认 `bar`
  （`px-2.5 py-1.5` + `text-mcs-xs`），children 含块级元素（多段落 / `dl` / 标题+正文）用
  `form="card"`（`p-3` + `text-mcs-sm` + 图标贴首行）。`variant` 除四档语义色外另有
  `neutral`（三件套全取中性面），**在途状态**（正在部署/正在启动）用它——染成 info 蓝会被
  读成「有消息要看」；图标的状态性修饰（如在途的 `animate-spin`）走 `iconClassName`。
  内联 `style` 的 `width`/`height` 必须是数值或含单位字符串——传 Tailwind 类名会被浏览器
  当非法 CSS 丢弃（门禁第 26 条静态拦截）。
- **控件高度档位**：档位由**语境**决定，同一语境内部必须一致——不盲目全站统一，也不允许
  调用点各自补偿基座高度（历史问题：`ui/input` 基座 32px 时，各页用 `h-8`/`h-9` 覆盖去凑
  40px，形成满屏随手写的档位）。四档固定：
  标准档 `h-10`（40px）＝表单控件与含输入的筛选栏（输入 / 下拉 / 日期框 / 同行按钮全部同档）；
  紧凑档 `h-7`（28px）＝无输入的密集操作条（页头操作、批量条）、列表行内操作、分页、tabs
  （tabs 是**目标态**：现网 4 个调用点仍各写 h-7/h-8/h-10，基座 `group-data-horizontal/tabs:h-8`
  是上游遗留的 32px，收口属设计问题，未做）；
  行内小档 `h-6`（24px）＝行内小按钮（两族：`size="xs"` 基座 = `h-6 px-2` + `text-xs`；
  `size="sm"` + 覆盖 `h-6` = 字号仍 2xs 一族——换族会把 10px 变 12px，别混）；
  大档 `h-11`（44px）＝主 CTA（`lg` / `icon-lg`）。
  基座是 `ui/input` / `ui/input-group` / `ui/select`（默认档）/ `ui/button`（`default`/`lg`/`icon`/`icon-lg`），
  `size` 变体（`sm`/`xs`/`icon-sm`）是基座的一部分、按语境选档（`sm` 是显式 size 里的主力档，
  约 default 的两倍）——禁止的是**用 `h-*` 覆盖基座已给的档**，不是不许用紧凑档。
  注意 `ui/input` / `ui/textarea` 尚无 size 变体，紧凑语境允许调用点写 `h-7`（世界页属性/规则
  面板即此形态）；tabs 行另有上游遗留的基座 `h-8`（32px，四档之外），收口属设计问题。
  两条隐含约束：①紧凑档只缩高度、字号仍随基座；②`ui/input` 与 `ui/textarea` 基座声明
  `text-base md:text-sm`（`text-base` 受门禁第 27 条额度约束），产物里带变体的规则排在后面，
  会**盖掉调用点未加变体的字号类**——要在调用点显式改字号必须写 `md:` 同档，否则代码写 12px、
  桌面端实际渲染 14px（类型与事实不符）。
- **响应式切档**：按**容器宽**判，不按视口断点——侧栏可折叠（56px ↔ 208px）、`md`(768) 以下
  退化成抽屉（不占布局宽）、主从页还会被右层面板再借走 420px，同一个视口宽下「这一块到底
  有多宽」能差出六百多 px，视口断点在这些场景原理上判不准。按「CSS 能否独立解决」二分：
  纯展示差异（栅格列数 / 分栏 / 页头堆叠）→ 页面根加 `@container`，把 `sm:/md:/lg:/xl:` 换成
  容器档（纯 CSS，不过 JS、不重渲染）；必须换组件行为的（内联↔Sheet / 全列↔裁列 /
  双栏↔全屏）→ `src/hooks/use-container-width.ts`（ResizeObserver 测实宽）。
  **两套档位同名不同值，选错前缀就是成倍误判**：视口 `md:` 48rem/768px ← 侧栏/抽屉分界，
  容器 `@md:` 28rem/448px（容器档取 Tailwind v4 默认值 `@xs` 320 → `@5xl` 1024，本仓未覆盖；
  视口档仅追加了 `xs`）。
  阈值取**实测最小可用宽**反推，不拍脑袋凑档位；改任一侧都要连同理由一起改。
  **jsdom 不评估容器查询 ⇒ 容器阈值必须由 e2e 在对应视口宽上锁住**（jsdom 量不到真实几何）。
  `use-media-query.ts` 只留 `BREAKPOINT_BELOW_SM`（玩家表 <640 整表转卡片）——卡片态把一行
  摊成「姓名（与徽标同行）+ 摘要行」两行，比紧凑 4 列表更适合窄屏阅读，故阈值**刻意取视口**而非
  表格区实宽（抽屉侧栏下 512–639 视口的内容宽其实放得下紧凑表，仍选卡片态）：这是有理由的
  例外，不是漏改。
- **页面结构**：AppShell 主页面有且仅有一个 `components/mcs/page-header.tsx`（`PageHeader`），
  标题与描述只在页头声明；同屏标题最多 3 个不同字号档（页头 `xl`／区块与卡片标题 `lg`／
  数据卡标签 `sm`；页面自加的标题档也计入总数）。
  卡片标题配方（唯一事实源是 `components/mcs/card.tsx` 基座，调用点不再另写一份）：
  区块/卡片标题 = `lg` + `font-semibold` + `text-mcs-text-default`；数据卡标签 = `sm` + `font-medium`
  - `text-mcs-text-muted`（标签必须弱于同卡数值）。
    登录页/引导页是全屏品牌入口，不在 AppShell 内，由自身 `h1` 承担标题（门禁第 23 条静态拦截）。
- **Z 轴**：禁裸 `z-<数字>`，一律 `z-(--mcs-z-*)`（阶梯见 `semantic.css`：
  local 10 / overlay 40 / modal 50 / dropdown 60 / tooltip 70 / toast 80；
  下拉必须高于弹窗——Radix 弹层挂在 body 末尾，弹窗内的 Select 要盖过遮罩才可点）。
  全屏覆盖层（`modal` 档）只出自 `ui/sheet` / `ui/dialog`，禁在 feature/layout 里裸搭
  全屏容器或 `aside`（门禁第 24 条静态拦截；判定面＝**同一行**同时出现 modal 档与
  `fixed`/`inset-0`/`<aside` 的组合——跨行与不带 z-modal 的裸 `aside` 看不见，宁漏不误报）。
- **玻璃预算**：同屏 ≤2 层——常驻 1 处（顶栏 `glass-chrome`）+ 覆盖层 1 处（确认弹窗 `glass-overlay`）；
  门禁按「全站各 1 处」的静态口径校验（同屏无法静态判定），见 `check-design-tokens.mjs` 第 17 条；
  侧栏/通知抽屉/toast 一律实底（玻璃内含滚动容器时 backdrop 每次重绘都要重算模糊）。
- **焦点可见**：交互元素禁止用 `outline-none` 抵消 `focus-visible:outline-*`
  （Tailwind utilities 同层，`outline-none` 会把 `outline-style` 钉死为 `none`，焦点环实测不可见）；
  菜单/选项项用 `focus:outline-2 focus:-outline-offset-2 focus:outline-mcs-focus-ring` 承担高亮
  （仅靠 `focus:bg-accent` 在弹窗面上只有 1.1:1）。注意：Radix 指针移动也会移动 DOM 焦点，
  实测 Chromium 下 `focus-visible:` 对指针 hover 同样匹配 → 该环在指针悬停时也会出现，
  这是为可访问性接受的取舍，不要为此改回 `outline-hidden`。
  未显式声明焦点类的交互元素由 `index.css` 的全局 `:focus-visible` 兜底承担焦点环，
  但**裸取消 outline 且无替换指示器**会把该兜底钉死（门禁第 29 条静态拦截；
  第 8 条只拦成对抵消形态）。
  行内 `onKeyDown` 对空格/回车 `preventDefault` 前必须判落点（`e.target` / `e.currentTarget`），
  否则容器会吞掉行内控件自己的激活键（门禁第 25 条静态拦截）。
- **测试等待**：异步查询统一吃 `src/test/setup.ts` 的全局 `asyncUtilTimeout`（5s），
  不要写 per-call `timeout`；vitest 自带的 `vi.waitFor` 有独立硬编码的 1s 上限、不读该配置，
  等 toast 这类异步续延须显式传 `{ timeout }`；时机语义（防抖、轮询间隔）用 fake timers 断言，
  不要靠「等多久」来验证。
- **测试数据**：测试与文档中严禁出现真实服务器信息（IP / API Key / 真实玩家数据），
  一律使用虚构数据（`1.2.3.4`、TEST-NET 网段、Steve/Alex 等官方示例名）。
- **MC 版本兼容**：排查问题优先考虑 MC 26.x 新版与旧版在目录结构、数据格式、
  命令行为上的差异；改动不得破坏对新旧版本的兼容。
- **注释边界**：注释只写「代码无法直观体现的设计意图、隐含约束、特殊边界、选型原因」；
  禁止写入迭代过程、方案对比、调试记录；单行优先，不复述代码行为。
  **实测数据与反例是允许的**（本仓注释的主流：`实测 812 vs 782 的假红`、`内联 420px 下每格仅 ~54px`
  ——它们是「为什么是这个值」的依据）；禁止的是过程叙事（改了几版、谁提出、走了哪些弯路）。
- **代码格式**：格式化的唯一事实源是根目录 `biome.jsonc`（Biome formatter，**只做 formatter**——
  lint 归 oxlint，三个包同一把）。改完代码跑 `npm run format`（根目录）即与门禁一致；
  `npm run format:check` 在 CI 与 `local-check.sh` 里跑。范围＝全仓 .ts/.tsx/.js/.mjs + 配置文件，
  **不含 CSS 与 Markdown**（设计 token 样式表由门禁脚本解析、文档手写排版），
  也不含 dist/public/coverage/e2e 产物/.ai/锁文件。分号风格按包分流（服务端有、其余无），
  行宽 100——不要手工对抗格式化结果，也不要为「更好看」手写折行。
- **最小改动**：遵循既有代码模式与风格，不夹带与目标无关的重构；
  修复缺陷时先验证问题存在性，局部缺陷打最小补丁，设计问题重构根因。
  二分判据：**同类现场 ≥3 处、或根因在基座/门禁/文档口径上 → 按设计问题走根因**；
  单点且不复发 → 最小补丁。走根因路径时必须把同类现场一并收掉，或登记为待办。
- **文件存放纪律**：先判文件性质再定落点——源码/公开文档进包与 `docs/`（要过门禁、CI、
  独立审查，且**新文件入库须 owner 批准**）；开发意图类（清单/审查报告/决策记录）进本机私有的
  `.ai/`（规范见 `.ai/README.md`）；探针、一次性脚本、临时夹具与临时截图**唯一落点是** **`.ai/temp/`**
  （或系统临时目录），不得写进 `mc_manager_web/e2e/`、`scripts/`、`__tests__/` 等任何库内目录——
  探针混进去会被误提交、污染 grep 与 diff，**事后删除不能抵消**（它在被删前一直躺在版本控制眼皮下）。
  工具硬要求「路径必须落在仓库内」时（Playwright 的 `testDir` 即此类），先在回复里说明这是临时文件，
  用完立即删除并以 `git status --short` 自证；探针在库内产生的产物（`test-results/` 下截图等）同样清掉。
  探针要驱动浏览器/起服务时，写成 `.ai/temp/` 下的 node 脚本直接消费既有库，不要借 `e2e/` 落文件。
  **新增文件或目录前**先确认忽略规则覆盖：`git check-ignore -v --no-index <path>`——未被忽略的新目录
  在 `git status` 里是可见的裸状态，离误提交只差一次 `git add -A`（服务端 `data/`/`servers/`/`backups/`
  已锚定安装目录，从任意 cwd 启动都不再漏到根级；根级忽略规则作为防回归兜底保留）。
  提交前用 `git status --short --untracked-files=all` 自证只出现本次预期的改动。

## e2e 说明

Playwright 配置（`mc_manager_web/playwright.config.ts`）会自动启动两个本地服务：
mock 后端（端口 5198）+ 前端服务器（端口 5199，默认 dev；CI 与 `E2E_SERVER=preview`
时用 vite preview 服务构建产物，需先 `npm run build`），无需手工准备；浏览器通道
自动降级（Chrome → Edge → 内置 chromium）。断言优先用可访问性角色/名称，
不用脆弱的 CSS 选择器。

mock 是**进程级共享**的（并行 spec 连同一个「服务端」）：一个 spec 触发的构造端点
广播（deploy/upgrade 的进度与终态）只投递给**同分组**连接，分组头 `x-mock-ws-group`。
触发广播的 spec 必须声明自己的分组（`page.setExtraHTTPHeaders`；`page.request.*`
不继承该头，需在调用处显式传）；断言「通知空态 / 进度」这类全局状态的 spec 也应声明
分组，否则并行 spec 的广播会打进来。

## 提交规范

Conventional Commits（`feat`/`fix`/`refactor`/`docs`/`chore`/`test` + scope），
描述用中文，例：`feat(web): 玩家详情新增成就标签页`。详见 CONTRIBUTING.md。
- **分支与合并**：2026-09-13 起为本地单线开发（远端冻结、多 agent 协作与 PR 流退役），改动经全量自测 + 独立审查后直接提交，不再走特性分支 + PR。提交分支以 owner 当次指令为准（2026-09-13 任务循环授权提交 localdev 分支；push 与合并 main 须 owner 另行授权，操作编排见本地 `.ai/workflows.md`）。

