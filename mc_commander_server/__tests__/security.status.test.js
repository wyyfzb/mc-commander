import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// find-018（PUT /properties 键白名单与值校验）、find-002-route
// （PUT /instances/:id 与 POST /start 移除 startCommand 注入面）、
// find-015-server（GET/PUT /properties 敏感键占位符）安全修复回归测试。
// 测试全部使用 mock 实例与临时目录文件，不包含任何真实数据。

function buildApp(mockManager) {
  const app = express();
  app.use(express.json());
  app.use('/api', createStatusRoutes(mockManager));
  app.use(errorHandler); // 与生产环境一致：路由内部错误经全局 errorHandler 统一处理
  return app;
}

function makeMockInstance(overrides = {}) {
  return {
    id: 's1',
    serverPath: undefined,
    properties: {},
    isRunning: false,
    isRconConnected: false,
    start: vi.fn(),
    _loadProperties: vi.fn().mockReturnValue(null),
    readDifficulty: vi.fn().mockResolvedValue(null),
    _readGameTypeFromLevelDat: vi.fn().mockReturnValue(null),
    saveProperties: vi.fn(function (props) {
      this.properties = { ...this.properties, ...props };
    }),
    sendCommand: vi.fn(async () => null),
    toStatus: () => ({ id: 's1' }),
    ...overrides,
  };
}

describe('find-018: PUT /api/instances/:id/properties 键白名单与值校验', () => {
  let app;
  let mockManager;
  let consoleWarnSpy;

  beforeEach(() => {
    mockManager = {
      instances: new Map(),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    };
    app = buildApp(mockManager);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('未知键整体拒绝 400 并日志告警，且不写入任何属性', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'pvp': 'false', 'totally-unknown-key': 'x' });

    expect(res.status).toBe(400);
    expect(instance.saveProperties).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('拒绝未知属性键'));
  });

  it('敏感键禁止写入：enable-rcon / online-mode / server-port / enable-command-block / rcon.password 一律 400', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    for (const key of ['enable-rcon', 'online-mode', 'server-port', 'enable-command-block', 'rcon.password', 'server-ip', 'enable-query', 'enable-status', 'rcon.port']) {
      const res = await request(app)
        .put('/api/instances/s1/properties')
        .send({ [key]: 'x' });
      expect(res.status).toBe(400);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('拒绝写入敏感属性'));
    }
    expect(instance.saveProperties).not.toHaveBeenCalled();
  });

  it('布尔键仅接受 true/false，非法值 400', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'pvp': 'yes' });

    expect(res.status).toBe(400);
    expect(instance.saveProperties).not.toHaveBeenCalled();
  });

  it('数值键仅接受整数（含 -1 特殊值），非整数 400', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const bad1 = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'view-distance': 'abc' });
    expect(bad1.status).toBe(400);

    const bad2 = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'max-tick-time': '100.5' });
    expect(bad2.status).toBe(400);

    const ok = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'max-tick-time': '-1' });
    expect(ok.status).toBe(200);
  });

  it('字符串键拒绝真实换行符（防 server.properties 行注入）', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'motd': '第一行\n第二行' });

    expect(res.status).toBe(400);
    expect(instance.saveProperties).not.toHaveBeenCalled();
  });

  it('level-name 白名单拒绝路径穿越（.. 与路径分隔符），合法值通过', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const bad1 = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'level-name': '../../etc' });
    expect(bad1.status).toBe(400);

    const bad2 = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'level-name': 'a/b' });
    expect(bad2.status).toBe(400);

    const ok = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'level-name': 'my_world-1' });
    expect(ok.status).toBe(200);
    expect(instance.saveProperties).toHaveBeenCalledWith({ 'level-name': 'my_world-1' });
  });

  it('合法键批量写入成功；合法与非法混合时整体拒绝（原子性）', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const ok = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'pvp': 'false', 'view-distance': '12', 'motd': 'hello world' });
    expect(ok.status).toBe(200);
    expect(instance.saveProperties).toHaveBeenCalledWith({ 'pvp': 'false', 'view-distance': '12', 'motd': 'hello world' });

    const mixed = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'pvp': 'false', 'evil-key': 'x' });
    expect(mixed.status).toBe(400);
    expect(instance.saveProperties).toHaveBeenCalledTimes(1); // 混合提交未落盘
  });

  it('运行期命令键值限制字符集（difficulty 命令注入防护），合法值正常下发命令', async () => {
    const instance = makeMockInstance({ isRunning: true });
    mockManager.getInstance.mockReturnValue(instance);

    const bad = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'difficulty': 'easy; stop' });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'difficulty': 'easy' });
    expect(ok.status).toBe(200);
    expect(instance.sendCommand).toHaveBeenCalledWith('difficulty easy');
  });

  it('空对象提交视为无变更，返回 200 且不写盘', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1/properties')
      .send({});

    expect(res.status).toBe(200);
    expect(instance.saveProperties).not.toHaveBeenCalled();
  });
});

