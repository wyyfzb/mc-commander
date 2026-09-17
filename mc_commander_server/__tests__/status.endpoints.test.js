import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// /proc/stat 受控内容与 fs 真实实现引用（vi.hoisted 保证 mock 工厂提升后可用）
const __state = vi.hoisted(() => ({ procStatContent: null, actualFs: null }));

// ── Mock 隔离：SQLite 模型（InstanceModel + DELETE 依赖的 BackupModel）──
vi.mock('../db/index.js', () => ({
  InstanceModel: {
    update: vi.fn(),
    delete: vi.fn(),
  },
  BackupModel: {
    deleteByInstance: vi.fn(),
    resetStaleInProgress: vi.fn(),
    findAll: vi.fn(),
  },
}));

// recordAudit 捕获审计断言；AuditActions 保留真实枚举值
vi.mock('../utils/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAudit: vi.fn() };
});

// 备份快照清点替身：路由级用例只关心「清单空/非空」两态与回报内容；真实磁盘
// 行为（实例目录真删、备份目录与内容真留）由 instance-delete.safety.test.js
// 在系统临时目录里取证，避免用例读到工作区的真实 backups/servers
vi.mock('../services/backup-snapshot.service.js', () => ({
  listInstanceSnapshotDirs: vi.fn(() => []),
}));

// os：接管 5 个采样函数（spread actual 保留其余导出）
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      totalmem: vi.fn(),
      freemem: vi.fn(),
      cpus: vi.fn(),
      loadavg: vi.fn(),
      uptime: vi.fn(),
    },
  };
});

// fs：接管磁盘采样/文件存在与写入/删除相关函数（spread actual 保留其余导出）；
// readFileSync 仅 /proc/stat 路径受控（CPU 差分采样），其余转发真实实现
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  __state.actualFs = actual.default;
  return {
    ...actual,
    default: {
      ...actual.default,
      statfsSync: vi.fn(),
      existsSync: vi.fn(),
      rmSync: vi.fn(),
      writeFileSync: vi.fn(),
      // 原子写（utils/fs-utils.js atomicWriteFile）由 writeFileSync(临时文件) +
      // renameSync(目标) 两步组成，两半都接管才能完整观测写入动作
      renameSync: vi.fn(),
      statSync: vi.fn(),
      readFileSync: vi.fn(),
    },
  };
});

import { createStatusRoutes } from '../routes/status.js';
import { InstanceModel, BackupModel } from '../db/index.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { listInstanceSnapshotDirs } from '../services/backup-snapshot.service.js';
import { errorHandler } from '../middleware/error_handler.js';
import config from '../config.js';

const GB = 1024 * 1024 * 1024;
const INSTANCE_PATH = '/tmp/mc-test-s1';
const EULA_PATH = path.join(INSTANCE_PATH, 'eula.txt');

// statfsSync 采样样例：bsize 4096 × blocks 2621440 = 10GB，bfree 决定使用率
function statfsSample(bfree) {
  return { bsize: 4096, blocks: 2621440, bfree };
}

// world 端点共用实例 mock（properties 值均为 properties 文件文本字符串）
function makeWorldInstance(overrides = {}) {
  return {
    id: 's1',
    properties: {
      'level-name': 'survival-world',
      'level-type': 'minecraft:normal',
      difficulty: 'peaceful',
      'view-distance': '12',
      'simulation-distance': '8',
      'max-players': '30',
      'spawn-protection': '10',
      'max-world-size': '29999984',
      'allow-flight': 'false',
      hardcore: 'false',
      pvp: 'true',
      'white-list': 'false',
    },
    isRunning: true,
    isRconConnected: true,
    sendCommandWithResponse: vi.fn().mockResolvedValue('The game time is 24000 tick(s)'),
    readDifficulty: vi.fn().mockResolvedValue('hard'),
    _readSeedFromLevelDat: vi.fn().mockReturnValue('1234567890abcdef'),
    _getWorldSize: vi.fn().mockReturnValue(1.5),
    _readGameTypeFromLevelDat: vi.fn().mockReturnValue(null),
    _getLastSaveTime: vi.fn().mockReturnValue(null),
    players: new Map(),
    ...overrides,
  };
}

