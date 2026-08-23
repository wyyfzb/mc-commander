import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPlayerRoutes } from '../routes/players.js';
import { errorHandler } from '../middleware/error_handler.js';
import express from 'express';
import request from 'supertest';

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

describe('安全修复：find-008-read（players.js _getTotalPlayTime 路径校验）', () => {
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
    app.use(errorHandler);
    tmpServerPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-008-route-'));
  });

  afterEach(() => {
    fs.rmSync(tmpServerPath, { recursive: true, force: true });
  });

  function baseMockInstance(overrides = {}) {
    return {
      serverPath: tmpServerPath,
      properties: {},
      players: new Map(),
      getAllKnownPlayers: () => new Map(),
      playerEvents: new Map(),
      _worldSpawn: null,
      _computePlayerStats: () => ({
        totalOnline: 0, loginCount: 1, offlineSince: 0,
        deathCount: 0, achievementCount: 0, sleepCount: 0,
      }),
      _mergePlayerEvents: (a, b) => [...(a || []), ...(b || [])],
      _loadInventoryFromDat: () => null,
      ...overrides,
    };
  }

  it('非法 worldName（../../）回退 world 路径读取统计文件', async () => {
    // 在 tmpServerPath/world/players/stats/ 放置官方统计文件（MC 26.1+ 新世界格式）
    const statsDir = path.join(tmpServerPath, 'world', 'players', 'stats');
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(path.join(statsDir, 'u1.json'), JSON.stringify({
      stats: { 'minecraft:custom': { 'minecraft:play_time': 400 } },
    }));
    // 离线玩家 Steve 已知 uuid=u1；level-name 被配置为恶意穿越值
    const mockInstance = baseMockInstance({
      properties: { 'level-name': '../../evil' },
      getAllKnownPlayers: () => new Map([
        ['Steve', { name: 'Steve', uuid: 'u1', lastSeen: null }],
      ]),
    });
    mockManager.getInstance.mockReturnValue(mockInstance);

    const res = await request(app).get('/api/instances/s1/players');

    expect(res.status).toBe(200);
    const steve = res.body.data.find((p) => p.name === 'Steve');
    // 回退 world 后读到 400 tick / 20 = 20 秒；未修复时越界路径不存在返回 0
    expect(steve.totalPlayTime).toBe(20);
  });

  it('worldName 含路径分隔符时候选路径不越界（resolve 过滤丢弃越界候选）', async () => {
    // 在 tmpServerPath 上级放置"越界"统计文件，模拟恶意读取目标
    const evilStatsPath = path.join(tmpServerPath, '..', `${path.basename(tmpServerPath)}.evil.json`);
    fs.writeFileSync(evilStatsPath, JSON.stringify({
      stats: { 'minecraft:custom': { 'minecraft:play_time': 999999 } },
    }));
    const mockInstance = baseMockInstance({
      properties: { 'level-name': '..' }, // 候选 resolve 后指向 tmpServerPath 上级
      getAllKnownPlayers: () => new Map([
        ['Steve', { name: 'Steve', uuid: 'u1', lastSeen: null }],
      ]),
    });
    mockManager.getInstance.mockReturnValue(mockInstance);

    const res = await request(app).get('/api/instances/s1/players');

    expect(res.status).toBe(200);
    const steve = res.body.data.find((p) => p.name === 'Steve');
    // 越界候选被过滤（world 目录不存在 → 0），绝不可读到上级文件
    expect(steve.totalPlayTime).toBe(0);
    fs.rmSync(evilStatsPath, { force: true });
  });

  it('合法 level-name 正常读取（校验不误伤自定义世界目录）', async () => {
    const statsDir = path.join(tmpServerPath, 'my_world', 'players', 'stats');
    fs.mkdirSync(statsDir, { recursive: true });
    fs.writeFileSync(path.join(statsDir, 'u1.json'), JSON.stringify({
      stats: { 'minecraft:custom': { 'minecraft:play_time': 800 } },
    }));
    const mockInstance = baseMockInstance({
      properties: { 'level-name': 'my_world' },
      getAllKnownPlayers: () => new Map([
        ['Steve', { name: 'Steve', uuid: 'u1', lastSeen: null }],
      ]),
    });
    mockManager.getInstance.mockReturnValue(mockInstance);

    const res = await request(app).get('/api/instances/s1/players');

    expect(res.status).toBe(200);
    const steve = res.body.data.find((p) => p.name === 'Steve');
    expect(steve.totalPlayTime).toBe(40); // 800 tick / 20 = 40 秒
  });
});
