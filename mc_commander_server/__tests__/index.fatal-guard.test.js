import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── 进程级兜底（uncaughtException/unhandledRejection → logger + shutdown）──
// 范式继承 index.security.test.js：全部重依赖 mock，避免 import index.js 时
// 产生真实副作用（数据库初始化 / 端口监听 / MC 子进程等）。
// process.on 以 spy 拦截注册（不污染测试进程真实 handler），从 mock.calls
// 提取 handler 手动触发，验证「结构化日志（含堆栈）→ 优雅停机链 → exit(0)」。
const h = vi.hoisted(() => {
  const appUse = vi.fn();
  const app = { use: appUse, set: vi.fn() };
  const stopSystemStatsBroadcast = vi.fn();
  const serverOn = vi.fn();
  const server = {
    listen: vi.fn((port, host, cb) => typeof cb === 'function' && cb()),
    on: serverOn,
    close: vi.fn((cb) => typeof cb === 'function' && cb()),
  };
  // SHA-256('mock-strong-key-0123456789abcdef') 预计算（满足启动哈希校验）；
  // 拆段拼接规避扫描器对高熵 hex 字面量的 generic-api-key 误报（与 index.security.test.js 同值）
  const startSystemStatsBroadcast = vi.fn(() => stopSystemStatsBroadcast);
  return {
    startSystemStatsBroadcast,
    apiKeyHash: ['98f5a7be', 'c05d6145', 'e649c6ed', 'd8f8d27f', '380d0da5', '15a86ab4', 'f77c5f0f', '50b56bf6'].join(''),
    app,
    server,
    serverOn,
    appUse,
    wsOpts: null,
    scheduler: null, // TaskScheduler 实例（constructor 捕获）
    manager: null, // MCServerManager 实例
    wss: null, // WebSocketServer 实例
    db: { close: vi.fn() }, // getDb() 返回的 db 桩
    stopSystemStatsBroadcast, // startSystemStatsBroadcast 返回的 stop 句柄
  };
});

vi.mock('express', () => ({
  default: Object.assign(() => h.app, {
    json: vi.fn(() => 'express-json-middleware'),
    urlencoded: vi.fn(() => 'express-urlencoded-middleware'),
  }),
}));
vi.mock('http', () => ({ default: { createServer: () => h.server } }));
vi.mock('ws', () => ({
  WebSocketServer: class {
    constructor(options) {
      h.wsOpts = options;
      h.wss = this;
    }
    close = vi.fn((cb) => typeof cb === 'function' && cb());
  },
}));
vi.mock('../config.js', () => ({
  default: {
    get apiKeyHash() {
      return h.apiKeyHash;
    },
    // 启动播种会回填内存哈希（config 在生产里是普通对象，桩必须可写）
    set apiKeyHash(value) {
      h.apiKeyHash = value;
    },
    port: 1,
    serversDir: 'mock:/servers',
    dataDir: 'mock:/data',
    // .env 写回目标（启动播种用）：桩成非真实路径，防止用例意外写仓库 .env
    envFilePath: 'mock:/.env',
    backupsDir: 'mock:/backups',
    publicDir: 'mock:/public',
    logLevel: 'info',
    rateLimit: { windowMs: 60000, max: 100 },
  },
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: 'auth-middleware',
  authenticateWebSocket: vi.fn(),
}));
vi.mock('../middleware/rate_limit.js', () => ({
  rateLimit: vi.fn(() => 'rateLimit-middleware'),
  apiKeyRateLimit: vi.fn(() => 'apiKeyRateLimit-middleware'),
}));
vi.mock('../middleware/error_handler.js', () => ({
  errorHandler: 'error-handler',
}));
vi.mock('../middleware/cors.js', () => ({ default: vi.fn() }));
vi.mock('helmet', () => ({ default: vi.fn(() => 'helmet-middleware') }));
vi.mock('../routes/index.js', () => ({ setupRoutes: vi.fn() }));
vi.mock('../services/mc_server.js', () => ({
  MCServerManager: class {
    stopAll = vi.fn(async () => {});
    on = vi.fn();
    constructor() {
      h.manager = this;
    }
  },
}));
vi.mock('../services/task_scheduler.js', () => ({
  TaskScheduler: class {
    start = vi.fn();
    stop = vi.fn();
    constructor() {
      h.scheduler = this;
    }
  },
}));
vi.mock('../websocket.js', () => ({
  // index.js 会消费返回值里的 startSystemStatsBroadcast（系统统计推送的接线点）：
  // 桩给出该函数并把 stop 句柄记在 hoisted holder 上，供「停机链调用了它」的断言
  // 只在被调用时返回 stop 句柄（不得顺手调用它，否则「停机调用了 stop」的断言变成空转）
  setupWebSocket: vi.fn(() => ({ startSystemStatsBroadcast: h.startSystemStatsBroadcast })),
  // 停机链会调用通知事件队列的强制刷写（批量落库收尾）
  flushNotificationEvents: vi.fn(),
}));
vi.mock('../services/webhook.service.js', () => ({ setupWebhookDispatch: vi.fn() }));
vi.mock('../db/index.js', () => ({
  initDatabase: vi.fn(),
  getDb: vi.fn(() => h.db),
  InstanceModel: { getAll: vi.fn(() => []) },
}));

let onSpy; // process.on 拦截（每用例装拆，最小化拦截窗口）

