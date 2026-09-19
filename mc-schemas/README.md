# @mc-commander/schemas

MC_Commander 的共享接口契约包（zod）：API 请求/响应、WebSocket 事件与通知载荷的
唯一 schema 来源，服务端与 Web 前端共同消费，避免两端各写一份校验。

## 消费口径（两端不同，改契约前必读）

| 消费方 | 读取路径 | 说明 |
|---|---|---|
| `mc_manager_web` | `src/index.ts`（vite alias 直读源码） | 构建期即需类型，不经构建产物 |
| `mc_commander_server` | `dist/index.js`（`file:` 链接 + `package.json` 的 `main`） | Node 运行时消费构建产物 |

**因此：改 `src/` 后必须 `npm run build` 重建 `dist/` 并一并提交**——只改 `src` 不会报错，
但服务端会静默使用旧契约。`scripts/local-check.sh` 与 CI 均有「重建产物 vs 提交版」
byte 级比对守卫拦截该漂移。

## 常用命令

```bash
npm ci         # 安装依赖（本包独立安装，仓库无 workspace 根）
npm test       # vitest 全量
npm run lint   # oxlint（三个包同一把 linter，规则面见 .oxlintrc.json）
npm run build  # 构建 dist/index.js（rolldown，输出确定，同步时不会改写工作区）
```