describe('Status Routes · 端点缺口收口', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    // resetAllMocks：清实现（防降级用例的 throw 实现泄漏到后续用例），随后统一重设
    vi.resetAllMocks();
    __state.procStatContent = null;
    if (!__state.actualFs) throw new Error('fs actual not captured');

    os.totalmem.mockReturnValue(8 * GB);
    os.freemem.mockReturnValue(2 * GB);
    os.cpus.mockReturnValue([{}, {}, {}, {}]);
    os.loadavg.mockReturnValue([2.0, 1.0, 0.5]);
    os.uptime.mockReturnValue(7200);

    // fs mock 实现逐用例重置（clearAllMocks 不清实现，防用例间泄漏）
    fs.existsSync.mockImplementation(() => false);
    fs.rmSync.mockImplementation(() => {});
    fs.writeFileSync.mockImplementation(() => {});
    fs.statSync.mockImplementation((p, ...rest) => __state.actualFs.statSync(p, ...rest));
    fs.readFileSync.mockImplementation((p, ...rest) => {
      if (p === '/proc/stat' && __state.procStatContent !== null) {
        return __state.procStatContent;
      }
      return __state.actualFs.readFileSync(p, ...rest);
    });
    fs.statfsSync.mockImplementation((dir) => {
      if (dir === config.serversDir) return statfsSample(1048576); // 60%
      if (dir === config.dataDir) return statfsSample(524288); // 80%
      if (dir === config.backupsDir) return statfsSample(2359296); // 10%
      throw new Error('unexpected statfs path');
    });

    // BackupModel.findAll 默认空集（无进行中备份）——DELETE 互斥检查放行；
    // 备份互斥用例按需覆盖为分状态计数
    BackupModel.findAll.mockReturnValue({ backups: [], total: 0 });
    // 备份清单默认空（resetAllMocks 会清实现，逐用例重设）
    listInstanceSnapshotDirs.mockReturnValue([]);

    app = express();
    app.use(express.json());
    mockManager = {
      instances: new Map(),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    };
    app.use('/api', createStatusRoutes(mockManager));
    app.use(errorHandler); // 与生产一致：路由内部错误经全局 errorHandler 统一处理
  });

  // ── GET /system-stats：云服务器系统级资源占用（独立轮询端点）──
  describe('GET /api/system-stats', () => {
    // 本 describe 覆盖 Linux /proc/stat 语义（其他平台回退 loadavg 估算）。
    // 固定 platform 使任意宿主都能覆盖目标分支；CI 在 Linux 上真跑同一路径。
    let origPlatform;
    beforeEach(() => {
      origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    });
    afterEach(() => {
      Object.defineProperty(process, 'platform', origPlatform);
    });

    it('成功：八字段精确断言（CPU 冷采样为 0 + 内存换算 + 磁盘三目录聚合降序）', async () => {
      __state.procStatContent = 'cpu  100 0 100 500 0 0 0 0 0 0';
      const res = await request(app).get('/api/system-stats');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.data).toEqual({
        cpuUsage: 0, // 首次采样无基准，返回 0
        memoryUsage: 6,
        totalMemory: 8,
        memoryPercent: 75,
        cpuCores: 4,
        loadAvg: [2.0, 1.0, 0.5],
        uptime: 7200,
        diskUsage: {
          // primary = 使用率最高者；all.sort 原地降序排列
          primary: { mountpoint: config.dataDir, totalGB: 10, usedGB: 8, percent: 80 },
          all: [
            { mountpoint: config.dataDir, totalGB: 10, usedGB: 8, percent: 80 },
            { mountpoint: config.serversDir, totalGB: 10, usedGB: 6, percent: 60 },
            { mountpoint: config.backupsDir, totalGB: 10, usedGB: 1, percent: 10 },
          ],
        },
      });
    });

    it('CPU 差分采样：两次请求间 /proc/stat 读数递增 → 按差分计算使用率', async () => {
      __state.procStatContent = 'cpu  100 0 100 500 0 0 0 0 0 0';
      await request(app).get('/api/system-stats'); // 建立采样基准
      __state.procStatContent = 'cpu  200 0 100 500 0 0 0 0 0 0';
      const res = await request(app).get('/api/system-stats');

      // totalDiff=100（user +100）、idleDiff=0 → usage=(100-0)/100*100=100
      expect(res.status).toBe(200);
      expect(res.body.data.cpuUsage).toBe(100);
    });

    it('/proc/stat 无 cpu 行 → 回退 loadavg/核心数近似估算', async () => {
      __state.procStatContent = 'intr 123456 0 0';
      const res = await request(app).get('/api/system-stats');

      // cores=4、loadavg[0]=2.0 → min(100, round((2.0/4)*100*10)/10)=50
      expect(res.status).toBe(200);
      expect(res.body.data.cpuUsage).toBe(50);
    });

    it('CPU 采样异常兜底：/proc/stat 读取抛错 → 返回 0 不中断响应', async () => {
      fs.readFileSync.mockImplementation((p) => {
        if (p === '/proc/stat') throw new Error('procfs unavailable');
        return __state.actualFs.readFileSync(p);
      });

      const res = await request(app).get('/api/system-stats');

      expect(res.status).toBe(200);
      expect(res.body.data.cpuUsage).toBe(0);
    });

    it('磁盘 10s 缓存窗口：第二次请求命中缓存，不再触发 statfsSync', async () => {
      await request(app).get('/api/system-stats');
      const callsAfterFirst = fs.statfsSync.mock.calls.length;

      const res = await request(app).get('/api/system-stats');
      expect(fs.statfsSync.mock.calls.length).toBe(callsAfterFirst);
      expect(res.body.data.diskUsage.primary.percent).toBe(80);
    });

    it('缓存过期 + statfsSync 全部异常 → diskUsage 降级 {primary:null, all:[]}', async () => {
      await request(app).get('/api/system-stats'); // 填充缓存

      // 前推 11s 打破 10s 缓存窗口，避免改模块内部状态
      const realNow = Date.now();
      const spy = vi.spyOn(Date, 'now').mockReturnValue(realNow + 11000);
      try {
        fs.statfsSync.mockImplementation(() => {
          throw new Error('statfs unavailable');
        });
        const res = await request(app).get('/api/system-stats');
        expect(res.status).toBe(200);
        expect(res.body.data.diskUsage).toEqual({ primary: null, all: [] });
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ── POST /instances/:id/stop：实例停止（整段缺口）──
  describe('POST /api/instances/:id/stop', () => {
    it('成功：stop 调用 + DB 状态同步 stopped + INSTANCE_STOP 审计', async () => {
      const instance = { id: 's1', stop: vi.fn() };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).post('/api/instances/s1/stop');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect(res.body.message).toBe('Server stopping');
      expect(instance.stop).toHaveBeenCalledTimes(1);
      expect(InstanceModel.update).toHaveBeenCalledWith('s1', { status: 'stopped' });
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 's1', action: AuditActions.INSTANCE_STOP }),
      );
    });

    it('404：实例不存在', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app).post('/api/instances/s1/stop');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
      expect(InstanceModel.update).not.toHaveBeenCalled();
    });

    it('DB 状态同步失败降级：update 抛错仅警告，停止流程不受阻', async () => {
      const instance = { id: 's1', stop: vi.fn() };
      mockManager.getInstance.mockReturnValue(instance);
      InstanceModel.update.mockImplementation(() => {
        throw new Error('db down');
      });

      const res = await request(app).post('/api/instances/s1/stop');

      expect(res.status).toBe(200);
      expect(instance.stop).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalled();
    });
  });

  // ── POST /instances/:id/start 分支补口 ──
  describe('POST /api/instances/:id/start（分支补口）', () => {
    it('404：实例不存在', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app).post('/api/instances/s1/start');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
    });

    it('EULA 未接受：eula.txt 不存在 → 403 EULA_NOT_ACCEPTED，不调用 start', async () => {
      const instance = { id: 's1', start: vi.fn(), serverPath: INSTANCE_PATH };
      mockManager.getInstance.mockReturnValue(instance);
      // existsSync 默认 false → eula.txt 不存在

      const res = await request(app).post('/api/instances/s1/start');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(40000);
      expect(res.body.message).toBe('EULA_NOT_ACCEPTED');
      expect(instance.start).not.toHaveBeenCalled();
    });

    it('DB 状态同步失败降级：EULA 已同意、update 抛错 → 仍 200 启动', async () => {
      const instance = { id: 's1', start: vi.fn(), serverPath: INSTANCE_PATH };
      mockManager.getInstance.mockReturnValue(instance);
      fs.existsSync.mockImplementation((p) => p === EULA_PATH);
      fs.readFileSync.mockImplementation((p) =>
        p === EULA_PATH ? 'eula=true\n' : __state.actualFs.readFileSync(p),
      );
      InstanceModel.update.mockImplementation(() => {
        throw new Error('db down');
      });

      const res = await request(app).post('/api/instances/s1/start');

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Server starting');
      expect(instance.start).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 's1', action: AuditActions.INSTANCE_START }),
      );
    });
  });

  // ── POST /instances/:id/restart：实例重启（整段缺口）──
  describe('POST /api/instances/:id/restart', () => {
    it('成功：restart 调用 + INSTANCE_RESTART 审计 + Server restarting', async () => {
      const instance = { id: 's1', restart: vi.fn() };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).post('/api/instances/s1/restart');

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
      expect(res.body.message).toBe('Server restarting');
      expect(instance.restart).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 's1', action: AuditActions.INSTANCE_RESTART }),
      );
    });

    it('404：实例不存在', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app).post('/api/instances/s1/restart');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
      expect(recordAudit).not.toHaveBeenCalled();
    });
  });

  // ── POST /instances/:id/command 分支补口 ──
  describe('POST /api/instances/:id/command（分支补口）', () => {
    it('404：实例不存在（命令非空校验通过后）', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app)
        .post('/api/instances/s1/command')
        .send({ command: 'list' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
    });

    it('RCON 断开降级：sendCommand 抛错且 isRconConnected=false → 503 专用错误码', async () => {
      const instance = {
        id: 's1',
        isRunning: true,
        isRconConnected: false,
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon timeout')),
      };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/command')
        .send({ command: 'say hi' });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe(50302);
    });

    it('RCON 连接正常时 sendCommand 抛错 → 重新抛出经全局 errorHandler 500', async () => {
      const instance = {
        id: 's1',
        isRunning: true,
        isRconConnected: true,
        sendCommand: vi.fn().mockRejectedValue(new Error('boom')),
      };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/command')
        .send({ command: 'say hi' });

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Internal Server Error');
    });
  });

  // ── 404 边界统一收口 ──
  describe('GET 端点 404 边界', () => {
    it('GET /instances/:id/logs：实例不存在 → 404', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app).get('/api/instances/s1/logs');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
    });

    it('GET /instances/:id/properties：实例不存在 → 404', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app).get('/api/instances/s1/properties');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
    });
  });

  // ── PUT /instances/:id/properties 分支补口 ──
  describe('PUT /api/instances/:id/properties（分支补口）', () => {
    it('404：实例不存在', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app)
        .put('/api/instances/s1/properties')
        .send({ motd: 'hello' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
    });

    it('saveProperties 非函数 → 500 版本过旧提示（不触发写入）', async () => {
      mockManager.getInstance.mockReturnValue({ id: 's1', properties: {} });
      const res = await request(app)
        .put('/api/instances/s1/properties')
        .send({ motd: 'hello' });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe(50000);
      expect(res.body.message).toContain('服务端版本过旧');
    });

    it('非标量值 400：object 值视为校验失败整体拒绝，不落盘部分修改', async () => {
      const instance = {
        id: 's1',
        properties: {},
        isRunning: false,
        saveProperties: vi.fn(),
        _loadProperties: vi.fn().mockReturnValue(null),
      };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .put('/api/instances/s1/properties')
        .send({ motd: { evil: true } });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('motd');
      expect(instance.saveProperties).not.toHaveBeenCalled();
    });

    it('_loadProperties 刷新缓存基线：磁盘最新值并入 instance.properties 后再 diff', async () => {
      const instance = {
        id: 's1',
        properties: { motd: 'old' },
        isRunning: false,
        saveProperties: vi.fn(),
        _loadProperties: vi.fn().mockReturnValue({ 'level-name': 'fresh-world' }),
      };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .put('/api/instances/s1/properties')
        .send({ motd: 'new' });

      expect(res.status).toBe(200);
      // 磁盘最新值并入缓存基线（游戏内命令写回不被陈旧缓存掩盖）
      expect(instance.properties['level-name']).toBe('fresh-world');
      expect(instance.saveProperties).toHaveBeenCalledWith({ motd: 'new' });
    });

    it('运行中四 runtime 属性依序下发：white-list/enforce-whitelist/difficulty/gamemode 命令构造', async () => {
      const instance = {
        id: 's1',
        properties: { 'white-list': 'false', difficulty: 'peaceful' },
        isRunning: true,
        saveProperties: vi.fn(),
        sendCommand: vi.fn().mockResolvedValue('ok'),
        _loadProperties: vi.fn().mockReturnValue(null),
      };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .put('/api/instances/s1/properties')
        .send({
          'white-list': 'true',
          'enforce-whitelist': 'true',
          difficulty: 'hard',
          gamemode: 'creative',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.restartRequired).toEqual([]);
      expect(instance.sendCommand.mock.calls.map((c) => c[0])).toEqual([
        'whitelist on',
        'whitelist enforce on',
        'difficulty hard',
        'defaultgamemode creative',
      ]);
    });

    it('命令下发失败降级：runtime 命令抛错仅警告，保存与响应不受阻', async () => {
      const instance = {
        id: 's1',
        properties: { difficulty: 'peaceful' },
        isRunning: true,
        saveProperties: vi.fn(),
        sendCommand: vi.fn().mockRejectedValue(new Error('rcon down')),
        _loadProperties: vi.fn().mockReturnValue(null),
      };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .put('/api/instances/s1/properties')
        .send({ difficulty: 'hard', motd: 'updated' });

      expect(res.status).toBe(200);
      // motd 非 runtime 键：运行中实例需重启生效
      expect(res.body.data.restartRequired).toEqual(['motd']);
      expect(instance.saveProperties).toHaveBeenCalled();
    });
  });

  // ── PUT /instances/:id 字段同步与熔断重置补口 ──
  describe('PUT /api/instances/:id（字段同步补口）', () => {
    it('javaPath null 清除 + 内存字段同步：javaPath/maxMemory/minMemory/jvmArgs/autoRestart', async () => {
      const instance = {
        id: 's1',
        serverPath: INSTANCE_PATH,
        javaPath: 'java',
        maxMemory: '4G',
        minMemory: '2G',
        jarFile: null,
        autoRestart: false,
        autoStart: false,
        jvmArgs: null,
        toStatus: () => ({ id: 's1' }),
      };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .put('/api/instances/s1')
        .send({ javaPath: null, maxMemory: '8G', minMemory: '1G', jvmArgs: ['-Xmx8G'], autoRestart: true });

      expect(res.status).toBe(200);
      // 内存运行实例字段同步（下次 start() 生效）
      expect(instance.javaPath).toBeNull();
      expect(instance.maxMemory).toBe('8G');
      expect(instance.minMemory).toBe('1G');
      expect(instance.jvmArgs).toEqual(['-Xmx8G']);
      expect(instance.autoRestart).toBe(true);
      expect(InstanceModel.update).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ javaPath: null, maxMemory: '8G', minMemory: '1G' }),
      );
    });

    it('autoRestart 重新开启时重置崩溃熔断器（用户已确认手动介入）', async () => {
      const instance = {
        id: 's1',
        serverPath: INSTANCE_PATH,
        javaPath: 'java',
        autoRestart: false,
        toStatus: () => ({ id: 's1' }),
        _circuitBreakerTripped: true,
        _consecutiveCrashes: 3,
        _crashWindowStart: 123456,
      };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).put('/api/instances/s1').send({ autoRestart: true });

      expect(res.status).toBe(200);
      expect(instance._circuitBreakerTripped).toBe(false);
      expect(instance._consecutiveCrashes).toBe(0);
      expect(instance._crashWindowStart).toBeNull();
    });

    it('javaPath 指向目录（非文件）→ 400 拒绝，不落库', async () => {
      const instance = { id: 's1', serverPath: INSTANCE_PATH, javaPath: 'java', toStatus: () => ({ id: 's1' }) };
      mockManager.getInstance.mockReturnValue(instance);
      fs.statSync.mockImplementation(() => ({ isFile: () => false }));

      const res = await request(app)
        .put('/api/instances/s1')
        .send({ javaPath: '/tmp/mc-test-dir' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('javaPath');
      expect(InstanceModel.update).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /instances/:id：卸载实例（整段缺口）──
  describe('DELETE /api/instances/:id', () => {
    const backupDir = path.join(config.backupsDir, 's1');
    const NAME = '演示实例';

    /** 卸载请求：破坏性端点要求实例名确认，除 404 用例外的调用都要带上 */
    const uninstall = (body = { confirmName: NAME }) =>
      request(app).delete('/api/instances/s1').send(body);

    const makeInstance = (overrides = {}) => ({
      id: 's1',
      name: NAME,
      serverPath: INSTANCE_PATH,
      isRunning: false,
      cancelRestart: vi.fn(),
      process: null,
      ...overrides,
    });

    it('404：实例不存在（先于确认校验，无 body 也不进 400 分支）', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app).delete('/api/instances/s1');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
      expect(InstanceModel.delete).not.toHaveBeenCalled();
    });

    it('未运行实例卸载成功：定时器取消 + 实例目录删除 + 备份目录保留 + 备份 DB 清理 + 内存移除 + 实例 DB 删除 + 双阶段审计', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation((p) => p === INSTANCE_PATH || p === backupDir);

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Instance deleted');
      expect(instance.cancelRestart).toHaveBeenCalledTimes(1);
      expect(fs.rmSync).toHaveBeenCalledTimes(1);
      expect(fs.rmSync).toHaveBeenCalledWith(INSTANCE_PATH, { recursive: true, force: true });
      // 备份目录按设计保留：它是实例数据的事实副本，磁盘回收交给保留期孤儿清扫
      expect(fs.rmSync).not.toHaveBeenCalledWith(backupDir, expect.anything());
      expect(BackupModel.deleteByInstance).toHaveBeenCalledWith('s1');
      expect(mockManager.instances.size).toBe(0);
      expect(InstanceModel.delete).toHaveBeenCalledWith('s1');
      expect(recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: 's1', action: AuditActions.INSTANCE_DELETE }),
      );
      expect(res.body.data).toEqual({ retainedBackupCount: 0, retainedBackupNames: [] });
    });

    it('确认校验：confirmName 缺失/类型不对/与实例名不匹配 → 400 且零副作用', async () => {
      for (const body of [{}, { confirmName: 42 }, { confirmName: '别的名字' }, { confirmName: '  演示实例  x' }]) {
        vi.clearAllMocks();
        const instance = makeInstance();
        mockManager.getInstance.mockReturnValue(instance);

        const res = await uninstall(body);

        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.code).toBe(40016);
        expect(instance.cancelRestart).not.toHaveBeenCalled();
        expect(fs.rmSync).not.toHaveBeenCalled();
        expect(BackupModel.deleteByInstance).not.toHaveBeenCalled();
        expect(InstanceModel.delete).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();
      }
    });

    it('确认校验：首尾空白被归一化（" 演示实例 " 放行）', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation(() => false);

      const res = await uninstall({ confirmName: '  演示实例  ', acknowledgeIrreversible: true });

      expect(res.status).toBe(200);
      expect(InstanceModel.delete).toHaveBeenCalledWith('s1');
    });

    it('零备份清单：仅确认不够 → 409，且不停机/不删文件/不改 DB/不写审计', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);

      const res = await uninstall();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(40914);
      expect(instance.cancelRestart).not.toHaveBeenCalled();
      expect(fs.rmSync).not.toHaveBeenCalled();
      expect(BackupModel.deleteByInstance).not.toHaveBeenCalled();
      expect(InstanceModel.delete).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('零备份清单 + acknowledgeIrreversible:true → 放行，响应回报 0 份保留', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation(() => false);

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ retainedBackupCount: 0, retainedBackupNames: [] });
      expect(InstanceModel.delete).toHaveBeenCalledWith('s1');
    });

    it('清单非空：确认即可放行，响应回报保留的快照目录名', async () => {
      listInstanceSnapshotDirs.mockReturnValue(['每日备份-2026-09-01T04-00-00-000Z']);
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation((p) => p === INSTANCE_PATH);

      const res = await uninstall();

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        retainedBackupCount: 1,
        retainedBackupNames: ['每日备份-2026-09-01T04-00-00-000Z'],
      });
      // 清单非空时无需要求 acknowledgeIrreversible
      expect(InstanceModel.delete).toHaveBeenCalledWith('s1');
    });

    it('审计先于文件操作：意图记录落盘时实例目录仍在，删除后补结果记录', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      // 意图审计写入时刻的真实盘面：实例目录尚未删除
      fs.existsSync.mockImplementation((p) => p === INSTANCE_PATH);
      let dirPresentDuringIntentAudit = null;
      recordAudit.mockImplementation((entry) => {
        if (entry.detail?.phase === 'intent') {
          dirPresentDuringIntentAudit = fs.existsSync(INSTANCE_PATH);
        }
      });

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(200);
      expect(dirPresentDuringIntentAudit).toBe(true);
      const phases = recordAudit.mock.calls.map(([entry]) => entry.detail?.phase);
      expect(phases).toEqual(['intent', 'completed']);
      // 审计 detail 不含任何凭据字段
      for (const [entry] of recordAudit.mock.calls) {
        expect(Object.keys(entry.detail).sort()).not.toContain('apiKey');
        expect(JSON.stringify(entry.detail)).not.toMatch(/key|secret|token|password/i);
      }
    });

    it('运行中实例：stopGracefully 后进程未退出 → 等待 exit 事件（立即触发）再清理', async () => {
      const proc = {
        exitCode: null,
        signalCode: null,
        once: vi.fn((ev, cb) => cb()),
      };
      const instance = makeInstance({ isRunning: true, stopGracefully: vi.fn().mockResolvedValue(), process: proc });
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation(() => false);

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(200);
      expect(instance.stopGracefully).toHaveBeenCalledTimes(1);
      expect(proc.once).toHaveBeenCalledWith('exit', expect.any(Function));
      // 目录存在性不再前置于删除：rmSync 照常调用（force 容忍 ENOENT），
      // 备份 DB 清理与实例移除照常
      expect(fs.rmSync).toHaveBeenCalledWith(INSTANCE_PATH, { recursive: true, force: true });
      expect(BackupModel.deleteByInstance).toHaveBeenCalledWith('s1');
      expect(mockManager.instances.size).toBe(0);
    });

    it('stopGracefully 超时抛错被吞 + 实例目录不存在也照常清理 → 卸载流程继续', async () => {
      const instance = makeInstance({ isRunning: true, stopGracefully: vi.fn().mockRejectedValue(new Error('stop timeout')) });
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation(() => false);

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(200);
      expect(BackupModel.deleteByInstance).toHaveBeenCalledWith('s1');
      expect(InstanceModel.delete).toHaveBeenCalledWith('s1');
    });

    it('DB 删除失败降级：实例目录已清理后 DB 删除抛错仅警告，仍返回成功', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation((p) => p === INSTANCE_PATH);
      InstanceModel.delete.mockImplementation(() => {
        throw new Error('db down');
      });

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(200);
      expect(mockManager.instances.size).toBe(0);
      expect(recordAudit).toHaveBeenCalled();
    });

    // ── 备份互斥（#530）：creating/restoring 进行中拒绝卸载，防恢复竞争数据事故 ──
    it('restoring 记录存在 → 409 拒绝：不触碰实例目录/快照目录/任何 DB 记录', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation((p) => p === INSTANCE_PATH || p === backupDir);
      BackupModel.findAll.mockImplementation(({ status }) => ({
        backups: [], total: status === 'restoring' ? 1 : 0,
      }));

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(40901);
      expect(res.body.message).toBe('备份进行中，请等待完成后再删除实例');
      // 拒绝为纯前置检查：目录/快照/DB/内存/审计零触碰
      expect(fs.rmSync).not.toHaveBeenCalled();
      expect(BackupModel.deleteByInstance).not.toHaveBeenCalled();
      expect(InstanceModel.delete).not.toHaveBeenCalled();
      expect(mockManager.instances.size).toBe(1);
      expect(recordAudit).not.toHaveBeenCalled();
    });

    it('creating 记录存在 → 409 拒绝（在线备份中卸载同被拦下）', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      BackupModel.findAll.mockImplementation(({ status }) => ({
        backups: [], total: status === 'creating' ? 1 : 0,
      }));

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(40901);
      expect(fs.rmSync).not.toHaveBeenCalled();
      expect(BackupModel.deleteByInstance).not.toHaveBeenCalled();
      expect(InstanceModel.delete).not.toHaveBeenCalled();
    });

    it('卡死记录先经 resetStaleInProgress 按语义重置，重置后无进行中记录 → 正常卸载（三清回归）', async () => {
      const instance = makeInstance();
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      fs.existsSync.mockImplementation((p) => p === INSTANCE_PATH || p === backupDir);
      BackupModel.resetStaleInProgress.mockReturnValue(1);
      // findAll 默认 total=0：stale 重置后互斥放行

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(200);
      expect(BackupModel.resetStaleInProgress).toHaveBeenCalledWith({
        maxAgeMs: config.backupInProgressTimeoutMs, instanceId: 's1',
      });
      expect(fs.rmSync).toHaveBeenCalledWith(INSTANCE_PATH, { recursive: true, force: true });
      expect(BackupModel.deleteByInstance).toHaveBeenCalledWith('s1');
      expect(InstanceModel.delete).toHaveBeenCalledWith('s1');
    });

    it('检查置于停机等待之后：运行中实例先 stopGracefully 再命中互斥 → 409', async () => {
      const instance = makeInstance({ isRunning: true, stopGracefully: vi.fn().mockResolvedValue() });
      mockManager.getInstance.mockReturnValue(instance);
      mockManager.instances.set('s1', instance);
      BackupModel.findAll.mockImplementation(({ status }) => ({
        backups: [], total: status === 'restoring' ? 1 : 0,
      }));

      const res = await uninstall({ confirmName: NAME, acknowledgeIrreversible: true });

      expect(res.status).toBe(409);
      // 停机等待先行（删前必停的既有语义保留），互斥检查紧贴删除动作消除 TOCTOU 窗口
      expect(instance.stopGracefully).toHaveBeenCalledTimes(1);
      expect(instance.cancelRestart).toHaveBeenCalledTimes(1);
      expect(fs.rmSync).not.toHaveBeenCalled();
      expect(BackupModel.deleteByInstance).not.toHaveBeenCalled();
    });
  });

  // ── POST /instances/:id/eula：EULA 确认写入（整段缺口）──
  describe('POST /api/instances/:id/eula', () => {
    it('404：实例不存在', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app).post('/api/instances/s1/eula').send({ agreed: true });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
    });

    it('agreed 非 boolean → 400，不写文件', async () => {
      const instance = { id: 's1', serverPath: INSTANCE_PATH };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/eula')
        .send({ agreed: 'yes' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('agreed must be a boolean');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('agreed=true：写入 eula=true 内容，返回 EULA accepted', async () => {
      const instance = { id: 's1', serverPath: INSTANCE_PATH };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).post('/api/instances/s1/eula').send({ agreed: true });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('EULA accepted');
      // 原子写契约：先写同目录唯一临时文件，再 rename 覆盖 eula.txt（半截内容不落盘）
      const [tmpPath, written] = fs.writeFileSync.mock.calls[0];
      expect(tmpPath.startsWith(`${EULA_PATH}.`)).toBe(true);
      expect(tmpPath.endsWith('.tmp')).toBe(true);
      expect(written).toContain('eula=true');
      expect(fs.renameSync).toHaveBeenCalledWith(tmpPath, EULA_PATH);
    });

    it('agreed=false：写入 eula=false 内容，返回 EULA declined', async () => {
      const instance = { id: 's1', serverPath: INSTANCE_PATH };
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).post('/api/instances/s1/eula').send({ agreed: false });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('EULA declined');
      // 原子写契约：先写同目录唯一临时文件，再 rename 覆盖 eula.txt（半截内容不落盘）
      const [tmpPath, written] = fs.writeFileSync.mock.calls[0];
      expect(tmpPath.startsWith(`${EULA_PATH}.`)).toBe(true);
      expect(tmpPath.endsWith('.tmp')).toBe(true);
      expect(written).toContain('eula=false');
      expect(fs.renameSync).toHaveBeenCalledWith(tmpPath, EULA_PATH);
    });
  });

  // ── GET /instances/:id/world：世界信息（分支补口）──
  describe('GET /api/instances/:id/world', () => {
    it('404：实例不存在', async () => {
      mockManager.getInstance.mockReturnValue(undefined);
      const res = await request(app).get('/api/instances/s1/world');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(40401);
    });

    it.each([
      ['MC 26.x 格式', 'The game time is 24000 tick(s)', 1],
      ['MC 26.1 早期格式', 'Timeline minecraft:gametime is at 48000 tick(s)', 2],
      ['旧版格式', 'The time is 72000', 3],
    ])('gameDays 解析·%s：%s → %i 天', async (_label, rconReply, days) => {
      mockManager.getInstance.mockReturnValue(makeWorldInstance({
        sendCommandWithResponse: vi.fn().mockResolvedValue(rconReply),
      }));

      const res = await request(app).get('/api/instances/s1/world');

      expect(res.status).toBe(200);
      expect(res.body.data.gameDays).toBe(days);
    });

    it('维度统计：缓存详情按维度计数 + 缺详情/无键名回退 overworld', async () => {
      mockManager.getInstance.mockReturnValue(makeWorldInstance({
        players: new Map([
          ['Steve', { _cachedDetails: { dimension: 'nether' } }],
          ['Alex', { _cachedDetails: { dimension: 'end' } }],
          ['Bob', undefined],
          [null, undefined],
        ]),
      }));

      const res = await request(app).get('/api/instances/s1/world');

      expect(res.status).toBe(200);
      const dims = res.body.data.dimensions;
      expect(dims.map((d) => d.playerCount)).toEqual([2, 1, 1]);
      expect(res.body.data.onlinePlayers).toBe(4);
      // 运行时难度优先（readDifficulty 覆盖文件值 peaceful）
      expect(res.body.data.difficulty).toBe('hard');
    });

    it('RCON 断连 gameDays=null + readDifficulty 异常兜底文件值', async () => {
      mockManager.getInstance.mockReturnValue(makeWorldInstance({
        isRconConnected: false,
        readDifficulty: vi.fn().mockRejectedValue(new Error('rcon down')),
      }));

      const res = await request(app).get('/api/instances/s1/world');

      expect(res.status).toBe(200);
      expect(res.body.data.gameDays).toBeNull();
      expect(res.body.data.difficulty).toBe('peaceful');
    });
  });
});
