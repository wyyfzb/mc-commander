import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock 隔离：SQLite 实例模型，避免路由副作用触及真实数据库 ──
vi.mock('../db/index.js', () => ({
  InstanceModel: {
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

import { createStatusRoutes } from '../routes/status.js';
import { InstanceModel } from '../db/index.js';
import { errorHandler } from '../middleware/error_handler.js';

// mock recordAudit 捕获审计断言；AuditActions 保留真实枚举值
vi.mock('../utils/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAudit: vi.fn() };
});
import { recordAudit, AuditActions } from '../utils/audit.js';
import { asInstance } from './helpers/msmp-instance.js';

describe('Status Routes', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    mockManager = {
      instances: new Map(),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    };
    app.use('/api', createStatusRoutes(mockManager));
    app.use(errorHandler); // 与生产环境一致：路由内部错误经全局 errorHandler 统一处理
  });

  describe('GET /api/overview', () => {
    it('should return overview with instance count and players', async () => {
      mockManager.getAllInstances.mockReturnValue([
        { id: 's1', name: 'S1', isRunning: true, playerCount: 5 },
        { id: 's2', name: 'S2', isRunning: false, playerCount: 0 },
      ]);

      const res = await request(app).get('/api/overview');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data.instanceCount).toBe(2);
      expect(res.body.data.runningCount).toBe(1);
      expect(res.body.data.totalPlayers).toBe(5);
    });
  });

  describe('GET /api/instances', () => {
    it('should return all instances', async () => {
      mockManager.getAllInstances.mockReturnValue([{ id: 's1', name: 'S1' }]);

      const res = await request(app).get('/api/instances');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET /api/instances/:id', () => {
    it('should return instance details', async () => {
      mockManager.getInstance.mockReturnValue({
        toStatus: () => ({ id: 's1', name: 'S1', isRunning: true }),
      });

      const res = await request(app).get('/api/instances/s1');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('s1');
    });

    it('should return 404 for non-existent instance', async () => {
      mockManager.getInstance.mockReturnValue(asInstance(undefined));

      const res = await request(app).get('/api/instances/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/instances/:id', () => {
    it('startCommand 已从可写字段移除，提交该字段返回 400（RCE 入口封堵）', async () => {
      const instance = {
        id: 's1',
        name: 'S1',
        startCommand: null,
        javaPath: 'java',
        maxMemory: null,
        minMemory: null,
        jarFile: null,
        toStatus: () => ({ id: 's1', name: 'S1' }),
      };
      mockManager.getInstance.mockReturnValue(asInstance(instance));
      InstanceModel.update.mockReturnValue({ changes: 1 });

      const res = await request(app)
        .put('/api/instances/s1')
        .send({ startCommand: 'java -Xmx4G -jar server.jar' });

      expect(res.status).toBe(400);
      expect(InstanceModel.update).not.toHaveBeenCalled();
    });

    it('should update instance name and persist to DB', async () => {
      vi.clearAllMocks();
      const instance = {
        id: 's1',
        name: 'S1',
        startCommand: null,
        javaPath: 'java',
        maxMemory: null,
        minMemory: null,
        jarFile: null,
        toStatus: () => ({ id: 's1', name: 'S1' }),
      };
      mockManager.getInstance.mockReturnValue(asInstance(instance));
      InstanceModel.update.mockReturnValue({ changes: 1 });

      const res = await request(app).put('/api/instances/s1').send({ name: 'S2' });

      expect(res.status).toBe(200);
      expect(InstanceModel.update).toHaveBeenCalledWith('s1', { name: 'S2' });
      // 内存实例字段同步更新（下次 start() 生效）
      expect(instance.name).toBe('S2');
      expect(res.body.data.id).toBe('s1');
    });

    it('should record INSTANCE_UPDATE audit with changed field list', async () => {
      vi.clearAllMocks();
      const instance = {
        id: 's1',
        name: 'S1',
        startCommand: null,
        javaPath: 'java',
        maxMemory: null,
        minMemory: null,
        jarFile: null,
        toStatus: () => ({ id: 's1', name: 'S1' }),
      };
      mockManager.getInstance.mockReturnValue(asInstance(instance));
      InstanceModel.update.mockReturnValue({ changes: 1 });

      const res = await request(app)
        .put('/api/instances/s1')
        .send({ maxMemory: '8G', autoRestart: false });

      expect(res.status).toBe(200);
      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 's1',
          action: AuditActions.INSTANCE_UPDATE,
          targetType: 'instance',
          targetId: 's1',
          // fields 记录本次实际生效的字段集合（allowedFields 遍历序，确定性）
          detail: { fields: ['maxMemory', 'autoRestart'] },
        }),
      );
    });

    it('should not record audit when no valid fields provided (400)', async () => {
      vi.clearAllMocks();
      mockManager.getInstance.mockReturnValue({
        id: 's1',
        toStatus: () => ({ id: 's1' }),
      });

      const res = await request(app).put('/api/instances/s1').send({});

      expect(res.status).toBe(400);
      // 审计语义 = 实际生效的变更，无可更新字段不记审计
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('should not record audit when validation rejects (400)', async () => {
      vi.clearAllMocks();
      const instance = {
        id: 's1',
        name: 'S1',
        startCommand: null,
        javaPath: 'java',
        maxMemory: null,
        minMemory: null,
        jarFile: null,
        toStatus: () => ({ id: 's1', name: 'S1' }),
      };
      mockManager.getInstance.mockReturnValue(asInstance(instance));

      const res = await request(app)
        .put('/api/instances/s1')
        .send({ startCommand: 'java -Xmx4G -jar server.jar' });

      expect(res.status).toBe(400);
      expect(InstanceModel.update).not.toHaveBeenCalled();
      // 校验拒绝未产生任何变更，不记审计
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('should sync instance.json with latest config when updating', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-instance-'));
      try {
        const original = {
          id: 's1',
          name: 'S1',
          type: 'vanilla',
          jarFile: 'server.jar',
          maxMemory: '4G',
          minMemory: '2G',
          mcVersion: '26.2',
          javaPath: 'java',
        };
        fs.writeFileSync(path.join(tmpDir, 'instance.json'), JSON.stringify(original));

        const instance = {
          id: 's1',
          name: 'S1',
          startCommand: null,
          javaPath: 'java',
          maxMemory: null,
          minMemory: null,
          jarFile: null,
          serverPath: tmpDir,
          toStatus: () => ({ id: 's1' }),
        };
        mockManager.getInstance.mockReturnValue(asInstance(instance));
        InstanceModel.update.mockReturnValue({ changes: 1 });

        const res = await request(app).put('/api/instances/s1').send({ name: 'Renamed' });

        expect(res.status).toBe(200);
        const synced = JSON.parse(fs.readFileSync(path.join(tmpDir, 'instance.json'), 'utf-8'));
        // 最新 name 已同步到 instance.json
        expect(synced.name).toBe('Renamed');
        // 未更新的字段保留原值
        expect(synced.maxMemory).toBe('4G');
        expect(synced.mcVersion).toBe('26.2');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return 400 when no valid fields provided', async () => {
      mockManager.getInstance.mockReturnValue({
        id: 's1',
        toStatus: () => ({ id: 's1' }),
      });

      const res = await request(app).put('/api/instances/s1').send({});

      expect(res.status).toBe(400);
    });

    it('should return 404 for non-existent instance', async () => {
      mockManager.getInstance.mockReturnValue(asInstance(undefined));

      // 载荷用合法空对象：输入侧 schema（issue 486）前置于实例存在性检查
      // （与 files/plugins 契约端点同构），非法载荷会先落到 400 而非 404
      const res = await request(app).put('/api/instances/nope').send({});

      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/instances/:id/start', () => {
    it('should start instance', async () => {
      // start 路由会先检查 serverPath 下的 eula.txt，需准备已同意的 EULA
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-status-'));
      fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
      const mockInstance = { start: vi.fn(), serverPath: tmpDir };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).post('/api/instances/s1/start');

      expect(res.status).toBe(200);
      expect(mockInstance.start).toHaveBeenCalled();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('start 抛内部错误 → 全局 errorHandler 统一返回 500 通用错误，不泄露 e.message', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-status-'));
      fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
      const mockInstance = {
        start: vi.fn(() => {
          throw new Error('already running');
        }),
        serverPath: tmpDir,
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).post('/api/instances/s1/start');

      // 内部错误统一经全局 errorHandler 处理：500 通用错误，不再 400 + e.message 泄露
      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Internal Server Error');
      expect(JSON.stringify(res.body)).not.toContain('already running');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('POST /api/instances/:id/command', () => {
    it('should send command', async () => {
      const mockInstance = { sendCommand: vi.fn(), isRunning: true };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/command')
        .set('Content-Type', 'application/json')
        .send({ command: 'list' });

      expect(res.status).toBe(200);
      // 第二实参是命令史来源标记：请求未带 source 时为 undefined，sendCommand 自身落回 'api'
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('list', { source: undefined });
    });

    it('should return 400 if command missing', async () => {
      const res = await request(app)
        .post('/api/instances/s1/command')
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 400 INSTANCE_NOT_RUNNING when server stopped', async () => {
      // 防回归：实例未运行时不抛 500，返回语义化错误（前端映射「实例未在运行」）
      mockManager.getInstance.mockReturnValue({ sendCommand: vi.fn(), isRunning: false });
      const res = await request(app)
        .post('/api/instances/s1/command')
        .set('Content-Type', 'application/json')
        .send({ command: 'list' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40002);
    });
  });

  describe('GET /api/instances/:id/logs', () => {
    it('should return logs', async () => {
      const mockInstance = {
        getLogs: vi.fn().mockReturnValue([{ time: 1, text: 'log' }]),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/logs');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('GET/PUT /api/instances/:id/properties', () => {
    it('GET 重新读取文件，反映游戏内命令对 server.properties 的修改', async () => {
      const freshProps = { 'white-list': 'true', pvp: 'true' };
      const mockInstance = {
        properties: { 'white-list': 'false' }, // 内存缓存为旧值
        isRunning: false,
        isRconConnected: false,
        _loadProperties: vi.fn().mockReturnValue(freshProps),
        readDifficulty: vi.fn().mockResolvedValue(null),
        _readGameTypeFromLevelDat: vi.fn().mockReturnValue(null),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/properties');

      expect(res.status).toBe(200);
      expect(mockInstance._loadProperties).toHaveBeenCalled();
      expect(res.body.data).toEqual(freshProps);
    });

    it('GET difficulty 用运行中真实值覆盖、gamemode 读 level.dat（/difficulty、/defaultgamemode 不写回文件）', async () => {
      const freshProps = { 'white-list': 'true', difficulty: 'hard', gamemode: 'survival' };
      const mockInstance = {
        properties: { difficulty: 'hard', gamemode: 'survival' }, // 文件旧值
        isRunning: true,
        isRconConnected: true,
        _loadProperties: vi.fn().mockReturnValue(freshProps),
        readDifficulty: vi.fn().mockResolvedValue('easy'),
        _readGameTypeFromLevelDat: vi.fn().mockReturnValue('creative'),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/properties');

      expect(res.status).toBe(200);
      expect(mockInstance.readDifficulty).toHaveBeenCalled();
      // 客户端应读到游戏内真实难度 easy 与默认模式 creative，而非文件旧值
      expect(res.body.data.difficulty).toBe('easy');
      expect(res.body.data.gamemode).toBe('creative');
    });

    it('GET 运行值不可读时（未运行/无 level.dat），difficulty 与 gamemode 回退到文件值', async () => {
      const freshProps = { difficulty: 'hard', gamemode: 'survival' };
      const mockInstance = {
        properties: { difficulty: 'hard', gamemode: 'survival' },
        isRunning: true,
        isRconConnected: false,
        _loadProperties: vi.fn().mockReturnValue(freshProps),
        readDifficulty: vi.fn().mockResolvedValue(null),
        _readGameTypeFromLevelDat: vi.fn().mockReturnValue(null),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/properties');

      expect(res.status).toBe(200);
      expect(res.body.data.difficulty).toBe('hard');
      expect(res.body.data.gamemode).toBe('survival');
    });

    it('PUT 保存属性并对支持运行中修改的属性下发命令', async () => {
      const mockInstance = {
        properties: { 'white-list': 'false' },
        isRunning: true,
        saveProperties: vi.fn(function (props) {
          this.properties = { ...this.properties, ...props };
        }),
        sendCommand: vi.fn(async () => null),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .put('/api/instances/s1/properties')
        .set('Content-Type', 'application/json')
        .send({ 'white-list': 'true' });

      expect(res.status).toBe(200);
      expect(mockInstance.saveProperties).toHaveBeenCalledWith({
        'white-list': 'true',
      });
      // white-list 支持运行中修改 → 下发 /whitelist on，无需重启
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('whitelist on');
      expect(res.body.data.restartRequired).toEqual([]);
    });

    it('PUT 需重启属性不下发命令并返回 restartRequired', async () => {
      const mockInstance = {
        properties: { pvp: 'true' },
        isRunning: true,
        saveProperties: vi.fn(function (props) {
          this.properties = { ...this.properties, ...props };
        }),
        sendCommand: vi.fn(async () => null),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .put('/api/instances/s1/properties')
        .set('Content-Type', 'application/json')
        .send({ pvp: 'false' });

      expect(res.status).toBe(200);
      // pvp 不支持运行中修改 → 不发送命令，返回需重启
      expect(mockInstance.sendCommand).not.toHaveBeenCalled();
      expect(res.body.data.restartRequired).toEqual(['pvp']);
    });

    it('PUT 服务器未运行时不需重启提示、不下发命令', async () => {
      const mockInstance = {
        properties: { 'white-list': 'false', pvp: 'true' },
        isRunning: false,
        saveProperties: vi.fn(function (props) {
          this.properties = { ...this.properties, ...props };
        }),
        sendCommand: vi.fn(async () => null),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .put('/api/instances/s1/properties')
        .set('Content-Type', 'application/json')
        .send({ 'white-list': 'true', pvp: 'false' });

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).not.toHaveBeenCalled();
      // 未运行时下次启动自然生效，无需提示重启
      expect(res.body.data.restartRequired).toEqual([]);
    });

    it('PUT 无效 body 返回 400', async () => {
      const mockInstance = { properties: {}, saveProperties: vi.fn() };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .put('/api/instances/s1/properties')
        .set('Content-Type', 'application/json')
        .send([1, 2, 3]);

      expect(res.status).toBe(400);
    });
  });
});
