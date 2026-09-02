# Agent-C 任务分发清单（源自 roadmap 2026-08-31 v2）

> **用法（给 C 的协议）**：按 Phase 顺序逐条发布为 task issue（沿用 C 任务模板；
> 任务正文从 roadmap 对应条目扩写——roadmap 每条含 文件:行号 证据与现状描述）。
> 来源标注必填（如「来源：roadmap PR-2 / D3」）。单 Tick 最多发布 4 个；
> 发布前按 directive #94 去重；遵守依赖列约束（前置任务未合并不发布后继）。
> **Phase 6 为 owner 启动闸**：清单不含功能扩张任务，需所有者 directive 明确启动后才可分发。
> 每个 Phase 全部合并后，C 提一个 docs PR 在 roadmap 对应 Phase 标注 ✅。

## Phase 0 · 守门与止血 ✅（#1-3 全部合并）

| # | 任务标题 | 粒度 | 来源 | 验收要点 | 依赖 |
|---|---|---|---|---|---|
| 1 | [打磨] 设计 token 机器守门：拦截色板类 / dark: 前缀 / bg-black 与非法动效（一致性） | 中 | PR-1 / A1 | token-integrity 检出 Tailwind 色板类与 `dark:`；oxlint 禁 `transition-all`、`duration-\d+`；stylelint 拦 `rounded-\[`；对比度脚本补 focus-ring/50 组合；全部接入 CI | 无 |
| 2 | [打磨] 后端错误码契约测试 + 僵尸码清理 + 40003 双语义拆分（bug修复） | 中 | PR-2 / D3 | 「每路由实际返回 code」契约测试；40001/50001/40403 启用或删除；40003 拆分 INSTANCE_RUNNING(409)/PLAYER_NOT_ONLINE(400)；前端 errors.ts 同步 | 无 |
| 3 | [打磨] text-subtle 治理：提亮至 4.5:1 或用途清单制（一致性） | 中 | PR-3 / A4 | 全量对比度实测报告；按所选方案整改 301 处；对比度脚本豁免机制按方案调整（ref 色提亮 or 名单外 lint 失败） | 无 |

## Phase 1 · 组件统一 ✅（#4-16 全部合并；#13 query key 工厂经复核隐性闭环，#16 残余由 #240 收尾）

| # | 任务标题 | 粒度 | 来源 | 验收要点 | 依赖 |
|---|---|---|---|---|---|
| 4 | [打磨] DataTableShell + Pagination 收编三套手写表两套分页（一致性） | 大 | PR-4 / A2 | audit:178/231、player-table:416、file-list 三表收编；audit:73 与 player-table:495 两套分页统一 | #1 |
| 5 | [打磨] StatusPill 统一 badge/chip/手写 span 三轨（一致性） | 中 | PR-5 / A2 | chip 8-tone 为基础收编全部状态标识 | #4 |
| 6 | [打磨] DangerButton 收编三派 8+ 处 destructive（一致性） | 中 | PR-6 / A2 | 三派危险按钮统一单组件 | #4 |
| 7 | [打磨] PageHeader 统一五页页头配方（一致性） | 中 | PR-7 / A2 | title/description/actions 插槽；消除 files/dashboard/audit/world/settings 配方偏离 | #4 |
| 8 | [打磨] SearchInput 与 LoadingButton 收编（一致性） | 中 | PR-8 拆① / A3 | SearchInput 重复 4 处收编；LoadingButton spinner 4 种写法 + 「处理中…」3 处手写统一 | #4 |
| 9 | [打磨] EmptyState 迁移 7 处手写空态 + actionVariant 空态绿实底（一致性） | 中 | PR-8 拆② / A3 | 7 处手写空态迁移；允许空态 CTA 绿实底 | #4 |
| 10 | [打磨] Tabs line 变体收编 + 脏确认弹窗统一到 ConfirmDialog（一致性） | 中 | PR-8 拆③ / A3 | world:129-141 与 give-item-dialog:497-510 手写 tabs 收编；files:412-452 / world:166-181 / deploy:686-707 三份脏确认收敛 children 插槽 | #4 |
| 11 | [打磨] 二级组件残余：BatchActionBar / DescriptionList / CategoryChipFilter（一致性） | 中 | PR-8 拆④ / A3 | 批量条玻璃浮动 vs 实底异质感统一；三套「标签：值」收编；give-item 同文件两份 chip 去重 | #4 |
| 12 | [打磨] give-item-dialog 拆巨石为四组件（交互优化） | 大 | PR-9 拆① / A13① | 1611 行拆 item-picker / enchant-editor / potion-editor / preview-bar；行为不变，测试同步 | #1 |
| 13 | [打磨] query key 工厂统一至 api/queries.ts（一致性） | 小 | PR-9 拆② / A13② | 散落字符串 key 全部收编工厂；类型安全 | #12 |
| 14 | [打磨] 竞态守卫 hooks：useSequencedQuery / useSnapshotSave（bug修复） | 中 | PR-9 拆③ / A13③ | 防慢响应覆盖、保存竞态、实例切换串状态；含回归测试 | #13 |
| 15 | [打磨] 玻璃预算收敛：glass-overlay 6→2，弹窗回归实底（一致性） | 中 | PR-10 拆① / A6 | 只留命令面板与 notification-drawer；batch-bar 与 plugins 批量条统一；玻璃预算纳入 CI 断言（衔接 #1） | #1 |
| 16 | [打磨] 色板/动效瘦身 + 圆角双轨清理 + CTA 配额成文（一致性） | 中 | PR-10 拆② / A5/A7/A12 | 删死色 orange；purple 49 处转 `--mcs-special-fg`；维度三色注册 @theme；删 motion-slow；圆角双轨规则改写；「每页 1 绿实底 CTA + outline ≤2 排」写入 design-review-guidelines 并全站清点；emergency 停止按钮升级 destructive | #1 |

