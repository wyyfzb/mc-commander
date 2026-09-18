/**
 * routes/backups.js 路由补测（issue #424）：列表/详情/创建/删除四端点此前
 * 零测试，restore 的 VALIDATION_ERROR 分支与 creating 互斥分支、download 的
 * tar 进程错误分支无覆盖。
 *
 * 既有 backups.test.js 已锁定 restore 主链（202/404/409 运行中/restoring 互斥）、
 * backups.download.test.js 已锁定 download 安全链（流式/404/400/路径
 * 穿越/RFC 5987）——本文件只补缺口，不重复上述断言。
 *
 * 范式沿用 tasks.route.test.js（#413）：vi.mock 数据模型层与服务层隔离
 * SQLite/文件系统，supertest + 内存 express 组装真实路由；schemas 与
 * parsePagination 走真实实现锁定契约；recordAudit 半覆盖捕获审计断言。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
import os from 'os';

vi.mock('../db/backup.model.js', () => ({
  BackupModel: {
    findAll: vi.fn(),
    findById: vi.fn(),
    findByIdWithPath: vi.fn(),
    resetStaleInProgress: vi.fn(),
  },
}));

vi.mock('../services/backup.service.js', () => ({
  BackupService: class {
    async createBackup() {}
    async restoreBackup() {}
    async deleteBackup() {}
  },
  resolveContained: vi.fn(),
}));

vi.mock('../utils/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAudit: vi.fn() };
});

vi.mock('child_process', () => ({ spawn: vi.fn() }));

import { createBackupRoutes } from '../routes/backups.js';
import { BackupModel } from '../db/backup.model.js';
import { resolveContained } from '../services/backup.service.js';
import { recordAudit } from '../utils/audit.js';
import { AuditActions } from '../utils/audit.js';
import { spawn } from 'child_process';
import { errorHandler } from '../middleware/error_handler.js';

/** schema 全形状备份行（backupItemSchema 可 parse，响应契约观测不漂移） */
function makeBackup(overrides = {}) {
  return {
    id: 1,
    instanceId: 's1',
    name: 'Backup_2026-09-04',
    description: null,
    type: 'manual',
    size: 1024,
    status: 'completed',
    worldName: 'world',
    createdAt: '2026-09-04 00:00:00',
    updatedAt: '2026-09-04 00:00:00',
    ...overrides,
  };
}

function buildApp({ getInstance = vi.fn(() => ({ name: '演示实例' })) } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createBackupRoutes({ getInstance }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  BackupModel.findAll.mockReturnValue({ backups: [], total: 0 });
  BackupModel.resetStaleInProgress.mockReturnValue(0);
});

describe('GET /instances/:instanceId/backups（列表）', () => {
  it('默认分页 + type/status 缺省透传 + 分页信封', async () => {
    BackupModel.findAll.mockReturnValue({ backups: [makeBackup()], total: 1 });
    const app = buildApp();

    const res = await request(app).get('/api/v1/instances/s1/backups');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Backup_2026-09-04');
    expect(res.body.pagination).toEqual({ total: 1, page: 1, pageSize: 20, totalPages: 1 });
    expect(BackupModel.findAll).toHaveBeenCalledWith({
      instanceId: 's1', page: 1, pageSize: 20, type: undefined, status: undefined,
    });
  });

  it('type/status 查询参数透传 + 自定义分页', async () => {
    const app = buildApp();
    await request(app).get('/api/v1/instances/s1/backups?page=2&pageSize=50&type=manual&status=completed');

    expect(BackupModel.findAll).toHaveBeenCalledWith({
      instanceId: 's1', page: 2, pageSize: 50, type: 'manual', status: 'completed',
    });
  });

  it('pageSize 超上限（maxPageSize=100）被 parsePagination 截断', async () => {
    const app = buildApp();
    await request(app).get('/api/v1/instances/s1/backups?pageSize=500');

    expect(BackupModel.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 100 })
    );
  });

  it('findAll 抛错 → 全局 errorHandler 500(50000)', async () => {
    BackupModel.findAll.mockImplementation(() => { throw new Error('db down'); });
    const app = buildApp();

    const res = await request(app).get('/api/v1/instances/s1/backups');

    expect(res.status).toBe(500);
    expect(res.body.code).toBe(50000);
  });
});