describe('find-002-route: PUT /api/instances/:id 与 POST /start 封堵 startCommand 注入面', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    mockManager = {
      instances: new Map(),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    };
    app = buildApp(mockManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('PUT startCommand 返回 400，拒绝任意命令字符串入库', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1')
      .send({ startCommand: 'java -Xmx4G -jar server.jar' });

    expect(res.status).toBe(400);
    expect(InstanceModel.update).not.toHaveBeenCalled();
  });

  it('PUT javaPath 为不存在的路径返回 400', async () => {
    const instance = makeMockInstance();
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1')
      .send({ javaPath: 'C:/definitely/not/exists/java.exe' });

    expect(res.status).toBe(400);
    expect(InstanceModel.update).not.toHaveBeenCalled();
  });

  it('PUT javaPath 指向 bash/python/sh 等非 java 可执行文件返回 400', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-'));
    try {
      const instance = makeMockInstance();
      mockManager.getInstance.mockReturnValue(instance);

      for (const name of ['bash', 'python', 'sh']) {
        const fakeExec = path.join(tmpDir, name);
        fs.writeFileSync(fakeExec, '#!/bin/sh\necho hi\n');
        const res = await request(app)
          .put('/api/instances/s1')
          .send({ javaPath: fakeExec });
        expect(res.status).toBe(400);
        expect(InstanceModel.update).not.toHaveBeenCalled();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('PUT javaPath 为已存在的 java 可执行文件通过并入库', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-'));
    try {
      const instance = makeMockInstance();
      mockManager.getInstance.mockReturnValue(instance);
      const fakeJava = path.join(tmpDir, 'java');
      fs.writeFileSync(fakeJava, 'fake java binary');
      InstanceModel.update.mockReturnValue({ changes: 1 });

      const res = await request(app)
        .put('/api/instances/s1')
        .send({ javaPath: fakeJava });

      expect(res.status).toBe(200);
      expect(InstanceModel.update).toHaveBeenCalledWith('s1', { javaPath: fakeJava });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('PUT 其余普通字段（name）仍正常更新（回归）', async () => {
    const instance = makeMockInstance({ name: 'S1' });
    mockManager.getInstance.mockReturnValue(instance);
    InstanceModel.update.mockReturnValue({ changes: 1 });

    const res = await request(app)
      .put('/api/instances/s1')
      .send({ name: 'S2' });

    expect(res.status).toBe(200);
    expect(InstanceModel.update).toHaveBeenCalledWith('s1', { name: 'S2' });
    expect(instance.name).toBe('S2');
  });

  it('POST /start 携带 startCommand 返回 400 且不启动', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
      const instance = makeMockInstance({ serverPath: tmpDir });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app)
        .post('/api/instances/s1/start')
        .send({ startCommand: 'rm -rf /' });

      expect(res.status).toBe(400);
      expect(instance.start).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('POST /start 不带 startCommand 正常启动（回归）', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'eula.txt'), 'eula=true\n');
      const instance = makeMockInstance({ serverPath: tmpDir });
      mockManager.getInstance.mockReturnValue(instance);

      const res = await request(app).post('/api/instances/s1/start');

      expect(res.status).toBe(200);
      expect(instance.start).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('find-015-server: GET/PUT /properties 敏感键占位符掩码', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    mockManager = {
      instances: new Map(),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    };
    app = buildApp(mockManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET 对敏感键返回 ******** 占位符，非敏感键原样返回', async () => {
    const instance = makeMockInstance({
      properties: {
        'rcon.password': 's3cret',
        'enable-rcon': 'true',
        'online-mode': 'true',
        'white-list': 'true',
        'pvp': 'false',
      },
    });
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app).get('/api/instances/s1/properties');

    expect(res.status).toBe(200);
    expect(res.body.data['rcon.password']).toBe('********');
    expect(res.body.data['enable-rcon']).toBe('********');
    expect(res.body.data['online-mode']).toBe('********');
    expect(res.body.data['white-list']).toBe('true');
    expect(res.body.data['pvp']).toBe('false');
  });

  it('GET 掩码后原样回传不会覆盖磁盘现值（占位符视为未修改）', async () => {
    const instance = makeMockInstance({
      properties: { 'rcon.password': '********', 'white-list': 'true' },
    });
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1/properties')
      .send({ 'rcon.password': '********', 'white-list': 'true' });

    expect(res.status).toBe(200);
    // 占位符被剔除，仅合法键写入，磁盘 rcon.password 得以保留
    expect(instance.saveProperties).toHaveBeenCalledWith({ 'white-list': 'true' });
  });
});

// ── find-002 闭环：实例级 jvmArgs 结构化参数持久化 + startCommand 清除途径 ──
// （前端实例设置弹窗提交 jvmArgs 数组；旧实例遗留 startCommand 经 null 清除）
describe('find-002 闭环: PUT /api/instances/:id jvmArgs 持久化与 startCommand 清除', () => {
  let app;
  let mockManager;

  beforeEach(() => {
    mockManager = {
      instances: new Map(),
      getAllInstances: vi.fn(),
      getInstance: vi.fn(),
    };
    app = buildApp(mockManager);
    InstanceModel.update.mockClear();
  });

  it('合法 jvmArgs 数组持久化到 DB 并同步内存实例', async () => {
    const instance = makeMockInstance({ serverPath: '/opt/servers/s1' });
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1')
      .send({ jvmArgs: ['-Xmx4G', '-Xms2G', '-XX:+UseG1GC', 'nogui'] });

    expect(res.status).toBe(200);
    expect(InstanceModel.update).toHaveBeenCalledWith('s1', { jvmArgs: ['-Xmx4G', '-Xms2G', '-XX:+UseG1GC', 'nogui'] });
    expect(instance.jvmArgs).toEqual(['-Xmx4G', '-Xms2G', '-XX:+UseG1GC', 'nogui']);
  });

  it('jvmArgs 含 -jar 时路径必须位于实例目录内', async () => {
    const instance = makeMockInstance({ serverPath: '/opt/servers/s1' });
    mockManager.getInstance.mockReturnValue(instance);

    const ok = await request(app)
      .put('/api/instances/s1')
      .send({ jvmArgs: ['-jar', 'server.jar', 'nogui'] });
    expect(ok.status).toBe(200);

    // 越界：../ 指向实例目录外
    const bad = await request(app)
      .put('/api/instances/s1')
      .send({ jvmArgs: ['-jar', '../evil.jar'] });
    expect(bad.status).toBe(400);
    expect(InstanceModel.update).toHaveBeenCalledTimes(1); // 仅合法请求落库
  });

  it('非法 jvmArgs 整体 400 拒绝：非数组 / 非字符串元素 / 不支持参数', async () => {
    const instance = makeMockInstance({ serverPath: '/opt/servers/s1' });
    mockManager.getInstance.mockReturnValue(instance);

    const nonArray = await request(app).put('/api/instances/s1').send({ jvmArgs: '-Xmx4G' });
    expect(nonArray.status).toBe(400);

    const nonString = await request(app).put('/api/instances/s1').send({ jvmArgs: [123] });
    expect(nonString.status).toBe(400);

    // 任意可执行文件名（RCE 注入面）被拒
    const arbitrary = await request(app).put('/api/instances/s1').send({ jvmArgs: ['bash', '-c', 'id'] });
    expect(arbitrary.status).toBe(400);

    // -jar 后缺路径参数
    const missingJar = await request(app).put('/api/instances/s1').send({ jvmArgs: ['-jar'] });
    expect(missingJar.status).toBe(400);
  });

  it('空数组 jvmArgs 允许（清除自定义参数，回退默认启动）', async () => {
    const instance = makeMockInstance({ serverPath: '/opt/servers/s1', jvmArgs: ['-Xmx4G'] });
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app).put('/api/instances/s1').send({ jvmArgs: [] });

    expect(res.status).toBe(200);
    expect(InstanceModel.update).toHaveBeenCalledWith('s1', { jvmArgs: [] });
    expect(instance.jvmArgs).toEqual([]);
  });

  it('startCommand: null 清除遗留旧命令（迁移到结构化参数的途径）', async () => {
    const instance = makeMockInstance({ startCommand: 'java -Xmx2G -jar server.jar nogui' });
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app).put('/api/instances/s1').send({ startCommand: null });

    expect(res.status).toBe(200);
    expect(InstanceModel.update).toHaveBeenCalledWith('s1', { startCommand: null });
    expect(instance.startCommand).toBeNull();
  });

  it('startCommand 非 null 值仍 400 拒绝（RCE 注入面封堵）', async () => {
    const instance = makeMockInstance({ serverPath: '/opt/servers/s1' });
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app)
      .put('/api/instances/s1')
      .send({ startCommand: 'bash -c "curl | sh"' });

    expect(res.status).toBe(400);
    expect(InstanceModel.update).not.toHaveBeenCalled();
  });

  it('实例无遗留 startCommand 时传 null 不产生更新（不误报空更新）', async () => {
    const instance = makeMockInstance({ startCommand: null });
    mockManager.getInstance.mockReturnValue(instance);

    const res = await request(app).put('/api/instances/s1').send({ startCommand: null });

    // 无任何可更新字段 → 400 没有可更新的字段（而非静默成功）
    expect(res.status).toBe(400);
  });
});
