# @mc-commander/schemas

MC_Commander 的共享接口契约包（zod）：API 请求/响应、WebSocket 事件与通知载荷的
唯一 schema 来源，服务端与 Web 前端共同消费，避免两端各写一份校验。

## 消费口径（两端不同，改契约前必读）

| 消费方 | 读取路径 | 说明 |
|---|---|---|
| `apps/web` | `src/index.ts`（vite alias 直读源码） | 构建期即需类型，不经构建产物 |
| `apps/server` | `dist/index.js`（workspace 链接 + `package.json` 的 `main`） | Node 运行时消费构建产物 |

**因此：`dist` 是构建产物、不入库**——服务端测试与运行前必须先在仓库根
`npm run build -w apps/schemas`（`npm test` 带 `pretest` 自动做；`tools/ci/local-check.sh`
与 CI 也都显式构建并断言产物存在）。这样取代了旧口径「提交 dist + 逐字节比对守卫防漂移」：
仓库里不再存在可漂移的提交产物，也就不可能出现「服务端静默吃旧契约」。

## 常用命令

```bash
npm ci         # 在**仓库根**执行：workspace 一次装齐三包依赖
npm test       # vitest 全量
npm run lint   # oxlint（三个包同一把 linter，规则面见 .oxlintrc.json）
npm run build  # 构建 dist/index.js（rolldown；产物不入库，服务端消费前须先构建）
```
