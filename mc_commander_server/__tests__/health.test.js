import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// /health 不得触发实例状态扫描（getAllInstances 内部对每个实例
// 执行 toStatus()，含 RCON 探测等开销）。mock 掉全部子路由模块，
// 与并行修改的 A4/A5 文件解耦，仅验证 /health 自身行为。
vi.mock('../routes/status.js', () => ({
  createStatusRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/players.js', () => ({
  createPlayerRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/backups.js', () => ({
  createBackupRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/tasks.js', () => ({
  createTaskRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/files.js', () => ({
  createFileRoutes: vi.fn(() => express.Router()),
}));
vi.mock('../routes/server-jar.js', () => ({
  createServerJarRoutes: vi.fn(() => express.Router()),
}));

import { setupRoutes } from '../routes/index.js';

describe('GET /health', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    app = express();
    mockManager = {
      instances: new Map([
        ['s1', {}],
        ['s2', {}],
      ]),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    };
  });

  it('should return process liveness with static info', async () => {
    setupRoutes(app, mockManager);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.instanceCount).toBe(2);
    expect(typeof res.body.data.uptime).toBe('number');
    expect(res.body.data.version).toBeTruthy();
    expect(res.body.data.nodeVersion).toBeTruthy();
  });

  it('should not call getAllInstances / toStatus scan', async () => {
    setupRoutes(app, mockManager);

    await request(app).get('/health');

    expect(mockManager.getAllInstances).not.toHaveBeenCalled();
  });

  it('should count instances via instances map length, not status scan', async () => {
    // 即使 getAllInstances 抛错（模拟状态扫描失败），/health 也应正常返回
    mockManager.getAllInstances.mockImplementation(() => {
      throw new Error('toStatus scan failure');
    });
    setupRoutes(app, mockManager);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.data.instanceCount).toBe(2);
  });

  it('should return instanceCount 0 when serverManager is absent', async () => {
    setupRoutes(app, undefined);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.data.instanceCount).toBe(0);
  });

  it('should return instanceCount 0 when manager has no instances', async () => {
    mockManager.instances = new Map();
    setupRoutes(app, mockManager);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.data.instanceCount).toBe(0);
  });
});
