import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createBackupRoutes } from '../routes/backups.js';
import { errorHandler } from '../middleware/error_handler.js';

// mock BackupModel 与 BackupService，避免真实 DB / 文件系统操作。
// 契约：BackupModel.findById 返回 camelCase（_toCamel 映射后），
// 路由读 backup.instanceId
vi.mock('../db/backup.model.js', () => ({
  BackupModel: {
    findById: vi.fn(),
    findAll: vi.fn(() => ({ total: 0 })),
    // 路由互斥检查（hasInProgressBackup）先 reset 卡死记录
    resetStaleInProgress: vi.fn(() => 0),
  },
}));
vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    constructor() {}
    async restoreBackup() {}
    async createBackup() {}
    async deleteBackup() {}
  },
}));

import { BackupModel } from '../db/backup.model.js';

describe('Backup Routes - restore（异步化 + restoring 状态机）', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    mockManager = {
      getInstance: vi.fn(),
    };
    app.use('/api/v1', createBackupRoutes(mockManager));
    app.use(errorHandler);
    vi.clearAllMocks();
    BackupModel.findAll.mockReturnValue({ total: 0 });
  });

  it('实例运行中恢复返回错误（运行中恢复会损坏世界数据）', async () => {
    BackupModel.findById.mockReturnValue({
      id: 1,
      instanceId: 's1',
      status: 'completed',
      worldName: 'world',
    });
    mockManager.getInstance.mockReturnValue({ isRunning: true, name: '演示实例' });

    const res = await request(app)
      .post('/api/v1/backups/1/restore')
      .send({ confirmName: '演示实例' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40003);
    expect(res.body.message).toContain('请先停止服务器');
  });

  it('实例已停止时可恢复：202 立即返回（恢复异步执行，不再阻塞等待解压完成）', async () => {
    BackupModel.findById.mockReturnValue({
      id: 2,
      instanceId: 's1',
      status: 'completed',
      worldName: 'world',
    });
    mockManager.getInstance.mockReturnValue({ isRunning: false, name: '演示实例' });

    const res = await request(app)
      .post('/api/v1/backups/2/restore')
      .send({ confirmName: '演示实例' });

    // 修复前：路由 await restoreBackup 同步解压完成才响应（大世界解压远超
    // 客户端 10s 超时 → 客户端超时误报 + 用户重复点击触发并发恢复）
    expect(res.status).toBe(202);
  });

  it('同实例已有恢复进行中（restoring）时拒绝新的恢复（409 RESTORE_IN_PROGRESS）', async () => {
    BackupModel.findById.mockReturnValue({
      id: 3,
      instanceId: 's1',
      status: 'completed',
      worldName: 'world',
    });
    mockManager.getInstance.mockReturnValue({ isRunning: false, name: '演示实例' });
    // 另一条备份记录正处于 restoring（恢复中）→ 互斥命中
    BackupModel.findAll.mockReturnValue({ total: 1 });

    const res = await request(app)
      .post('/api/v1/backups/3/restore')
      .send({ confirmName: '演示实例' });

    // 修复前：restore 入口不检查进行中操作，重复点击可并发执行两个
    // restore 对同一实例目录并发 rename/rmSync/解压，数据二次覆盖
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40903);
  });

  it('备份不存在返回 404', async () => {
    BackupModel.findById.mockReturnValue(null);

    const res = await request(app)
      .post('/api/v1/backups/999/restore')
      .send({ confirmName: '演示实例' });

    expect(res.status).toBe(404);
  });
});
