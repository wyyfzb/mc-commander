/**
 * status 输入侧契约测试（issue 486）：实例控制面五 body 端点 validateBody 收口
 *
 * 范式：status.endpoints.test.js 的 mock 隔离（InstanceModel/recordAudit）
 * + auth.input.contract.test.js 的 400 统一信封断言（code 40000 + details 路径）。
 * 覆盖：每端点合法/非法输入各至少 1 例——非法断言 400 信封错误码（schema 层
 * 前置拒收），合法断言行为零变化（handler 原语义/DB 持久化/下游调用保持）。
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock 隔离：SQLite 模型 + 审计记录（status.endpoints.test.js 同款）──
vi.mock('../db/index.js', () => ({
  InstanceModel: {
    update: vi.fn(),
    delete: vi.fn(),
  },
  BackupModel: {
    deleteByInstance: vi.fn(),
  },
}));

vi.mock('../utils/audit.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, recordAudit: vi.fn() };
});

import { createStatusRoutes } from '../routes/status.js';
import { InstanceModel } from '../db/index.js';
import { recordAudit, AuditActions } from '../utils/audit.js';
import { errorHandler } from '../middleware/error_handler.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-status-input-'));
const INSTANCE_PATH = path.join(TMP_ROOT, 's1');
fs.mkdirSync(INSTANCE_PATH, { recursive: true });

/** instanceStatusSchema 全字段合法 fixture：toStatus() 返回值可过响应侧观测（无 contract 漂移日志） */
function makeStatusFixture(overrides = {}) {
  return {
    id: 's1',
    name: 's1',
    isRunning: true,
    isRconConnected: true,
    autoRestart: false,
    autoStart: false,
    circuitBreakerTripped: false,
    consecutiveCrashes: 0,
    uptime: 100,
    address: 'localhost:25565',
    players: [],
    playerCount: 0,
    maxPlayers: 20,
    mcVersion: '1.21.4',
    modLoader: 'vanilla',
    tps: 20,
    mspt: 25,
    cpuUsage: 1.5,
    memoryUsage: 1024,
    totalMemory: 4096,
    worldSize: null,
    seed: null,
    lastSave: null,
    lastOutput: null,
    gameMode: 'survival',
    difficulty: 'normal',
    whitelisted: false,
    onlineMode: true,
    viewDistance: 10,
    spawnProtection: 16,
    worldDay: null,
    worldTime: null,
    weather: null,
    opCount: 0,
    opNames: [],
    todayNewPlayers: 0,
    sleepingPlayers: 0,
    sleepingPlayerNames: [],
    awakePlayerNames: [],
    totalUptime: 0,
    startTime: null,
    startCommand: null,
    jvmArgs: null,
    javaPath: '/usr/bin/java',
    maxMemory: '4G',
    minMemory: '2G',
    jarFile: 'server.jar',
    ...overrides,
  };
}

/** 五端点共用实例 mock（字段可变，供 PUT settings 内存同步断言） */
function makeInstance(overrides = {}) {
  const instance = {
    id: 's1',
    serverPath: INSTANCE_PATH,
    name: 's1',
    description: null,
    jarFile: 'server.jar',
    maxMemory: '4G',
    minMemory: '2G',
    javaPath: '/usr/bin/java',
    startCommand: null,
    jvmArgs: null,
    autoRestart: false,
    autoStart: false,
    isRunning: true,
    _circuitBreakerTripped: false,
    _consecutiveCrashes: 0,
    _crashWindowStart: null,
    properties: { difficulty: 'peaceful', 'view-distance': '10' },
    toStatus: vi.fn(() => makeStatusFixture()),
    start: vi.fn(),
    sendCommand: vi.fn().mockResolvedValue('OK'),
    saveProperties: vi.fn(),
    _loadProperties: vi.fn(() => null),
    ...overrides,
  };
  return instance;
}