describe('GET /backups/:id（详情）', () => {
  it('命中返回 200 + camelCase 数据', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ id: 7 }));
    const app = buildApp();

    const res = await request(app).get('/api/v1/backups/7');

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.id).toBe(7);
    expect(res.body.data.worldName).toBe('world');
  });

  it('未命中 → 404 BACKUP_NOT_FOUND(40402)', async () => {
    BackupModel.findById.mockReturnValue(null);
    const app = buildApp();

    const res = await request(app).get('/api/v1/backups/999');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40402);
  });
});

describe('POST /instances/:instanceId/backups（创建）', () => {
  it('实例不存在 → 404 INSTANCE_NOT_FOUND(40401)', async () => {
    const app = buildApp({ getInstance: vi.fn(() => null) });

    const res = await request(app).post('/api/v1/instances/nope/backups').send({ name: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40401);
  });

  it('请求体契约：name 非字符串 → 400 VALIDATION_ERROR(40000) + 结构化 details', async () => {
    const app = buildApp(); // validateBody 中间件先于 handler 实例检查

    const res = await request(app).post('/api/v1/instances/s1/backups').send({ name: 123 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('creating 互斥 → 409 BACKUP_IN_PROGRESS(40901)（findAll 按 status 分流）', async () => {
    BackupModel.findAll.mockImplementation(({ status }) =>
      status === 'creating' ? { total: 1 } : { total: 0 }
    );
    const app = buildApp();

    const res = await request(app).post('/api/v1/instances/s1/backups').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40901);
  });

  it('restoring 互斥 → 409 BACKUP_IN_PROGRESS(40901)（第二分支）', async () => {
    BackupModel.findAll.mockImplementation(({ status }) =>
      status === 'restoring' ? { total: 1 } : { total: 0 }
    );
    const app = buildApp();

    const res = await request(app).post('/api/v1/instances/s1/backups').send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40901);
  });

  it('成功 201：name 缺省日期名 + type manual 透传 + 审计落 BACKUP_CREATE', async () => {
    BackupModel.findAll.mockReturnValue({ total: 0 });
    const app = buildApp();
    const svcCreate = vi.fn(async () => makeBackup({ id: 5 }));
    // 替换 service 实例方法（BackupService 构造在 createBackupRoutes 内）
    const { BackupService } = await import('../services/backup.service.js');
    const orig = BackupService.prototype.createBackup;
    BackupService.prototype.createBackup = svcCreate;

    try {
      const res = await request(app).post('/api/v1/instances/s1/backups').send({});

      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.id).toBe(5);
      // 默认名日期取服务器本地时区：toISOString 是 UTC，UTC+8 的凌晨会写成昨天
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      expect(svcCreate).toHaveBeenCalledWith('s1', {
        name: `Backup_${today}`,
        description: '',
        type: 'manual',
      });
      expect(recordAudit).toHaveBeenCalledWith({
        instanceId: 's1',
        action: AuditActions.BACKUP_CREATE,
        targetType: 'backup',
        targetId: '5',
      });
    } finally {
      BackupService.prototype.createBackup = orig;
    }
  });

  it('显式 name/description 透传（不缺省）', async () => {
    BackupModel.findAll.mockReturnValue({ total: 0 });
    const app = buildApp();
    const { BackupService } = await import('../services/backup.service.js');
    const svcCreate = vi.fn(async () => makeBackup());
    const orig = BackupService.prototype.createBackup;
    BackupService.prototype.createBackup = svcCreate;

    try {
      await request(app).post('/api/v1/instances/s1/backups')
        .send({ name: '我的备份', description: '恢复点' });

      expect(svcCreate).toHaveBeenCalledWith('s1', {
        name: '我的备份',
        description: '恢复点',
        type: 'manual',
      });
    } finally {
      BackupService.prototype.createBackup = orig;
    }
  });
});

describe('POST /backups/:id/restore（互补分支：既有测试未覆盖）', () => {
  it('status 非 completed → 400 VALIDATION_ERROR(40000)', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ status: 'failed' }));
    const app = buildApp();

    const res = await request(app).post('/api/v1/backups/1/restore').send({ confirmName: '演示实例' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('缺 confirmName → 400 40017（服务端强制实例名确认，UI 输入框不再是唯一闸门）', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ status: 'completed' }));
    const app = buildApp();

    // 缺字段由契约层拦（40000 + 字段级 details），不匹配由处理器拦（40017 语义化文案）
    const missing = await request(app).post('/api/v1/backups/1/restore');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe(40000);
    expect(missing.body.details.some((d) => d.path === 'confirmName')).toBe(true);

    const mismatched = await request(app)
      .post('/api/v1/backups/1/restore')
      .send({ confirmName: '另一个实例' });
    expect(mismatched.status).toBe(400);
    expect(mismatched.body.code).toBe(40017);
    // 拒绝路径零副作用：不做互斥判定也不动服务层
    expect(BackupModel.findAll).not.toHaveBeenCalled();
  });

  it('空名实例：确认目标退到备份名（实例名确认会空转，不得放行空串）', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ status: 'completed', name: '手动备份-1' }));
    const app = buildApp({ getInstance: vi.fn(() => ({ name: '' })) });

    // 空串天然匹配实例名 → 若确认目标仍是实例名，这道闸门等于没有
    const vacuous = await request(app).post('/api/v1/backups/1/restore').send({ confirmName: '' });
    expect(vacuous.status).toBe(400);
    expect(vacuous.body.code).toBe(40017);

    const withBackupName = await request(app)
      .post('/api/v1/backups/1/restore')
      .send({ confirmName: '手动备份-1' });
    expect(withBackupName.status).toBe(202);
  });

  it('confirmName 两侧 trim 后全等即放行（升级前旧值可能带首尾空白）', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ status: 'completed' }));
    const app = buildApp({ getInstance: vi.fn(() => ({ name: '演示实例 ' })) });

    const res = await request(app).post('/api/v1/backups/1/restore').send({ confirmName: '演示实例' });

    expect(res.status).toBe(202);
  });

  it('creating 互斥 → 409 RESTORE_IN_PROGRESS(40903)（creating 分支，既有只测 restoring）', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ status: 'completed' }));
    BackupModel.findAll.mockImplementation(({ status }) =>
      status === 'creating' ? { total: 1 } : { total: 0 }
    );
    const app = buildApp();

    const res = await request(app).post('/api/v1/backups/1/restore').send({ confirmName: '演示实例' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40903);
  });
});

