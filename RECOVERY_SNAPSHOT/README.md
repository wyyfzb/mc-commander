# RECOVERY_SNAPSHOT — 灾前源码快照（2026-08-28 容器重置前）

> 来源：主会话持久化读取缓存（tool-results/）。为轮 1-29 增强期间的中间/最终版本。
> 用途：重实现时的参考实现。**以 CHANGES.md 条目为准**，快照仅作辅助。

| 文件 | 版本时点 | 说明 |
|------|---------|------|
| audit-page.tsx | 轮 29 后（最终版） | 已含 React Query 化（chore-30），可直接回植 |
| give-item-panel.tsx | 08-28 10:13 (+08) | P0-3 时期版本 |
| deploy-dialog.tsx | 08-27 15:29 | 早期版本 |
| mc_server.service.js | 08-27 10:23 | 含 fix-1，早于 feat-5 熔断 |
| backups.routes.js | 08-27 17:51 | 含 feat-1 下载 + feat-2 审计埋点 |
| world.service.js | 08-27 10:24 | 世界目录白名单校验版 |
| files.test.js | 08-27 09:02 | 早期 files 路由测试 |