## Phase 2 · UX 工作流 ✅（#17-20 全部合并；#20 含对比度复算记录 PR#248）

| # | 任务标题 | 粒度 | 来源 | 验收要点 | 依赖 |
|---|---|---|---|---|---|
| 17 | [打磨] dirty 守卫补齐 ×2 + 行内校验统一（deploy 范式）+ 三级反馈规范（交互优化） | 大 | PR-11 / B2/B3/B9 | instance-settings-dialog 与 webhook-page 补 useUnsavedGuard；task/connection 行内报错对齐 deploy 范式；复制文件/切换实例瞬态 toast 降级；B9 小项清单清完 | #4 |
| 18 | [打磨] 确认矩阵按可逆性重排：可逆高频操作 undo toast（体验升级） | 中 | PR-12 拆① / B4 | 踢人/OP/白名单降为行内撤销式（5s undo）；不可逆+全量保持输入确认 | #4 |
| 19 | [打磨] 命令历史持久化 + 页面状态记忆 + RCON 禁用可解释（交互优化） | 中 | PR-12 拆② / B5/B6/B7 | 命令历史 localStorage 持久化（优先级高于 chips）；玩家筛选/当前文件/终端滚动入 zustand 持久化；RCON 断开补禁用原因与降级横幅文案 | #4 |
| 20 | [打磨] 亮色 accent 对比度调档（一致性） | 小 | PR-13 / B10 | accent-light 单独实测调档（onboarding 保存/dashboard 发送达标）；MC 时钟弧线亮暗观感实测记录 | #3 |

## Phase 3 · 无障碍 ✅（#21/#23 合并（PR#257 SHA d883819 / PR#253 SHA 3f28b22）；#22 经代码验证已实现，免发布）

| # | 任务标题 | 粒度 | 来源 | 验收要点 | 依赖 |
|---|---|---|---|---|---|
| 21 | [打磨] xterm 屏读支持：screenReaderMode 或 aria-live 镜像（无障碍·高危） | 中 | PR-14 拆① / C1 | server-terminal:107-115 屏读不再黑洞；最近 N 行可被屏幕阅读器访问 | 无 |
| 22 | [打磨] files 页 <768px 降级：目录树收 Sheet + 编辑器全屏覆盖（无障碍·高危） | 大 | PR-14 拆② / C2 | 三栏窄屏不溢出；桌面窄屏渲染「建议使用紧急视图」降级条（复用 degradation-banners） | 无 |
| 23 | [打磨] 无障碍批次：player 列显隐 + 抽屉焦点 + focus 实色 + 小项（无障碍） | 中 | PR-14 拆③ / C3-C6 | player-table 窄屏隐藏 position/ping/playTime 或 sticky 首列；app-sidebar 抽屉 Esc/焦点陷阱；Button ring 改实色并补 50% alpha 混合检测；th scope、avatar 懒加载、file-list 虚拟化 | #1 |