describe('status 输入侧契约 - PUT /instances/:id（issue 486）', () => {
  let app;
  let instance;
  let manager;

  beforeEach(() => {
    vi.resetAllMocks();
    instance = makeInstance();
    manager = { getInstance: vi.fn(() => instance) };
    app = express();
    app.use(express.json());
    app.use('/api/v1', createStatusRoutes(manager));
    app.use(errorHandler);
  });

  it('name 非字符串（数字）→ 400 统一校验信封（schema 层拒收）', async () => {
    const res = await request(app).put('/api/v1/instances/s1').send({ name: 123 });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.code).toBe(40000);
    expect(res.body.details.map((d) => d.path)).toContain('name');
  });

  it('jvmArgs 非数组（字符串）→ 400 统一校验信封（结构化参数形状前置）', async () => {
    const res = await request(app).put('/api/v1/instances/s1').send({ jvmArgs: '-Xmx4G' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.details.map((d) => d.path)).toContain('jvmArgs');
  });

  it('startCommand 字符串 → 400 且原文案保持（schema 承接既有拒绝语义）', async () => {
    const res = await request(app)
      .put('/api/v1/instances/s1')
      .send({ startCommand: 'java -jar evil.jar' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toContain('startCommand 已不再支持通过 API 更新');
    expect(instance.startCommand).toBeNull();
  });

  it('空对象 → 400「没有可更新的字段」（schema 不越权，handler 原语义保持）', async () => {
    const res = await request(app).put('/api/v1/instances/s1').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toBe('没有可更新的字段');
  });

  it('仅未知字段 → 剥离后无可更新字段 → 400「没有可更新的字段」（剥离不改变结果）', async () => {
    const res = await request(app).put('/api/v1/instances/s1').send({ junk: 'x', foo: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('没有可更新的字段');
  });

  it('合法 name+autoRestart → 200 + DB 持久化 + 内存同步 + 审计（成功路径行为不变）', async () => {
    const res = await request(app)
      .put('/api/v1/instances/s1')
      .send({ name: 'renamed', autoRestart: true });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('s1');
    expect(InstanceModel.update).toHaveBeenCalledWith('s1', { name: 'renamed', autoRestart: true });
    expect(instance.name).toBe('renamed');
    expect(instance.autoRestart).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditActions.INSTANCE_UPDATE }),
    );
  });

  it('name 首尾空白在写入侧归一化：落库与内存同步的均为 trim 后的值', async () => {
    const res = await request(app).put('/api/v1/instances/s1').send({ name: '  Steve 的服  ' });

    expect(res.status).toBe(200);
    // 库里的名字是卸载/备份恢复的确认值：存成带空格的形态会让用户按界面所见的
    // 名字永远确认不上，实例再也删不掉
    expect(InstanceModel.update).toHaveBeenCalledWith('s1', { name: 'Steve 的服' });
    expect(instance.name).toBe('Steve 的服');
  });

  it('name trim 后为空 → 400（不落库空串/纯空白）', async () => {
    const res = await request(app).put('/api/v1/instances/s1').send({ name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.details.map((d) => d.path)).toContain('name');
    expect(InstanceModel.update).not.toHaveBeenCalled();
  });

  it('startCommand 传 null → 清除语义保持（遗留旧命令迁移途径不变）', async () => {
    instance.startCommand = 'java -jar legacy.jar';
    const res = await request(app).put('/api/v1/instances/s1').send({ startCommand: null });
    expect(res.status).toBe(200);
    expect(instance.startCommand).toBeNull();
    expect(InstanceModel.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ startCommand: null }),
    );
  });
});

describe('status 输入侧契约 - POST /instances/:id/start（issue 486）', () => {
  let app;
  let instance;
  let manager;

  beforeEach(() => {
    vi.resetAllMocks();
    instance = makeInstance();
    manager = { getInstance: vi.fn(() => instance) };
    app = express();
    app.use(express.json());
    app.use('/api/v1', createStatusRoutes(manager));
    app.use(errorHandler);
  });

  it('startCommand 字符串 → 400 统一校验信封（RCE 封堵 schema 前置）', async () => {
    const res = await request(app)
      .post('/api/v1/instances/s1/start')
      .send({ startCommand: 'java -jar evil.jar' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toContain('startCommand 已不再支持通过 API 传入');
    expect(instance.start).not.toHaveBeenCalled();
  });

  it('startCommand 传 null → 400（禁用键对任何值成立，与原 in 判断一致）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/start').send({ startCommand: null });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(instance.start).not.toHaveBeenCalled();
  });

  it('空 body + EULA 已接受 → 200 启动路径行为不变', async () => {
    fs.writeFileSync(path.join(INSTANCE_PATH, 'eula.txt'), 'eula=true\n');
    const res = await request(app).post('/api/v1/instances/s1/start').send({});
    expect(res.status).toBe(200);
    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(InstanceModel.update).toHaveBeenCalledWith('s1', { status: 'running' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditActions.INSTANCE_START }),
    );
  });

  it('EULA 未接受 → 403（schema 放行后 handler 原语义保持）', async () => {
    fs.rmSync(path.join(INSTANCE_PATH, 'eula.txt'), { force: true });
    const res = await request(app).post('/api/v1/instances/s1/start').send();
    expect(res.status).toBe(403);
    expect(instance.start).not.toHaveBeenCalled();
  });
});