describe('DELETE /backups/:id（删除）', () => {
  it('未命中 → 404 BACKUP_NOT_FOUND(40402)', async () => {
    BackupModel.findById.mockReturnValue(null);
    const app = buildApp();

    const res = await request(app).delete('/api/v1/backups/999');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40402);
  });

  it('creating 状态不可删 → 409 BACKUP_IN_PROGRESS(40901)', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ status: 'creating' }));
    const app = buildApp();

    const res = await request(app).delete('/api/v1/backups/1');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40901);
  });

  it('restoring 状态不可删 → 409 BACKUP_IN_PROGRESS(40901)（第二分支）', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ status: 'restoring' }));
    const app = buildApp();

    const res = await request(app).delete('/api/v1/backups/1');

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(40901);
  });

  it('成功 200：deleteBackup 调用 + 审计落 BACKUP_DELETE', async () => {
    BackupModel.findById.mockReturnValue(makeBackup({ id: 3 }));
    const app = buildApp();
    const { BackupService } = await import('../services/backup.service.js');
    const svcDelete = vi.fn(async () => {});
    const orig = BackupService.prototype.deleteBackup;
    BackupService.prototype.deleteBackup = svcDelete;

    try {
      const res = await request(app).delete('/api/v1/backups/3');

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(svcDelete).toHaveBeenCalledWith('3');
      expect(recordAudit).toHaveBeenCalledWith({
        instanceId: 's1',
        action: AuditActions.BACKUP_DELETE,
        targetType: 'backup',
        targetId: '3',
      });
    } finally {
      BackupService.prototype.deleteBackup = orig;
    }
  });
});

describe('GET /backups/:id/download（互补分支：tar 进程错误，既有安全链已覆盖）', () => {
  it('tar spawn error → 500(50000)（headers 未发送分支）', async () => {
    BackupModel.findByIdWithPath.mockReturnValue(makeBackup({ file_path: 'sub/dir' }));
    resolveContained.mockReturnValue(os.tmpdir());
    spawn.mockImplementation(() => {
      const tar = new EventEmitter();
      tar.stdout = new Readable({ read() {} });
      tar.stderr = new EventEmitter();
      setImmediate(() => tar.emit('error', new Error('tar exploded')));
      return tar;
    });
    const app = buildApp();

    const res = await request(app).get('/api/v1/backups/1/download');

    expect(res.status).toBe(500);
    // handler 先 setHeader('application/gzip')，express res.json 不覆盖已有
    // Content-Type → supertest 保留 Buffer，需手动解析 JSON 错误载荷
    const payload = JSON.parse(res.body.toString('utf8'));
    expect(payload.code).toBe(50000);
    expect(payload.message).toContain('tar exploded');
  });
});
