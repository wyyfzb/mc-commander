import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPlayerRoutes, parseDuration } from '../routes/players.js';
import { errorHandler } from '../middleware/error_handler.js';
import { logger } from '../utils/logger.js';
import express from 'express';
import request from 'supertest';

// mock BanModel：含 deactivate（ban 命令失败回滚分支断言用）
vi.mock('../db/index.js', () => ({
  BanModel: {
    findActiveByInstance: vi.fn(() => []),
    findAllByInstance: vi.fn(() => []),
    create: vi.fn(() => ({ id: 1 })),
    deactivate: vi.fn(),
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

describe('Player Routes 分支补测', () => {
  let app;
  let mockManager;
  let tmpServerPath;

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    mockManager = {
      instances: new Map(),
      getInstance: vi.fn(),
    };
    app.use('/api', createPlayerRoutes(mockManager));
    app.use(errorHandler); // 与生产一致的全局错误处理
    tmpServerPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-players-branches-'));
  });

  afterEach(() => {
    fs.rmSync(tmpServerPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // 标准实例 mock：列表/详情/命令端点共用的完整形态
  function makeInstance(overrides = {}) {
    return {
      isRunning: true,
      isRconConnected: false,
      serverPath: tmpServerPath,
      properties: { 'level-name': 'world' },
      players: new Map(),
      getAllKnownPlayers: () => new Map(),
      playerEvents: new Map(),
      _worldSpawn: null,
      _computePlayerStats: () => ({
        totalOnline: 0, loginCount: 0, offlineSince: 0,
        deathCount: 0, achievementCount: 0, sleepCount: 0,
      }),
      _mergePlayerEvents: (a, b) => [...(a || []), ...(b || [])],
      _loadInventoryFromDat: vi.fn(() => null),
      getPlayerDetails: vi.fn(),
      sendCommand: vi.fn(),
      ...overrides,
    };
  }

  function writePlayerData(playerName, content) {
    const dir = path.join(tmpServerPath, 'playerdata');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${playerName}.json`), content);
  }

  describe('parseDuration 单元（导出函数直测）', () => {
    it('支持全部单位 s/m/h/d/w/mo', () => {
      expect(parseDuration('30s')).toBe(30_000);
      expect(parseDuration('5m')).toBe(300_000);
      expect(parseDuration('2h')).toBe(3_600_000 * 2);
      expect(parseDuration('7d')).toBe(86_400_000 * 7);
      expect(parseDuration('3w')).toBe(604_800_000 * 3);
      expect(parseDuration('1mo')).toBe(2_592_000_000);
    });

    it('大小写与首尾空白归一化', () => {
      expect(parseDuration('  1H  ')).toBe(3_600_000);
      expect(parseDuration('10S')).toBe(10_000);
    });

    it('null/undefined 返回 null', () => {
      expect(parseDuration(null)).toBeNull();
      expect(parseDuration(undefined)).toBeNull();
    });

    it('非法输入返回 null（0 值/负数/未知单位/小数/纯数字/空串）', () => {
      expect(parseDuration('0d')).toBeNull();
      expect(parseDuration('-5m')).toBeNull();
      expect(parseDuration('abc')).toBeNull();
      expect(parseDuration('5x')).toBeNull();
      expect(parseDuration('1.5h')).toBeNull();
      expect(parseDuration(90)).toBeNull();
      expect(parseDuration('')).toBeNull();
    });
  });

  describe('实例守卫矩阵（404 + 未运行）', () => {
    // 全部带实例存在性检查的端点
    const guardedEndpoints = [
      ['GET', '/api/instances/s1/players', null],
      ['GET', '/api/instances/s1/players/bans', null],
      ['GET', '/api/instances/s1/players/Steve/details', null],
      ['POST', '/api/instances/s1/players/Steve/op', null],
      ['DELETE', '/api/instances/s1/players/Steve/op', null],
      ['POST', '/api/instances/s1/players/Steve/kick', null],
      ['POST', '/api/instances/s1/players/Steve/ban', { reason: 'x' }],
      ['POST', '/api/instances/s1/players/Steve/pardon', null],
      ['POST', '/api/instances/s1/players/bans/1.2.3.4/pardon', { targetType: 'player' }],
      ['POST', '/api/instances/s1/players/Steve/whitelist/add', null],
      ['DELETE', '/api/instances/s1/players/Steve/whitelist', null],
    ];
    // 仅命令端点要求实例运行中（GET 列表/详情只读端点不检查 isRunning）
    const commandEndpoints = guardedEndpoints.filter(([method]) => method !== 'GET');

    it.each(guardedEndpoints)('%s %s 实例不存在返回 404 INSTANCE_NOT_FOUND', async (method, url, body) => {
      mockManager.getInstance.mockReturnValue(undefined);

      const req = request(app)[method.toLowerCase()](url);
      const res = body ? await req.send(body) : await req;

      expect(res.status).toBe(404);
      expect(res.body.status).toBe('error');
      expect(res.body.code).toBe(40401);
    });

    it.each(commandEndpoints)('%s %s 实例未运行返回 400 INSTANCE_NOT_RUNNING 且不发命令', async (method, url, body) => {
      const instance = makeInstance({ isRunning: false });
      mockManager.getInstance.mockReturnValue(instance);

      const req = request(app)[method.toLowerCase()](url);
      const res = body ? await req.send(body) : await req;

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40002);
      expect(res.body.message).toBe('Instance is not running');
      expect(instance.sendCommand).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });

  describe('validatePlayerName 参数校验', () => {
    it('非法玩家名（含特殊字符）返回 400 VALIDATION_ERROR', async () => {
      mockManager.getInstance.mockReturnValue(makeInstance());

      const res = await request(app).get('/api/instances/s1/players/steve!@/details');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40000);
      expect(res.body.message).toContain('Invalid player name');
    });
  });

  describe('GET /players/:player/details', () => {
    it('RCON 成功：详情合并 baseInfo 返回（在线玩家）', async () => {
      const instance = makeInstance({
        isRconConnected: true,
        players: new Map([['Steve', { name: 'Steve', joinTime: Date.now() }]]),
        getPlayerDetails: vi.fn().mockResolvedValue({
          health: 20, maxHealth: 20, hunger: 19, xpLevel: 3, gameMode: 'survival',
        }),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players/Steve/details');

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Steve');
      expect(res.body.data.isOnline).toBe(true);
      expect(res.body.data.health).toBe(20);
      expect(res.body.data.maxHealth).toBe(20);
      expect(res.body.data.hunger).toBe(19);
      expect(res.body.data.xpLevel).toBe(3);
      expect(instance.getPlayerDetails).toHaveBeenCalledWith('Steve');
    });

    it('RCON 失败：回退持久化 playerdata + 合并内存事件（服务端重启后历史不丢）', async () => {
      writePlayerData('Fallback', JSON.stringify({
        sessions: [{ start: 1, end: 2, duration: 1 }],
        events: [{ type: 'achievement', at: 10 }],
        lastSeen: '2024-06-01T10:00:00Z',
      }));
      const instance = makeInstance({
        getPlayerDetails: vi.fn().mockRejectedValue(new Error('rcon timeout')),
        playerEvents: new Map([['Fallback', [{ type: 'join', at: 99 }]]]),
        _computePlayerStats: () => ({
          totalOnline: 0, loginCount: 42, offlineSince: 0,
          deathCount: 0, achievementCount: 0, sleepCount: 0,
        }),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players/Fallback/details');

      expect(res.status).toBe(200);
      // 回退路径：健康态字段置 null，持久化 + 内存事件合并，sessions 透传
      expect(res.body.data.health).toBeNull();
      expect(res.body.data.isOnline).toBe(false);
      expect(res.body.data.events).toEqual([
        { type: 'achievement', at: 10 },
        { type: 'join', at: 99 },
      ]);
      expect(res.body.data.sessions).toHaveLength(1);
      // stats 由合并后数据计算
      expect(res.body.data.stats.loginCount).toBe(42);
    });

    it('未知玩家：known 记录为空时稳定字段回退默认值', async () => {
      const instance = makeInstance({
        getPlayerDetails: vi.fn().mockRejectedValue(new Error('rcon timeout')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players/Ghost/details');

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Ghost');
      expect(res.body.data.uuid).toBe('');
      expect(res.body.data.isOnline).toBe(false);
      expect(res.body.data.totalPlayTime).toBe(0);
      expect(res.body.data.lastSeen).toBeNull();
      expect(res.body.data.events).toEqual([]);
      expect(res.body.data.sessions).toEqual([]);
    });

    it('实例不存在返回 404', async () => {
      mockManager.getInstance.mockReturnValue(undefined);

      const res = await request(app).get('/api/instances/s1/players/Steve/details');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
    });
  });

  describe('POST /players/:player/kick reason 分支', () => {
    it('express 5 无 JSON body（req.body undefined）使用默认 reason', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      // 不调用 .send()：无 Content-Type → express.json() 不解析 → req.body === undefined
      const res = await request(app).post('/api/instances/s1/players/Steve/kick');

      expect(res.status).toBe(200);
      expect(instance.sendCommand).toHaveBeenCalledWith('kick Steve Kicked by operator');
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: 's1',
        action: AuditActions.PLAYER_KICK,
        targetId: 'Steve',
        detail: { reason: 'Kicked by operator' },
      }));
    });

    it('空 reason 与显式默认值一致', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/kick')
        .send({ reason: '' });

      expect(res.status).toBe(200);
      expect(instance.sendCommand).toHaveBeenCalledWith('kick Steve Kicked by operator');
    });

    it('reason 注入字符（换行/分号/管道/与号）被清洗为空格', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      await request(app)
        .post('/api/instances/s1/players/Steve/kick')
        .send({ reason: 'a\nb\rc;d|e&f' });

      // 命令注入载体 \r\n;|& 全部替换为空格，防止 RCON 命令拼接逃逸
      expect(instance.sendCommand).toHaveBeenCalledWith('kick Steve a b c d e f');
    });

    it('超长 reason 截断至 200 字符', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      await request(app)
        .post('/api/instances/s1/players/Steve/kick')
        .send({ reason: 'x'.repeat(300) });

      const command = instance.sendCommand.mock.calls[0][0];
      expect(command).toBe(`kick Steve ${'x'.repeat(200)}`);
    });
  });

  describe('POST /players/:player/ban 请求体分支', () => {
    it('duration "0d" 解析为 0 → 视为永久封禁（不写临时记录）', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .send({ reason: 'Cheating', duration: '0d' });

      expect(res.status).toBe(200);
      expect(res.body.data.expiresAt).toBeNull();
      expect(instance.sendCommand).toHaveBeenCalledWith('ban Steve Cheating');
      expect(BanModel.create).not.toHaveBeenCalled();
    });

    it('duration "30s" 临时封禁到期时间精确透传', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      const before = Date.now();
      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .send({ reason: 'Cheating', duration: '30s' });

      expect(res.status).toBe(200);
      expect(res.body.data.expiresAt).toBeGreaterThanOrEqual(before + 30_000);
    });
  });

  describe('ban/pardon 命令失败的记录一致性', () => {
    it('临时封禁命令失败：回滚已写入的 temp_bans 记录（记录 ⇔ 封禁一致）', async () => {
      BanModel.create.mockReturnValue({ id: 42 });
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .send({ reason: 'Cheating', duration: '1h' });

      expect(res.status).toBe(500);
      expect(BanModel.create).toHaveBeenCalledTimes(1);
      // 命令失败 → 回滚临时记录，避免残留「已封禁」记录误导前端到期轮询
      expect(BanModel.deactivate).toHaveBeenCalledWith(42);
      // 解封语义：操作未生效无审计
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('回滚失败：记录原始错误并继续抛出（不吞错不换错）', async () => {
      BanModel.create.mockReturnValue({ id: 42 });
      BanModel.deactivate.mockImplementation(() => {
        throw new Error('db busy');
      });
      const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .send({ reason: 'Cheating', duration: '1h' });

      expect(res.status).toBe(500);
      expect(loggerError).toHaveBeenCalled();
      // 原始错误向上传播（errorHandler 收到的是 rcon down 而非 db busy）
      expect(res.body.code).toBe(50000);
    });

    it('永久封禁命令失败：无临时记录可回滚（tempBan null 短路）', async () => {
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/ban')
        .send({ reason: 'Cheating' });

      expect(res.status).toBe(500);
      expect(BanModel.deactivate).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('pardon 命令失败：先清记录再执行命令，失败后按备份恢复记录', async () => {
      BanModel.findActiveByInstance.mockReturnValue([
        { instanceId: 's1', targetType: 'player', target: 'Steve', reason: 'griefing', expiresAt: 123_456 },
      ]);
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon timeout')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/pardon');

      expect(res.status).toBe(500);
      // 顺序不变量：先清理记录（失败则命令不执行，无中间态）
      const clearOrder = BanModel.deactivateByPlayer.mock.invocationCallOrder[0];
      const commandOrder = instance.sendCommand.mock.invocationCallOrder[0];
      expect(clearOrder).toBeLessThan(commandOrder);
      // 命令失败 → 用 create 恢复已清理的记录（临时封禁不退化为永久）
      expect(BanModel.create).toHaveBeenCalledWith({
        instanceId: 's1',
        targetType: 'player',
        target: 'Steve',
        reason: 'griefing',
        expiresAt: 123_456,
      });
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('pardon 恢复失败：记录日志并继续抛出原始错误', async () => {
      BanModel.findActiveByInstance.mockReturnValue([
        { instanceId: 's1', targetType: 'player', target: 'Steve', reason: 'griefing', expiresAt: 1 },
      ]);
      BanModel.create.mockImplementation(() => {
        throw new Error('disk full');
      });
      const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon timeout')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/players/Steve/pardon');

      expect(res.status).toBe(500);
      expect(loggerError).toHaveBeenCalled();
      expect(res.body.code).toBe(50000);
    });

    it('通用 pardon：恢复失败同样日志留痕并抛原始错误', async () => {
      BanModel.findActiveByInstance.mockReturnValue([
        { instanceId: 's1', targetType: 'ip', target: '1.2.3.4', reason: 'spam', expiresAt: 5 },
      ]);
      BanModel.create.mockImplementation(() => {
        throw new Error('disk full');
      });
      const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon timeout')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/players/bans/1.2.3.4/pardon')
        .send({ targetType: 'ip' });

      expect(res.status).toBe(500);
      expect(BanModel.deactivateByIp).toHaveBeenCalledWith('s1', '1.2.3.4');
      expect(loggerError).toHaveBeenCalled();
      expect(res.body.code).toBe(50000);
    });

    it('通用 pardon 无 body（targetType undefined）返回 400 且不触碰记录', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      // 不调用 .send()：req.body undefined → targetType 走 undefined 分支
      const res = await request(app)
        .post('/api/instances/s1/players/bans/Steve/pardon');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(40000);
      expect(res.body.message).toBe('targetType 仅支持 player/ip');
      expect(instance.sendCommand).not.toHaveBeenCalled();
      expect(BanModel.deactivateByPlayer).not.toHaveBeenCalled();
      expect(BanModel.deactivateByIp).not.toHaveBeenCalled();
    });
  });

  describe('op / whitelist 命令失败传播', () => {
    it('op 命令失败返回 500 且无审计', async () => {
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).post('/api/instances/s1/players/Steve/op');

      expect(res.status).toBe(500);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('deop 命令失败返回 500 且无审计', async () => {
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).delete('/api/instances/s1/players/Steve/op');

      expect(res.status).toBe(500);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('op 幂等重放：重复 op 两次均成功且审计逐次记录', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      const res1 = await request(app).post('/api/instances/s1/players/Steve/op');
      const res2 = await request(app).post('/api/instances/s1/players/Steve/op');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(instance.sendCommand).toHaveBeenCalledTimes(2);
      expect(recordAudit).toHaveBeenCalledTimes(2);
    });

    it('whitelist add 命令失败返回 500 且无审计', async () => {
      const instance = makeInstance({
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).post('/api/instances/s1/players/Steve/whitelist/add');

      expect(res.status).toBe(500);
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });

  describe('GET /players 列表分支补充', () => {
    it('RCON 可用：在线玩家并行拉取详情合并，单玩家失败不影响他人', async () => {
      const instance = makeInstance({
        isRconConnected: true,
        players: new Map([
          ['Alex', { name: 'Alex', joinTime: Date.now(), sessions: [] }],
          ['Bob', { name: 'Bob', joinTime: Date.now(), sessions: [] }],
        ]),
        getPlayerDetails: vi.fn((name) => name === 'Alex'
          ? Promise.resolve({ health: 20, maxHealth: 20, hunger: 18 })
          : Promise.reject(new Error('rcon err'))),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.data.map((p) => [p.name, p]));
      expect(byName.Alex.health).toBe(20);
      expect(byName.Alex.hunger).toBe(18);
      // Bob 详情拉取失败 → catch 归 null → 保持列表默认 health null
      expect(byName.Bob.health).toBeNull();
    });

    it('getPlayerDetails 同步抛错：外层兜底 warn 日志且列表照常返回', async () => {
      const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const instance = makeInstance({
        isRconConnected: true,
        players: new Map([['Steve', { name: 'Steve', joinTime: Date.now(), sessions: [] }]]),
        // 同步 throw：Promise 链的 .catch 无法捕获，走外层 try/catch
        getPlayerDetails: vi.fn(() => {
          throw new Error('sync boom');
        }),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      expect(loggerWarn).toHaveBeenCalled();
      expect(res.body.data).toHaveLength(1);
    });

    it('RCON 不可用：在线玩家物品栏回退读 .dat 快照，单个损坏不影响他人', async () => {
      const instance = makeInstance({
        isRunning: false, // 未运行 → RCON 不可用路径
        players: new Map([
          ['Steve', { name: 'Steve', joinTime: Date.now() }], // 无 sessions → 非数组分支
          ['Bob', { name: 'Bob', joinTime: Date.now() }],
        ]),
        _loadInventoryFromDat: vi.fn((_uuid, name) => {
          if (name === 'Steve') {
            return {
              quickbar: [{ id: 'minecraft:diamond_sword', count: 1, slot: 0, durability: null, enchanted: false, customName: null }],
              main: [],
              equipment: { helmet: null, chestplate: null, leggings: null, boots: null, offhand: null },
              enderChest: [],
              source: 'snapshot',
              partial: false,
            };
          }
          throw new Error('dat corrupt');
        }),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.data.map((p) => [p.name, p]));
      expect(byName.Steve.inventory.quickbar[0]).toMatchObject({ id: 'minecraft:diamond_sword' });
      expect(byName.Steve.inventory.source).toBe('snapshot');
      // Bob 快照读取失败 → 契约缺省态（显式 null，schema required 面完整）
      expect(byName.Bob.inventory).toBeNull();
      // sessions 缺失 → 空数组兜底（前端展开不崩）
      expect(byName.Steve.sessions).toEqual([]);
    });

    it('离线玩家：持久化数据完整呈现（时长覆盖/IP 封禁/物品栏/世界出生点）', async () => {
      writePlayerData('OfflineP', JSON.stringify({
        totalPlayTime: 7200,
        gameMode: 'survival',
        dimension: 'overworld',
        position: { x: 1, y: 64, z: 2 },
        ip: '5.6.7.8',
        lastSeen: '2024-06-02T12:30:00Z',
        health: 18.5,
        maxHealth: 20,
        hunger: 17,
        xpLevel: 12,
        sessions: [{ start: 1, end: 2, duration: 1 }],
        events: [{ type: 'quit', message: '离开服务器', timestamp: 1717331400000 }],
      }));
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-ips.json'),
        JSON.stringify([{ ip: '5.6.7.8', created: '2024-06-02T00:00:00Z' }]),
      );
      const instance = makeInstance({
        _worldSpawn: { x: 8, y: 70, z: -3 }, // truthy → 统一出生点拷贝
        getAllKnownPlayers: () => new Map([
          ['OfflineP', { uuid: 'uuid-off', isOp: true, isWhitelisted: true, lastSeen: '2024-06-01T10:00:00Z' }],
        ]),
        _loadInventoryFromDat: vi.fn(() => ({
          quickbar: [{ id: 'minecraft:bread', count: 1, slot: 0, durability: null, enchanted: false, customName: null }],
          main: [],
          equipment: { helmet: null, chestplate: null, leggings: null, boots: null, offhand: null },
          enderChest: [],
          source: 'snapshot',
          partial: false,
        })),
      });
      mockManager.getInstance.mockReturnValue(instance);
      BanModel.findActiveByInstance.mockReturnValue([
        { targetType: 'ip', target: '5.6.7.8', expiresAt: 9_999_999_999_999 },
      ]);

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      const offline = res.body.data.find((p) => p.name === 'OfflineP');
      expect(offline.isOnline).toBe(false);
      expect(offline.uuid).toBe('uuid-off');
      expect(offline.gameMode).toBe('survival');
      expect(offline.totalPlayTime).toBe(7200); // 自追踪时长覆盖 stats 推导值
      expect(offline.isIpBanned).toBe(true); // 持久化历史 IP 命中原版封禁
      expect(offline.ipBanExpiresAt).toBe(9_999_999_999_999); // 临时 IP 封禁到期时间
      expect(offline.lastSeen).toBe('2024-06-02T12:30:00.000Z'); // ISO 规范化（毫秒位补齐）
      expect(offline.health).toBe(18.5);
      expect(offline.inventory.quickbar[0]).toMatchObject({ id: 'minecraft:bread' });
      expect(offline.spawnPoint).toEqual({ x: 8, y: 70, z: -3 });
    });

    it('损坏 playerdata JSON：离线玩家安全回退默认值不崩溃', async () => {
      writePlayerData('Corrupt', '{not valid json');
      const instance = makeInstance({
        getAllKnownPlayers: () => new Map([
          ['Corrupt', { isOp: false }], // 无 uuid → offline uuid 兜底分支
        ]),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      const corrupt = res.body.data.find((p) => p.name === 'Corrupt');
      expect(corrupt.gameMode).toBeNull();
      expect(corrupt.totalPlayTime).toBe(0);
      expect(corrupt.isIpBanned).toBe(false);
      expect(corrupt.ipBanExpiresAt).toBeNull();
      expect(corrupt.lastSeen).toBeNull();
      expect(corrupt.uuid).toBe('');
    });

    it('损坏 banned-ips.json：列表端点静默容错照常返回', async () => {
      fs.writeFileSync(path.join(tmpServerPath, 'banned-ips.json'), '{broken');
      const instance = makeInstance({
        players: new Map([['Steve', { name: 'Steve', joinTime: Date.now(), sessions: [] }]]),
      });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players');

      expect(res.status).toBe(200);
      expect(res.body.data[0].isIpBanned).toBe(false);
    });
  });

  describe('GET /players/bans 排序与容错分支', () => {
    it('生效临时封禁按到期升序在前 → 原版永久 → 历史按创建时间倒序', async () => {
      BanModel.findAllByInstance.mockReturnValue([
        { targetType: 'player', target: 'HistoryOld', reason: 'r1', isActive: false, expiresAt: 100, createdAt: '2024-01-01T00:00:00Z' },
        { targetType: 'player', target: 'HistoryNew', reason: 'r2', isActive: false, expiresAt: 200, createdAt: '2024-06-01T00:00:00Z' },
        { targetType: 'player', target: 'TempLate', reason: 'r3', isActive: true, expiresAt: 5000, createdAt: '2024-02-01T00:00:00Z' },
        { targetType: 'player', target: 'TempEarly', reason: 'r4', isActive: true, expiresAt: 1000, createdAt: '2024-03-01T00:00:00Z' },
        { targetType: 'player', target: 'TempNull', reason: 'r5', isActive: true, expiresAt: null, createdAt: '2024-04-01T00:00:00Z' },
      ]);
      // 生效中集合（跳过原版文件重复项的 key 来源）
      BanModel.findActiveByInstance.mockReturnValue([
        { targetType: 'player', target: 'TempEarly', expiresAt: 1000 },
        { targetType: 'player', target: 'TempLate', expiresAt: 5000 },
        { targetType: 'player', target: 'TempNull', expiresAt: null },
      ]);
      // 原版永久封禁：无 created 字段（createdAt 兜底 null 分支）+ 无 reason 字段
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-players.json'),
        JSON.stringify([{ name: 'PermNoMeta' }]),
      );
      // 空条目：entry.ip 缺失 → target 兜底空串分支
      fs.writeFileSync(
        path.join(tmpServerPath, 'banned-ips.json'),
        JSON.stringify([{}]),
      );
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.status).toBe(200);
      // 排序不变量：生效临时（到期升序，null 排最前）→ 生效永久 → 历史（创建倒序）
      expect(res.body.data.map((b) => b.target)).toEqual([
        'TempNull', 'TempEarly', 'TempLate',
        'PermNoMeta', '',
        'HistoryNew', 'HistoryOld',
      ]);
      const perm = res.body.data.find((b) => b.target === 'PermNoMeta');
      expect(perm.isPermanent).toBe(true);
      expect(perm.reason).toBe('');
      expect(perm.createdAt).toBeNull();
    });

    it('损坏原版封禁文件：静默容错仅返回 temp_bans 记录', async () => {
      fs.writeFileSync(path.join(tmpServerPath, 'banned-players.json'), 'not json');
      fs.writeFileSync(path.join(tmpServerPath, 'banned-ips.json'), 'also broken');
      BanModel.findAllByInstance.mockReturnValue([
        { targetType: 'player', target: 'TempOnly', reason: 'r', isActive: true, expiresAt: 1, createdAt: '2024-01-01T00:00:00Z' },
      ]);
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).get('/api/instances/s1/players/bans');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].target).toBe('TempOnly');
      expect(res.body.data[0].isPermanent).toBe(false);
    });
  });
});
