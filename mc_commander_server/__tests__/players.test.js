import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPlayerRoutes } from '../routes/players.js';
import { errorHandler } from '../middleware/error_handler.js';
import express from 'express';
import request from 'supertest';
import { shadowProfilePath } from '../utils/player-utils.js';

// mock BanModel，避免测试依赖真实 DB
vi.mock('../db/index.js', () => ({
  BanModel: {
    findActiveByInstance: vi.fn(() => []),
    findAllByInstance: vi.fn(() => []),
    create: vi.fn(() => ({ id: 1 })),
    deactivateByPlayer: vi.fn(),
    deactivateByIp: vi.fn(),
  },
}));
import { BanModel } from '../db/index.js';

// mock recordAudit 捕获审计断言；AuditActions 保留真实枚举值
vi.mock('../utils/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAudit: vi.fn() };
});
import { recordAudit, AuditActions } from '../utils/audit.js';
import { asInstance } from './helpers/msmp-instance.js';

describe('Player Routes', () => {
  let app;
  let mockManager;
  let tmpServerPath;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    mockManager = {
      instances: new Map(),
      getInstance: vi.fn(),
    };
    app.use('/api', createPlayerRoutes(mockManager));
    app.use(errorHandler); // 注册全局错误处理，与生产环境一致
    // 每个测试独立的临时服务器目录（banned-ips.json 等封禁文件读取用）
    tmpServerPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-commander-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpServerPath, { recursive: true, force: true });
  });

  describe('GET /api/instances/:id/players', () => {
    it('should return online players', async () => {
      const now = Date.now();
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map([
          [
            'Steve',
            {
              name: 'Steve',
              joinTime: now,
              sessions: [{ start: now, end: null, duration: 0 }],
            },
          ],
        ]),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
        _worldSpawn: null,
        _computePlayerStats: () => ({
          totalOnline: 0,
          loginCount: 1,
          offlineSince: 0,
          deathCount: 0,
          achievementCount: 0,
          sleepCount: 0,
        }),
        _mergePlayerEvents: (a, b) => [...(a || []), ...(b || [])],
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Steve');
      expect(res.body.data[0].sessions).toHaveLength(1);
      expect(res.body.data[0].stats.loginCount).toBe(1);
    });

    it('玩家名含路径分量时不得读出 serverPath 根下的 .json（读侧越界守）', async () => {
      // 名字来自 instance.players（服务端 stdout / 名单），不是 HTTP 入参，
      // 所以这个端点上的 validatePlayerName 管不到它——落点必须自证
      const victim = path.join(tmpServerPath, 'instance.json');
      fs.writeFileSync(victim, JSON.stringify({ totalPlayTime: 999999 }));
      const now = Date.now();
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map([['../instance', { name: '../instance', joinTime: now, sessions: [] }]]),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
        _worldSpawn: null,
        _computePlayerStats: () => ({
          totalOnline: 0,
          loginCount: 1,
          offlineSince: 0,
          deathCount: 0,
          achievementCount: 0,
          sleepCount: 0,
        }),
        _mergePlayerEvents: (a, b) => [...(a || []), ...(b || [])],
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      // 越界读被拒 ⇒ 不会把受害文件里的值当作战绩时长带进响应
      expect(JSON.stringify(res.body)).not.toContain('999999');
    });

    it('should return 404 for non-existent instance', async () => {
      mockManager.getInstance.mockReturnValue(undefined);

      const res = await request(app).get('/api/instances/nonexistent/players');

      expect(res.status).toBe(404);
    });

    it('should include banExpiresAt for temp-banned players', async () => {
      vi.clearAllMocks();
      const now = Date.now();
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map([['Steve', { name: 'Steve', joinTime: now, sessions: [] }]]),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
        _worldSpawn: null,
        _computePlayerStats: () => ({
          totalOnline: 0,
          loginCount: 1,
          offlineSince: 0,
          deathCount: 0,
          achievementCount: 0,
          sleepCount: 0,
        }),
        _mergePlayerEvents: (a, b) => [...(a || []), ...(b || [])],
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));
      BanModel.findActiveByInstance.mockReturnValue([
        { targetType: 'player', target: 'Steve', expiresAt: now + 86_400_000 },
      ]);

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      expect(res.body.data[0].banExpiresAt).toBe(now + 86_400_000);
      expect(BanModel.findActiveByInstance).toHaveBeenCalledWith('s1');
    });

    it('在线玩家 events 合并持久化 playerdata（重启后成就历史不丢）', async () => {
      vi.clearAllMocks();
      const now = Date.now();
      // 持久化 playerdata：内存 playerEvents 为空（模拟服务端重启）
      const playerdataDir = path.join(tmpServerPath, 'playerdata');
      fs.mkdirSync(playerdataDir, { recursive: true });
      fs.writeFileSync(
        shadowProfilePath({ serverPath: tmpServerPath, playerName: 'Steve' }),
        JSON.stringify({
          events: [{ type: 'achievement', message: 'Stone Age', timestamp: now - 1000 }],
          totalPlayTime: 120,
        }),
      );
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map([['Steve', { name: 'Steve', joinTime: now, sessions: [] }]]),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(), // 刚重启：内存事件为空
        _worldSpawn: null,
        _computePlayerStats: (sessions, events) => ({
          totalOnline: 0,
          loginCount: 1,
          offlineSince: 0,
          deathCount: 0,
          achievementCount: events.length,
          sleepCount: 0,
        }),
        _mergePlayerEvents: (a, b) => [...(a || []), ...(b || [])],
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      // 修复前：events 只读内存（空），离线分支 240 行却合并——行为不一致
      expect(res.body.data[0].events).toHaveLength(1);
      expect(res.body.data[0].stats.achievementCount).toBe(1);
    });

    it('players 路由 DB 抛错返回 500（不挂起不崩溃）', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map(),
        getAllKnownPlayers: () => {
          throw new Error('DB down');
        },
        playerEvents: new Map(),
        _worldSpawn: null,
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/players');

      // 修复前：async 路由无 try/catch，Express 4 无法捕获 Promise rejection
      // → 请求挂起 + unhandledRejection（Node 默认 throw 进程崩溃）
      expect(res.status).toBe(500);
    });

    it('players/bans 路由 DB 抛错返回 500（不挂起不崩溃）', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map(),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));
      BanModel.findAllByInstance.mockImplementation(() => {
        throw new Error('DB down');
      });

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.status).toBe(500);
    });

    it('官方封禁条目按 expires 判定：临时条出到期时间、哨兵为永久、过期归历史', async () => {
      vi.clearAllMocks();
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-players.json'),
        JSON.stringify([
          {
            name: 'Steve',
            reason: '临时',
            created: '2026-10-01 00:00:00 +0000',
            expires: '2030-01-01 06:00:00 +0000',
          },
          {
            name: 'Alex',
            reason: '永久',
            created: '2026-10-01 00:00:00 +0000',
            expires: 'forever',
          },
          {
            name: 'Bob',
            reason: '过期',
            created: '2026-10-01 00:00:00 +0000',
            expires: '1999-01-01 00:00:00 +0000',
          },
          { name: 'Carol', reason: '缺字段', created: '2026-10-01 00:00:00 +0000' },
        ]),
      );
      mockManager.getInstance.mockReturnValue({
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map(),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
      });

      // 上一个用例给 findAllByInstance 装了抛错实现，而 clearAllMocks 不清实现：显式复位
      BanModel.findAllByInstance.mockImplementation(() => []);
      BanModel.findActiveByInstance.mockImplementation(() => []);

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.status).toBe(200);
      const byTarget = Object.fromEntries(res.body.data.map((b) => [b.target, b]));
      expect(byTarget.Steve).toMatchObject({
        isPermanent: false,
        expiresAt: Date.parse('2030-01-01T06:00:00Z'),
        isActive: true,
      });
      expect(byTarget.Alex).toMatchObject({ isPermanent: true, expiresAt: null, isActive: true });
      expect(byTarget.Carol).toMatchObject({ isPermanent: true, expiresAt: null, isActive: true });
      // 过期的官条目仍列出（是历史），但不再是生效中——此前一律 isActive: true 且显示「永久」
      expect(byTarget.Bob).toMatchObject({
        isPermanent: false,
        expiresAt: Date.parse('1999-01-01T00:00:00Z'),
        isActive: false,
        expired: true,
      });
      // 生效中的条目不该带「到期结束」标记
      expect(byTarget.Steve.expired).toBe(false);
    });

    it('真实 26.3 落盘的官方条目（服务端本地时区 +0800）解出正确到期时刻', async () => {
      vi.clearAllMocks();
      // 夹具是真实 26.3 服务端经 MSMP bans/add 写出的原样文件：到期时间带 +0800 偏移，
      // 等价于 2030-01-01T06:00:00Z
      fs.copyFileSync(
        path.join(import.meta.dirname, 'fixtures', 'banned-players-real.json'),
        path.join(tmpServerPath, 'banned-players.json'),
      );
      BanModel.findAllByInstance.mockImplementation(() => []);
      BanModel.findActiveByInstance.mockImplementation(() => []);
      mockManager.getInstance.mockReturnValue({
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map(),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
      });

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({
        target: 'ProbeUser',
        isPermanent: false,
        expiresAt: Date.parse('2030-01-01T06:00:00Z'),
        isActive: true,
        expired: false,
        createdAt: '2026-10-08 06:16:07 +0800',
      });
    });

    it('官方封禁条目的 expires 解析不出：非永久且到期时间未知，仍算生效中', async () => {
      vi.clearAllMocks();
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-players.json'),
        JSON.stringify([{ name: 'Steve', reason: 'x', expires: '不是时间' }]),
      );
      mockManager.getInstance.mockReturnValue({
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map(),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
      });

      // 上一个用例给 findAllByInstance 装了抛错实现，而 clearAllMocks 不清实现：显式复位
      BanModel.findAllByInstance.mockImplementation(() => []);
      BanModel.findActiveByInstance.mockImplementation(() => []);

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.body.data[0]).toMatchObject({
        target: 'Steve',
        isPermanent: false,
        expiresAt: null,
        isActive: true,
      });
    });

    it('should mark online player as ip-banned when IP in banned-ips.json', async () => {
      vi.clearAllMocks();
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-ips.json'),
        JSON.stringify([{ ip: '1.2.3.4', reason: 'Cheating', created: '2026-01-01 00:00:00' }]),
      );
      const now = Date.now();
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map([
          [
            'Steve',
            {
              name: 'Steve',
              ip: '1.2.3.4',
              joinTime: now,
              sessions: [],
            },
          ],
        ]),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
        _worldSpawn: null,
        _computePlayerStats: () => ({
          totalOnline: 0,
          loginCount: 1,
          offlineSince: 0,
          deathCount: 0,
          achievementCount: 0,
          sleepCount: 0,
        }),
        _mergePlayerEvents: (a, b) => [...(a || []), ...(b || [])],
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      expect(res.body.data[0].isIpBanned).toBe(true);
      expect(res.body.data[0].ipBanExpiresAt).toBeNull();
    });

    it('should include ipBanExpiresAt from active temp ip bans', async () => {
      vi.clearAllMocks();
      const now = Date.now();
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
        players: new Map([
          [
            'Steve',
            {
              name: 'Steve',
              ip: '5.6.7.8',
              joinTime: now,
              sessions: [],
            },
          ],
        ]),
        getAllKnownPlayers: () => new Map(),
        playerEvents: new Map(),
        _worldSpawn: null,
        _computePlayerStats: () => ({
          totalOnline: 0,
          loginCount: 1,
          offlineSince: 0,
          deathCount: 0,
          achievementCount: 0,
          sleepCount: 0,
        }),
        _mergePlayerEvents: (a, b) => [...(a || []), ...(b || [])],
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));
      BanModel.findActiveByInstance.mockReturnValue([
        { targetType: 'ip', target: '5.6.7.8', expiresAt: now + 3_600_000 },
      ]);

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      expect(res.body.data[0].isIpBanned).toBe(false);
      expect(res.body.data[0].ipBanExpiresAt).toBe(now + 3_600_000);
    });
  });

  describe('GET /api/instances/:id/players/bans', () => {
    it('should return 404 for non-existent instance', async () => {
      mockManager.getInstance.mockReturnValue(undefined);

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.status).toBe(404);
    });

    it('should merge temp ban records with vanilla ban files', async () => {
      vi.clearAllMocks();
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-players.json'),
        JSON.stringify([
          { name: 'Alex', uuid: 'u1', reason: 'Griefing', created: '2026-01-01 00:00:00' },
        ]),
      );
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-ips.json'),
        JSON.stringify([{ ip: '9.9.9.9', reason: 'Cheating', created: '2026-02-01 00:00:00' }]),
      );
      BanModel.findAllByInstance.mockReturnValue([
        {
          id: 1,
          targetType: 'player',
          target: 'Steve',
          reason: 'Cheating',
          isActive: true,
          expiresAt: 1750000000000,
          createdAt: '2026-08-01 10:00:00',
        },
        {
          id: 2,
          targetType: 'ip',
          target: '5.5.5.5',
          reason: 'Cheating',
          isActive: false,
          expiresAt: 1700000000000,
          createdAt: '2026-07-01 10:00:00',
        },
      ]);
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.status).toBe(200);
      const bans = res.body.data;
      expect(bans).toHaveLength(4);
      // 生效中在前（临时到期时间升序），永久封禁其次，历史最后
      expect(bans[0].target).toBe('Steve'); // 临时生效（有到期时间）
      expect(bans[0].isActive).toBe(true);
      expect(bans[0].isPermanent).toBe(false);
      expect(bans[1].target).toBe('Alex'); // 永久玩家封禁
      expect(bans[1].isPermanent).toBe(true);
      expect(bans[2].target).toBe('9.9.9.9'); // 永久 IP 封禁
      expect(bans[3].target).toBe('5.5.5.5'); // 历史记录
      expect(bans[3].isActive).toBe(false);
      expect(BanModel.findAllByInstance).toHaveBeenCalledWith('s1');
    });

    it('should skip vanilla ban file entries that have an active temp ban (dedupe)', async () => {
      vi.clearAllMocks();
      // Steve 有生效中的临时封禁 → banned-players.json 中对应的原版条目应被跳过
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-players.json'),
        JSON.stringify([
          { name: 'Steve', uuid: 'u1', reason: 'Cheating', created: '2026-08-01 09:00:00' },
          { name: 'Alex', uuid: 'u2', reason: 'Griefing', created: '2026-01-01 00:00:00' },
        ]),
      );
      // 1.2.3.4 有生效中的临时 IP 封禁 → banned-ips.json 中对应的原版条目应被跳过
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-ips.json'),
        JSON.stringify([{ ip: '1.2.3.4', reason: 'Cheating', created: '2026-08-01 09:00:00' }]),
      );
      BanModel.findActiveByInstance.mockReturnValue([
        { id: 1, targetType: 'player', target: 'Steve', expiresAt: 1750000000000 },
        { id: 2, targetType: 'ip', target: '1.2.3.4', expiresAt: 1750000000000 },
      ]);
      BanModel.findAllByInstance.mockReturnValue([
        {
          id: 1,
          targetType: 'player',
          target: 'Steve',
          reason: 'Cheating',
          isActive: true,
          expiresAt: 1750000000000,
          createdAt: '2026-08-01 10:00:00',
        },
        {
          id: 2,
          targetType: 'ip',
          target: '1.2.3.4',
          reason: 'Cheating',
          isActive: true,
          expiresAt: 1750000000000,
          createdAt: '2026-08-01 10:00:00',
        },
      ]);
      const mockInstance = {
        isRunning: true,
        serverPath: tmpServerPath,
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.status).toBe(200);
      const bans = res.body.data;
      // 临时封禁各一条 + Alex 永久 = 3；Steve/1.2.3.4 的原版条目被跳过，避免同一封禁两条
      expect(bans).toHaveLength(3);
      expect(bans[0].target).toBe('Steve');
      expect(bans[0].isPermanent).toBe(false);
      expect(bans[1].target).toBe('1.2.3.4');
      expect(bans[1].isPermanent).toBe(false);
      expect(bans[2].target).toBe('Alex');
      expect(bans[2].isPermanent).toBe(true);
      expect(BanModel.findActiveByInstance).toHaveBeenCalledWith('s1');
    });
  });

  describe('POST /api/instances/:id/players/:player/op', () => {
    it('should op player', async () => {
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).post('/api/instances/s1/players/Steve/op');

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('op Steve');
    });

    it('MSMP 可用时走结构化方法：不再发命令', async () => {
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
        _msmpRequest: vi.fn(async () => [{ player: { name: 'Steve' }, permissionLevel: 4 }]),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).post('/api/instances/s1/players/Steve/op');

      expect(res.status).toBe(200);
      expect(mockInstance._msmpRequest).toHaveBeenCalledWith(
        'minecraft:operators/add',
        [[{ player: { name: 'Steve' }, permissionLevel: 4, bypassesPlayerLimit: false }]],
        expect.any(Number),
      );
      expect(mockInstance.sendCommand).not.toHaveBeenCalled();
    });

    it('MSMP 有答复但目标没落地：接口报错，且不回退命令重复执行', async () => {
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
        _msmpRequest: vi.fn(async () => []),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).post('/api/instances/s1/players/Steve/op');

      expect(res.status).toBe(500);
      expect(mockInstance.sendCommand).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/instances/:id/players/:player/op', () => {
    it('should deop player', async () => {
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).delete('/api/instances/s1/players/Steve/op');

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('deop Steve');
    });
  });

  describe('POST /api/instances/:id/players/:player/kick', () => {
    it('should kick player', async () => {
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/kick')
        .set('Content-Type', 'application/json')
        .send({ reason: 'Bye' });

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('kick Steve Bye');
    });

    it('should use default kick reason', async () => {
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).post('/api/instances/s1/players/Steve/kick');

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('kick Steve Kicked by operator');
    });
  });

  describe('POST /api/instances/:id/players/:player/ban', () => {
    it('should permanently ban player (no duration)', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .set('Content-Type', 'application/json')
        .send({ reason: 'Cheating' });

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('ban Steve Cheating');
      // 永久封禁不写临时记录
      expect(BanModel.create).not.toHaveBeenCalled();
    });

    it('should temp ban player with duration (write record + expiresAt)', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const before = Date.now();
      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .set('Content-Type', 'application/json')
        .send({ reason: 'Cheating', duration: '1h' });

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('ban Steve Cheating');
      expect(BanModel.create).toHaveBeenCalledTimes(1);
      const record = BanModel.create.mock.calls[0][0];
      expect(record.instanceId).toBe('s1');
      expect(record.targetType).toBe('player');
      expect(record.target).toBe('Steve');
      expect(record.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    });

    it('should ban IP when ip provided', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .set('Content-Type', 'application/json')
        .send({ reason: 'Cheating', duration: '7d', ip: '1.2.3.4' });

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('ban-ip 1.2.3.4 Cheating');
      const record = BanModel.create.mock.calls[0][0];
      expect(record.targetType).toBe('ip');
      expect(record.target).toBe('1.2.3.4');
    });

    it('should reject invalid IP', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .set('Content-Type', 'application/json')
        .send({ reason: 'Cheating', ip: 'not-an-ip' });

      expect(res.status).toBe(400);
      expect(mockInstance.sendCommand).not.toHaveBeenCalled();
    });

    it('should treat unparsable duration as permanent ban', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .set('Content-Type', 'application/json')
        .send({ reason: 'Cheating', duration: '中文' });

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('ban Steve Cheating');
      expect(BanModel.create).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/instances/:id/players/:player/pardon', () => {
    it('should pardon player', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).post('/api/instances/s1/players/Steve/pardon');

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('pardon Steve');
      // 手动解封同步清理临时封禁记录
      expect(BanModel.deactivateByPlayer).toHaveBeenCalledWith('s1', 'Steve');
    });
  });

  describe('POST /api/instances/:id/players/bans/pardon', () => {
    it('should pardon IP and clean temp_bans ip record', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/bans/1.2.3.4/pardon')
        .send({ targetType: 'ip' });

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('pardon-ip 1.2.3.4');
      // 手动解封 IP 同步清理 IP 型临时封禁记录
      expect(BanModel.deactivateByIp).toHaveBeenCalledWith('s1', '1.2.3.4');
    });

    it('should pardon player via generic route', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/bans/Steve/pardon')
        .send({ targetType: 'player' });

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('pardon Steve');
      expect(BanModel.deactivateByPlayer).toHaveBeenCalledWith('s1', 'Steve');
    });

    it('should record PLAYER_PARDON audit for record-level pardon (player)', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/bans/Steve/pardon')
        .send({ targetType: 'player' });

      expect(res.status).toBe(200);
      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 's1',
          action: AuditActions.PLAYER_PARDON,
          targetType: 'player',
          targetId: 'Steve',
          detail: { entry: 'ban-record' },
        }),
      );
    });

    it('should record PLAYER_PARDON audit for record-level pardon (ip)', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/bans/1.2.3.4/pardon')
        .send({ targetType: 'ip' });

      expect(res.status).toBe(200);
      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 's1',
          action: AuditActions.PLAYER_PARDON,
          targetType: 'ip',
          targetId: '1.2.3.4',
          detail: { entry: 'ban-record' },
        }),
      );
    });

    it('should not record audit when pardon command fails', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon timeout')),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/bans/Steve/pardon')
        .send({ targetType: 'player' });

      expect(res.status).toBe(500);
      // 解封未生效（记录已补偿恢复），无审计——审计语义 = 实际效果
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('should reject invalid IP', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/bans/not-an-ip/pardon')
        .send({ targetType: 'ip' });

      expect(res.status).toBe(400);
      expect(BanModel.deactivateByIp).not.toHaveBeenCalled();
    });

    it('should reject invalid targetType', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app)
        .post('/api/instances/s1/players/bans/x/pardon')
        .send({ targetType: 'uuid' });

      expect(res.status).toBe(400);
      expect(mockInstance.sendCommand).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/instances/:id/players/:player/whitelist/add', () => {
    it('should add player to whitelist', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).post('/api/instances/s1/players/Steve/whitelist/add');

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('whitelist add Steve');
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 's1',
          action: AuditActions.PLAYER_WHITELIST,
          targetType: 'player',
          targetId: 'Steve',
          detail: { op: 'add' },
        }),
      );
    });
  });

  describe('DELETE /api/instances/:id/players/:player/whitelist', () => {
    it('should remove player from whitelist', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn(),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).delete('/api/instances/s1/players/Steve/whitelist');

      expect(res.status).toBe(200);
      expect(mockInstance.sendCommand).toHaveBeenCalledWith('whitelist remove Steve');
      // 白名单移除接入审计（与 add 同枚举，detail.op 区分方向）
      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          instanceId: 's1',
          action: AuditActions.PLAYER_WHITELIST,
          targetType: 'player',
          targetId: 'Steve',
          detail: { op: 'remove' },
        }),
      );
    });

    it('should not record audit when whitelist remove command fails', async () => {
      vi.clearAllMocks();
      const mockInstance = {
        isRunning: true,
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon timeout')),
      };
      mockManager.getInstance.mockReturnValue(asInstance(mockInstance));

      const res = await request(app).delete('/api/instances/s1/players/Steve/whitelist');

      expect(res.status).toBe(500);
      // 移除未生效，无审计
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });
});
