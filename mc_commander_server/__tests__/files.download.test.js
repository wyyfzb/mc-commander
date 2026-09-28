/**
 * File Download 端点 + 文件操作审计（文件管理器增强）
 * - GET /files/download：流式下载（内容一致/Content-Disposition/目录拒绝/404/
 *   路径穿越拒绝/symlink 越界拒绝/缺 path 参数 400）
 * - 审计：FILE_DOWNLOAD/FILE_UPLOAD/FILE_DELETE/FILE_RENAME/FILE_MKDIR/FILE_SAVE
 *   （recordAudit 以 mock 导出便于断言；files.test.js 的通用路径安全用例不在此重复）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../db/index.js', () => ({
  BanModel: {
    deactivateByPlayer: vi.fn(),
    deactivateByIp: vi.fn(),
  },
}));

vi.mock('../utils/audit.js', () => ({
  AuditActions: {
    FILE_DOWNLOAD: 'FILE_DOWNLOAD',
    FILE_UPLOAD: 'FILE_UPLOAD',
    FILE_DELETE: 'FILE_DELETE',
    FILE_RENAME: 'FILE_RENAME',
    FILE_MKDIR: 'FILE_MKDIR',
    FILE_SAVE: 'FILE_SAVE',
  },
  recordAudit: vi.fn(),
}));

import { createFileRoutes } from '../routes/files.js';
import { errorHandler } from '../middleware/error_handler.js';
import { ErrorCodes } from '../utils/response.js';
import { recordAudit } from '../utils/audit.js';

describe('GET /api/instances/:id/files/download', () => {
  let app;
  let mockManager;
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-dl-'));
    // 文本 + 二进制 + 中文名文件，覆盖下载内容与 header 编码
    fs.writeFileSync(path.join(tmpDir, 'server.properties'), 'motd=hello\n');
    fs.writeFileSync(path.join(tmpDir, 'world.dat'), Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50]));
    fs.writeFileSync(path.join(tmpDir, '存档 备份.txt'), '中文内容');
    fs.mkdirSync(path.join(tmpDir, 'world'));

    app = express();
    app.use(express.json());
    mockManager = {
      getInstance: vi.fn().mockReturnValue({ serverPath: tmpDir }),
    };
    app.use('/api', createFileRoutes(mockManager));
    app.use(errorHandler);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('下载文本文件 → 200 二进制体一致 + attachment 头', async () => {
    const res = await request(app)
      .get('/api/instances/s1/files/download')
      .query({ path: 'server.properties' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('server.properties');
    expect(res.body.toString()).toBe('motd=hello\n');
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength('motd=hello\n'));
  });

  it('下载二进制文件 → 字节级一致（不经过文本解码）', async () => {
    const res = await request(app)
      .get('/api/instances/s1/files/download')
      .query({ path: 'world.dat' });

    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50]))).toBe(true);
  });

  it('中文文件名 → Content-Disposition 双写（ASCII 回退 + RFC 5987 filename*）', async () => {
    const res = await request(app)
      .get('/api/instances/s1/files/download')
      .query({ path: '存档 备份.txt' });

    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(cd).toContain('filename="__ __.txt"');
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent('存档 备份.txt'));
    expect(res.body.toString()).toBe('中文内容');
  });

  it('子目录文件可下载', async () => {
    fs.mkdirSync(path.join(tmpDir, 'logs'));
    fs.writeFileSync(path.join(tmpDir, 'logs', 'latest.log'), '[INFO] started\n');

    const res = await request(app)
      .get('/api/instances/s1/files/download')
      .query({ path: 'logs/latest.log' });

    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('[INFO] started\n');
  });

  it('目录 → 400（目录下载不支持）', async () => {
    const res = await request(app).get('/api/instances/s1/files/download').query({ path: 'world' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
  });

  it('不存在的文件 → 404 FILE_NOT_FOUND', async () => {
    const res = await request(app)
      .get('/api/instances/s1/files/download')
      .query({ path: 'no-such-file.txt' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ErrorCodes.FILE_NOT_FOUND.code);
  });

  it('缺少 path 参数 → 400', async () => {
    const res = await request(app).get('/api/instances/s1/files/download');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(ErrorCodes.VALIDATION_ERROR.code);
  });

  it('路径穿越 ../ → 403 PATH_TRAVERSAL_DETECTED', async () => {
    const res = await request(app)
      .get('/api/instances/s1/files/download')
      .query({ path: '../outside.txt' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCodes.PATH_TRAVERSAL_DETECTED.code);
  });

  it('实例不存在 → 404 INSTANCE_NOT_FOUND', async () => {
    mockManager.getInstance.mockReturnValueOnce(null);

    const res = await request(app)
      .get('/api/instances/ghost/files/download')
      .query({ path: 'server.properties' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(ErrorCodes.INSTANCE_NOT_FOUND.code);
  });

  it('下载成功 → 审计 FILE_DOWNLOAD（含路径与体积）', async () => {
    await request(app).get('/api/instances/s1/files/download').query({ path: 'server.properties' });

    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 's1',
        action: 'FILE_DOWNLOAD',
        targetType: 'file',
        targetId: 'server.properties',
        detail: expect.objectContaining({ name: 'server.properties' }),
      }),
    );
  });

  it('下载失败（目录）→ 不写审计', async () => {
    await request(app).get('/api/instances/s1/files/download').query({ path: 'world' });

    expect(recordAudit).not.toHaveBeenCalled();
  });
});

describe('文件操作审计（FILE_SAVE/DELETE/RENAME/MKDIR/UPLOAD）', () => {
  let app;
  let mockManager;
  let tmpDir;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-files-audit-'));
    fs.writeFileSync(path.join(tmpDir, 'server.properties'), 'motd=hello\n');
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'old\n');

    app = express();
    app.use(express.json());
    mockManager = {
      getInstance: vi.fn().mockReturnValue({ serverPath: tmpDir, isRunning: false }),
    };
    app.use('/api', createFileRoutes(mockManager));
    app.use(errorHandler);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PUT content 成功 → FILE_SAVE（含编码）', async () => {
    const res = await request(app)
      .put('/api/instances/s1/files/content')
      .send({ path: 'notes.txt', content: 'new\n' });

    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 's1',
        action: 'FILE_SAVE',
        targetId: 'notes.txt',
        detail: expect.objectContaining({ name: 'notes.txt', encoding: 'utf-8' }),
      }),
    );
  });

  it('DELETE 文件成功 → FILE_DELETE', async () => {
    const res = await request(app).delete('/api/instances/s1/files').query({ path: 'notes.txt' });

    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 's1',
        action: 'FILE_DELETE',
        targetType: 'file',
        detail: expect.objectContaining({ isDirectory: false }),
      }),
    );
  });

  it('DELETE 目录成功 → FILE_DELETE（isDirectory: true）', async () => {
    fs.mkdirSync(path.join(tmpDir, 'world'));
    const res = await request(app).delete('/api/instances/s1/files').query({ path: 'world' });

    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'FILE_DELETE',
        targetType: 'directory',
        detail: expect.objectContaining({ isDirectory: true }),
      }),
    );
  });

  it('RENAME 成功 → FILE_RENAME（from/to）', async () => {
    const res = await request(app)
      .post('/api/instances/s1/files/rename')
      .send({ path: 'notes.txt', newPath: 'renamed.txt' });

    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 's1',
        action: 'FILE_RENAME',
        targetId: 'renamed.txt',
        detail: { from: 'notes.txt', to: 'renamed.txt' },
      }),
    );
  });

  it('MKDIR 成功 → FILE_MKDIR', async () => {
    const res = await request(app)
      .post('/api/instances/s1/files/mkdir')
      .send({ path: 'plugins/NewDir' });

    expect(res.status).toBe(200);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 's1',
        action: 'FILE_MKDIR',
        targetType: 'directory',
        targetId: 'plugins/NewDir',
      }),
    );
  });

  it('操作失败 → 不写审计', async () => {
    await request(app).delete('/api/instances/s1/files').query({ path: 'missing.txt' });

    expect(recordAudit).not.toHaveBeenCalled();
  });
});