describe('status 输入侧契约 - POST /instances/:id/command（issue 486）', () => {
  let app;
  let instance;
  let manager;

  beforeEach(() => {
    vi.resetAllMocks();
    instance = makeInstance();
    manager = { getInstance: vi.fn(() => instance) };
    app = express();
    app.use(express.json());
    app.use('/api/v1', createStatusRoutes(manager));
    app.use(errorHandler);
  });

  it('缺失 command → 400 统一校验信封（原文案保持）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/command').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toContain('Command is required');
  });

  it('空字符串 → 400（原 !command 拒收语义收口至 schema 层）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/command').send({ command: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toContain('Command is required');
    expect(instance.sendCommand).not.toHaveBeenCalled();
  });

  it('command 非字符串（数字）→ 400 统一校验信封（原散点透传收口）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/command').send({ command: 42 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toContain('Command must be a string');
    expect(instance.sendCommand).not.toHaveBeenCalled();
  });

  it('超长命令（>2000）→ 400（长度上限拒收）', async () => {
    const res = await request(app)
      .post('/api/v1/instances/s1/command')
      .send({ command: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(instance.sendCommand).not.toHaveBeenCalled();
  });

  it('合法命令 → 200 + sendCommand 调用 + 回显（控制台链路行为不变）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/command').send({ command: 'list' });
    expect(res.status).toBe(200);
    expect(instance.sendCommand).toHaveBeenCalledWith('list');
    expect(res.body.data).toBe('OK');
  });
});

describe('status 输入侧契约 - PUT /instances/:id/properties（issue 486）', () => {
  let app;
  let instance;
  let manager;

  beforeEach(() => {
    vi.resetAllMocks();
    instance = makeInstance();
    manager = { getInstance: vi.fn(() => instance) };
    app = express();
    app.use(express.json());
    app.use('/api/v1', createStatusRoutes(manager));
    app.use(errorHandler);
  });

  it('数组 body → 400 统一校验信封（schema 层拒绝，信封由 SERVER_ERROR 收口为 VALIDATION_ERROR）', async () => {
    const res = await request(app).put('/api/v1/instances/s1/properties').send(['difficulty']);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(instance.saveProperties).not.toHaveBeenCalled();
  });

  it('合法属性对象 → 200 + saveProperties 全量键写入 + 运行中命令下发（行为不变）', async () => {
    const res = await request(app)
      .put('/api/v1/instances/s1/properties')
      .send({ difficulty: 'hard', 'view-distance': '12' });
    expect(res.status).toBe(200);
    expect(instance.saveProperties).toHaveBeenCalledWith({
      difficulty: 'hard',
      'view-distance': '12',
    });
    // difficulty 为运行期命令键：运行中下发 difficulty hard（view-distance 需重启）
    expect(instance.sendCommand).toHaveBeenCalledWith('difficulty hard');
    expect(res.body.data.restartRequired).toEqual(['view-distance']);
  });

  it('passthrough 保留全部属性键（未知键仍由路由层白名单 400 拒绝，schema 不越权）', async () => {
    const res = await request(app).put('/api/v1/instances/s1/properties').send({ 'evil-key': 'x' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toContain('evil-key');
    expect(instance.saveProperties).not.toHaveBeenCalled();
  });
});

describe('status 输入侧契约 - POST /instances/:id/eula（issue 486）', () => {
  let app;
  let instance;
  let manager;

  beforeEach(() => {
    vi.resetAllMocks();
    instance = makeInstance();
    manager = { getInstance: vi.fn(() => instance) };
    app = express();
    app.use(express.json());
    app.use('/api/v1', createStatusRoutes(manager));
    app.use(errorHandler);
  });

  it('缺失 agreed → 400 统一校验信封（原文案保持）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/eula').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toContain('agreed must be a boolean');
  });

  it('agreed 非布尔（字符串）→ 400（原 typeof 判断收口至 schema 层）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/eula').send({ agreed: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(40000);
    expect(res.body.message).toContain('agreed must be a boolean');
  });

  it('合法 true → 200 + eula.txt 真实写入 eula=true（写盘行为不变）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/eula').send({ agreed: true });
    expect(res.status).toBe(200);
    const content = fs.readFileSync(path.join(INSTANCE_PATH, 'eula.txt'), 'utf-8');
    expect(content).toContain('eula=true');
    expect(res.body.message).toBe('EULA accepted');
  });

  it('合法 false → 200 + eula.txt 写入 eula=false（拒绝分支行为不变）', async () => {
    const res = await request(app).post('/api/v1/instances/s1/eula').send({ agreed: false });
    expect(res.status).toBe(200);
    const content = fs.readFileSync(path.join(INSTANCE_PATH, 'eula.txt'), 'utf-8');
    expect(content).toContain('eula=false');
    expect(res.body.message).toBe('EULA declined');
  });
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});
