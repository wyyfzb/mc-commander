import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';

void os; // used inside vi.hoisted via require

// feat-1 备份下载端点测试：mock DB + config，真实 fs + tar

const { tmpDir, backupDir, mockRows } = vi.hoisted(() => {
  const nodeFs = require('node:fs');
  const nodeOs = require('node:os');
  const nodePath = require('node:path');
  const tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mc-bak-dl-'));
  const backupDir = nodePath.join(tmpDir, 'backups');
  nodeFs.mkdirSync(backupDir, { recursive: true });
  const mockRows = new Map();
  return { tmpDir, backupDir, mockRows };
});

vi.mock('../db/backup.model.js', () => ({
  BackupModel: {
    findByIdWithPath: vi.fn((id) => mockRows.get(String(id)) || null),
    resetStaleInProgress: vi.fn(() => 0),
  },
}));

vi.mock('../config.js', () => {
  const nodePath = require('node:path');
  return {
    default: {
      backupsDir: backupDir,
      serversDir: nodePath.join(tmpDir, 'servers'),
    },
  };
});

vi.mock('../services/backup.service.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    BackupService: class {
      constructor() {}
    },
  };
});

import { createBackupRoutes } from '../routes/backups.js';
import { errorHandler } from '../middleware/error_handler.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', (req, res, next) => {
    req.serverManager = { getInstance: () => null };
    next();
  });
  app.use('/api/v1', createBackupRoutes({ getInstance: () => null }));
  app.use(errorHandler);
  return app;
}

describe('GET /api/v1/backups/:id/download', () => {
  let app;

  beforeEach(() => {
    mockRows.clear();
    app = makeApp();
  });

  afterEach(() => {
    for (const dir of fs.readdirSync(backupDir)) {
      fs.rmSync(path.join(backupDir, dir), { recursive: true, force: true });
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams tar.gz with valid gzip magic and correct file entries', async () => {
    const snapDir = path.join(backupDir, 'inst1_2026-08-27_world');
    fs.mkdirSync(path.join(snapDir, 'world', 'data'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'world', 'level.dat'), 'fake-nbt');
    fs.writeFileSync(path.join(snapDir, 'server.properties'), 'level-name=world');

    mockRows.set('1', {
      id: 1,
      instance_id: 'inst-1',
      name: 'Test',
      status: 'completed',
      file_path: snapDir,
    });

    const res = await request(app).get('/api/v1/backups/1/download').buffer();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/gzip');
    expect(res.headers['content-disposition']).toContain('attachment');

    const body = Buffer.from(res.body);
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);

    const raw = zlib.gunzipSync(body).toString();
    expect(raw).toContain('level.dat');
    expect(raw).toContain('server.properties');
  });

  it('returns 404 for non-existent backup', async () => {
    const res = await request(app).get('/api/v1/backups/99999/download');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40402);
  });

  it('returns 400 for non-completed backup', async () => {
    mockRows.set('2', {
      id: 2,
      status: 'creating',
      file_path: '/tmp/x',
    });
    const res = await request(app).get('/api/v1/backups/2/download');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
  });

  it('returns 404 when backup directory missing on disk', async () => {
    const missingDir = path.join(backupDir, 'nonexistent');
    mockRows.set('3', {
      id: 3,
      status: 'completed',
      file_path: missingDir,
    });
    const res = await request(app).get('/api/v1/backups/3/download');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40402);
  });

  it('returns 403 for path traversal', async () => {
    mockRows.set('5', {
      id: 5,
      status: 'completed',
      file_path: '/etc/evil',
    });
    const res = await request(app).get('/api/v1/backups/5/download');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(40302);
  });

  // 下载链路以目录为目标（tar -C <dir>）：目标为文件时 tar 退出码非 0、stdout 空，
  // 但响应头已发 ⇒ 若不在同步段拦下就变成 200 + 0 字节空档（伪成功）
  it('returns 400 for a file_path pointing at a file (not a directory)', async () => {
    const strayFile = path.join(backupDir, 'inst1', 'legacy.zip');
    fs.mkdirSync(path.dirname(strayFile), { recursive: true });
    fs.writeFileSync(strayFile, 'stray bytes');
    mockRows.set('7', {
      id: 7,
      status: 'completed',
      file_path: strayFile,
    });

    const res = await request(app).get('/api/v1/backups/7/download');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.headers['content-type']).toContain('application/json');
    // 未开 tar 流：失败回应不得带下载头，也不得是空体
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.text.length).toBeGreaterThan(0);
  });

  it.each([
    ['null', null],
    ['empty string', ''],
    ['whitespace-only', '   '],
    ['non-string', 12345],
  ])('returns 4xx (never 500) when file_path is %s', async (_label, filePath) => {
    mockRows.set('8', {
      id: 8,
      status: 'completed',
      file_path: filePath,
    });

    const res = await request(app).get('/api/v1/backups/8/download');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe(40402);
  });

  it('encodes non-ASCII filename via RFC 5987', async () => {
    const snapDir = path.join(backupDir, 'inst1_2026-08-27_世界备份');
    fs.mkdirSync(path.join(snapDir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'world', 'level.dat'), 'data');

    mockRows.set('6', {
      id: 6,
      status: 'completed',
      file_path: snapDir,
    });

    const res = await request(app).get('/api/v1/backups/6/download').buffer();
    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain('filename="');
  });
});
