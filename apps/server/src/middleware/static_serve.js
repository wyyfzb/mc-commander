import path from 'path';
import fs from 'fs';
import express from 'express';

// 静态托管：前端 dist 产物由 Express 同源托管（vite base 为根路径、client 同源）。
// 静态文件是公开 UI 不敏感，认证仅 /api 前缀挂载，因此静态层不经认证。
// 须挂在 setupRoutes 之前：其内部 notFoundHandler 直接收尾响应，挂在其后无法命中；
// 静态层未命中一律 next()，交回路由层由 notFoundHandler 兜底 404 JSON。
export function setupStaticServe(app, publicDir) {
  const indexHtml = path.join(publicDir, 'index.html');
  // 未部署前端：整体不挂载，保持纯后端行为
  if (!fs.existsSync(indexHtml)) return;

  // 静态资源 7 天浏览器缓存。入口文件的 URL 不含内容哈希：升级后必须立刻取到新版，
  // 否则旧 index.html 会引用已删除的 hash 资产、旧首帧脚本会继续执行。
  const NO_CACHE_ENTRIES = new Set([
    'index.html',
    'theme-init.js',
    'registerSW.js',
    'manifest.webmanifest',
  ]);
  app.use(
    express.static(publicDir, {
      maxAge: '7d',
      setHeaders(res, filePath) {
        if (NO_CACHE_ENTRIES.has(path.basename(filePath))) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // SPA 深链接兜底：仅普通 GET；/api /ws 与现有非 API 路由 /health 交回原有链路。
  // /health 是 deploy 脚本就绪探测依赖（JSON 语义），不可被 fallback 换成 HTML。
  // 排除判断大小写不敏感：/Health、/HEALTH 等变体同样保持 JSON 语义
  // （就绪探测脚本可能使用任意大小写）
  app.use((req, res, next) => {
    const pathname = req.path.toLowerCase();
    if (
      req.method !== 'GET' ||
      pathname.startsWith('/api') ||
      pathname.startsWith('/ws') ||
      pathname === '/health'
    ) {
      return next();
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexHtml, (err) => {
      if (err) next(err);
    });
  });
}

export default { setupStaticServe };
