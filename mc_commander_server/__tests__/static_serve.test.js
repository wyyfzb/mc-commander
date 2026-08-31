import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { setupStaticServe } from '../middleware/static_serve.js';
import { notFoundHandler } from '../middleware/error_handler.js';

// 临时 public 目录构造真实挂载链路：static → SPA fallback → notFoundHandler
describe('静态托管 + SPA fallback', () => {
  let publicDir;

  beforeEach(() => {
    publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-commander-static-'));
  });

  afterEach(() => {
    fs.rmSync(publicDir, { recursive: true, force: true });
  });

  // addRoutes 挂载在 notFoundHandler 之前（模拟真实路由层）
  function buildApp(addRoutes) {
    const app = express();
    setupStaticServe(app, publicDir);
    if (addRoutes) addRoutes(app);
    app.use(notFoundHandler);
    return app;
  }

  it('静态文件命中：index.html 与 asset.js 返回 200 + 正确 Content-Type', async () => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html><body>test-app</body></html>');
    fs.writeFileSync(path.join(publicDir, 'asset.js'), "console.log('asset');");

    const app = buildApp();
    const html = await request(app).get('/');
    const js = await request(app).get('/asset.js');

    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toContain('test-app');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.headers['cache-control']).toMatch(/max-age=604800/);
  });

  it('SPA 深链接：GET /players?q=x 回退到 index.html', async () => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html><body>spa</body></html>');

    const app = buildApp();
    const res = await request(app).get('/players?q=test').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('spa');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('/api/ 不受静态层影响：命中路由返回 JSON，未命中仍 JSON 404', async () => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html><body>spa</body></html>');

    const app = buildApp((a) => {
      a.get('/api/v1/ping', (req, res) => res.json({ ok: true }));
    });

    const hit = await request(app).get('/api/v1/ping');
    const miss = await request(app).get('/api/v1/nonexistent');

    expect(hit.status).toBe(200);
    expect(hit.body).toEqual({ ok: true });
    expect(miss.status).toBe(404);
    expect(miss.body.status).toBe('error');
  });

  it('index.html 缺失（未部署前端）：不挂载 fallback，非 /api 保持原 JSON 404', async () => {
    fs.writeFileSync(path.join(publicDir, 'asset.js'), "console.log('asset');");

    const app = buildApp();
    const res = await request(app).get('/players');

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });

  it('非 GET 请求不走 fallback，返回 JSON 404', async () => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html><body>spa</body></html>');

    const app = buildApp();
    const res = await request(app).post('/players').send({ name: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });

  it('/health 现有非 API 路由不被 fallback 拦截（deploy 就绪探测依赖 JSON）', async () => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html><body>spa</body></html>');

    const app = buildApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });

  it('/ws 前缀（非 upgrade 的普通 GET）不被 fallback 拦截', async () => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html><body>spa</body></html>');

    const app = buildApp();
    const res = await request(app).get('/ws/some-path');

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });

  it('大小写变体 /Health /HEALTH /API 同样保持 JSON 404（就绪探测脚本任意大小写）', async () => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html><body>spa</body></html>');

    const app = buildApp();
    for (const p of ['/Health', '/HEALTH', '/API/v1/ping']) {
      const res = await request(app).get(p);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('error');
    }
  });

  it('public 内 dotfile 不泄露内容（express.static 默认忽略 dotfiles）', async () => {
    fs.writeFileSync(path.join(publicDir, 'index.html'), '<html><body>spa</body></html>');
    fs.writeFileSync(path.join(publicDir, '.secret'), 'top-secret-value');

    const app = buildApp();
    const res = await request(app).get('/.secret');

    expect(res.text).not.toContain('top-secret-value');
  });
});