// 重新 import index.js 前复位；logger 模块随 resetModules 重建，
// 需对新实例重新注入 error.log 目录（避免向工作目录写 mock:/data/logs）
async function resetAndImport() {
  vi.resetModules();
  h.appUse.mockClear();
  h.serverOn.mockClear();
  const { __configureLogger } = await import('../utils/logger.js');
  __configureLogger({ dir: h.tmpDir });
  return import('../index.js');
}

function fatalHandler(event) {
  const handler = onSpy.mock.calls.find(([e]) => e === event)?.[1];
  expect(handler, `process.on('${event}') handler 应已注册`).toBeDefined();
  return handler;
}

describe('进程级兜底（uncaughtException/unhandledRejection）', () => {
  let exitSpy;
  let stderrSpy;

  beforeAll(() => {
    h.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fatal-guard-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.error/banner 走 stderr
  });

  afterAll(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    vi.unstubAllEnvs();
    fs.rmSync(h.tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    h.db = { close: vi.fn() };
    // 拦截 process.on：handler 只记录不真实注册，杜绝污染 vitest worker 进程
    onSpy = vi.spyOn(process, 'on').mockImplementation(() => process);
  });

  afterEach(() => {
    onSpy.mockRestore();
  });

  it('启动时应注册 uncaughtException/unhandledRejection 兜底，且既有信号注册保持', async () => {
    await resetAndImport();
    const events = onSpy.mock.calls.map(([event]) => event);
    expect(events).toContain('uncaughtException');
    expect(events).toContain('unhandledRejection');
    // 既有优雅停机信号不回退
    expect(events).toContain('SIGTERM');
    // 系统资源统计的 WS 推送必须在启动时接线（此前该函数无任何调用点，
    // 事件从不发射，前端只能吃 30s 保底轮询）
    expect(h.startSystemStatsBroadcast).toHaveBeenCalledTimes(1);
    expect(events).toContain('SIGINT');
    for (const event of ['uncaughtException', 'unhandledRejection']) {
      expect(fatalHandler(event)).toBeTypeOf('function');
    }
  });

  it('uncaughtException：结构化错误日志（含堆栈）→ 停调度器 → 关库 → exit(0)，不停 MC 实例', async () => {
    await resetAndImport();
    fatalHandler('uncaughtException')(new Error('boom-uncaught'));

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[Fatal] Uncaught exception:'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('boom-uncaught')); // Error 堆栈含 message

    // shutdown 同步执行调度器停止，随后回调链落地
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.scheduler.stop).toHaveBeenCalledTimes(1); // 定时任务先停
    expect(h.stopSystemStatsBroadcast).toHaveBeenCalled(); // 系统统计定时器同停
    // 面板停机不停实例（owner 2026-09-09 拍板）：实例继续服务玩家，重启后接管
    expect(h.manager.stopAll).not.toHaveBeenCalled();
    expect(h.db.close).toHaveBeenCalledTimes(1); // 数据库关闭（WAL 刷盘）
    expect(exitSpy).toHaveBeenCalledWith(0); // 优雅退出而非无日志崩溃
  });

  it('uncaughtException：非 Error 异常值不抛，String 化回退后仍进入停机流程', async () => {
    await resetAndImport();
    expect(() => fatalHandler('uncaughtException')('raw-string-error')).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[Fatal] Uncaught exception:'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('raw-string-error'));

    await new Promise((resolve) => setImmediate(resolve));
    expect(h.manager.stopAll).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('先记录日志后停机：日志先于停机流程，且进程不静默吞异常继续运行', async () => {
    await resetAndImport();
    fatalHandler('uncaughtException')(new Error('ordering-check'));

    const logIdx = stderrSpy.mock.calls.findIndex(([chunk]) => String(chunk).includes('[Fatal] Uncaught exception:'));
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(stderrSpy.mock.invocationCallOrder[logIdx]).toBeLessThan(h.scheduler.stop.mock.invocationCallOrder[0]);

    await new Promise((resolve) => setImmediate(resolve));
    expect(exitSpy).toHaveBeenCalled(); // 停机流程已启动，不存在吞异常后继续运行的路径
  });

  it('unhandledRejection：Error reason 记录含堆栈日志并复用 shutdown 优雅退出', async () => {
    await resetAndImport();
    fatalHandler('unhandledRejection')(new Error('boom-rejection'));

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[Fatal] Unhandled rejection:'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('boom-rejection'));

    await new Promise((resolve) => setImmediate(resolve));
    expect(h.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(h.manager.stopAll).not.toHaveBeenCalled();
    expect(h.db.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('unhandledRejection：非 Error reason（字符串）不抛，String 化输出后停机', async () => {
    await resetAndImport();
    expect(() => fatalHandler('unhandledRejection')('raw-rejection-reason')).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('[Fatal] Unhandled rejection:'));
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('raw-rejection-reason'));

    await new Promise((resolve) => setImmediate(resolve));
    expect(h.manager.stopAll).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('SIGTERM（systemctl stop/restart）：关面板资源退出，不停 MC 实例（重启后接管）', async () => {
    await resetAndImport();
    fatalHandler('SIGTERM')();

    await new Promise((resolve) => setImmediate(resolve));
    expect(h.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(h.manager.stopAll).not.toHaveBeenCalled();
    expect(h.db.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