## Phase 4 · 后端体验根源（1-2 周，与前端并行）

| # | 任务标题 | 粒度 | 来源 | 验收要点 | 依赖 |
|---|---|---|---|---|---|
| 24 | [打磨] RCON_UNAVAILABLE 专用错误码 + world catch{} 返回 0 修复（bug修复） | 中 | PR-15 / D2 | 前端可区分「没开/没配/真故障」；status:763-777 不再吞错返回 0 天数；RCON 超时脱离统一 50000 | 无 |
| 25 | [打磨] 全局指标 WS 推送替代 5s 轮询（功能闭环） | 大 | PR-16 / D1 | overview/system-stats/实例列表走 broadcastAll 推送；前端轮询代码删除；限流 240 维持 | #24 |
| 26 | [打磨] tempban 启动对账 + 面板自身数据纳入备份（功能闭环） | 中 | PR-17 拆① / D4/D6 | 实例启动对账 banned-players.json 与 DB；SQLite/.env 进备份范围 | 无 |
| 27 | [打磨] webhook 私网 SSRF 黑名单 + helmet 最小安全头（bug修复） | 小 | PR-17 拆② / D6 | ~20 行黑名单；CSP/XFO/X-Content-Type-Options 就位 | 无 |
| 28 | [打磨] API Key 明文存储与登录锁定持久化安全评估（bug修复·评估） | 小 | PR-17 拆③ / D6 | 评估报告（keys.js:19-30 明文写回、auth.js:27-50 内存锁定），给结论与方案不实作；实作任务按结论另发 | 无 |
| 29 | [打磨] schema 单源 zod 包：API/WS/通知三方同源（一致性·架构） | 大 | PR-18 / D5 | 服务端 parse、前端 z.infer、MSW mock 共用；两次可选字段崩溃（a39c78c/d974a9f）的结构性根治 | #2 |

## Phase 5 · 品牌（3-5 天，可与 Phase 2-3 并行）

| # | 任务标题 | 粒度 | 来源 | 验收要点 | 依赖 |
|---|---|---|---|---|---|
| 30 | [打磨] 极简 Logo 与品牌触点补齐（体验升级） | 中 | PR-19 / E1/E2 | `MC_` mono 字标或提示符 SVG（仅现行 token 色）；favicon→侧栏品牌区→onboarding→PWA 图标→og:image→README shields | 无 |
| 31 | [打磨] 命令预览块全站化 + 命令历史状态回显（体验升级） | 大 | PR-20 拆① / E3 | world 天气/时间、任务执行、备份恢复补命令预览；历史回显已送达/重试中/失败原因；版本自适应标注 | #4 |
| 32 | [打磨] cron 可视化编辑器（体验升级） | 中 | PR-20 拆② / E4 | stepper + 星期 chip + 预设 → 实时表达式 + 人话解释 + 「下次运行约 X」；tasks 新建任务升级 | 无 |
| 33 | [打磨] 侧栏活跃态 2px 绿 inset 指示（一致性） | 小 | PR-20 拆③ / E5 | 指示条+底色+文字转亮；禁加粗/字号变化防行高跳动 | 无 |

## Phase 6 · 功能扩张（owner 启动闸——本清单不含）

启动条件：所有者 directive 明确启动 + i18n 字符串表就位（A13⑤，扩张前最后一个任务）。
启动后按 roadmap G 板块顺序分发：文件管理增强残余 → 主动式运维告警条 → 跨页玩家面板 → 玩家洞察周报 → 其余 P1。

## 发布顺序总览

```
Phase 0（#1-3，并行）─┬─→ Phase 1（#4 先行 → #5-16）─┬─→ Phase 3（#21-22 无依赖可提前）
                      └─→ Phase 2（#17-19，可与 P1 后半并行）
Phase 4（#24/26/27/28 无依赖可随 Phase 0 后启动）→ #25 → #29
Phase 5（#30/32/33 无依赖可穿插）→ #31
```

> 单 agent 串行领取时按编号顺序即安全；B/A 双人并行时注意同一前端组件文件的任务
> 不要同时持有（#4-11、#17、#31 都可能触 player-table / give-item-dialog）。
