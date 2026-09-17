import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// ── 模块级共享状态与桩对象 ─────────────────────────────────────
// 全部依赖在下方 vi.mock 为桩：避免 import index.js 时产生真实副作用
// （真实数据库初始化 / 端口监听 / MC 子进程等）。
// 注意：vi.mock 的路径相对于本测试文件，因此源码模块需用 ../ 前缀。
const h = vi.hoisted(() => {
  const appUse = vi.fn();
  const app = { use: appUse, set: vi.fn() };
  const serverOn = vi.fn();
  const server = {
    listen: vi.fn((port, host, cb) => typeof cb === 'function' && cb()),
    on: serverOn,
    close: vi.fn((cb) => typeof cb === 'function' && cb()),
  };
  // SHA-256('mock-strong-key-0123456789abcdef') 预计算
  return {
    apiKeyHash: '98f5a7bec05d6145e649c6edd8f8d27f380d0da515a86ab4f77c5f0f50b56bf6',
    app,
    server,
    serverOn,
    appUse,
    wsOpts: null,
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
    }
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
    host: '127.0.0.1',
    setupToken: '',
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
  },
}));
vi.mock('../services/task_scheduler.js', () => ({
  TaskScheduler: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock('../websocket.js', () => ({ setupWebSocket: vi.fn() }));
vi.mock('../services/webhook.service.js', () => ({ setupWebhookDispatch: vi.fn() }));
vi.mock('../db/index.js', () => ({ initDatabase: vi.fn(), AdminAccountModel: { isConfigured: vi.fn(() => true) } }));
// 启动播种的凭据写盘：本文件绝不触碰真实 .env（生成/写回都让桩可观测）
vi.mock('../utils/credentials.js', () => ({
  // 播种是「生成 + 写回」的单一入口（真实实现见 utils/credentials.js）：
  // 本文件只验证启动流程的处置（用返回值回填内存、失败即退出），
  // 生成/写回本身由 credentials.test.js 在真实文件系统上覆盖
  bootstrapApiKey: vi.fn(() => ({
    apiKey: 'mcck-mock-00000000-00000000-00000000',
    hash: 'a'.repeat(64),
  })),
  isPublicBind: vi.fn(() => false),
}));

// 满足哈希格式的 mock Hash（64 位 hex）
// SHA-256('mock-strong-key-0123456789abcdef') 预计算
const VALID_HASH = '98f5a7bec05d6145e649c6edd8f8d27f380d0da515a86ab4f77c5f0f50b56bf6';

import { bootstrapApiKey, isPublicBind } from '../utils/credentials.js';
import { AdminAccountModel } from '../db/index.js';

// 重新 import index.js 前复位：模块注册表 / use 记录
function resetAndImport() {
  vi.resetModules();
  h.appUse.mockClear();
  return import('../index.js');
}

describe('WebSocketServer maxPayload', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    h.apiKeyHash = VALID_HASH;
  });

  it('WebSocketServer 构造应设置 maxPayload 为 1MB 并保留原 path', async () => {
    await resetAndImport();
    expect(h.wsOpts).not.toBeNull();
    expect(h.wsOpts.path).toBe('/ws');
    expect(h.wsOpts.maxPayload).toBe(1024 * 1024);
  });
});

describe('限流中间件挂载顺序', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    h.apiKeyHash = VALID_HASH;
  });

  it('rateLimit 应先于 authMiddleware，apiKeyRateLimit 应在 authMiddleware 之后', async () => {
    await resetAndImport();
    const mounted = h.appUse.mock.calls.map(([p, mw]) => ({ path: p, mw }));
    const idxRate = mounted.findIndex((m) => m.mw === 'rateLimit-middleware');
    const idxAuth = mounted.findIndex((m) => m.mw === 'auth-middleware');
    const idxApiKey = mounted.findIndex((m) => m.mw === 'apiKeyRateLimit-middleware');

    // 三个中间件都必须已挂载，且挂在 /api/ 路径下
    expect(idxRate).toBeGreaterThanOrEqual(0);
    expect(idxAuth).toBeGreaterThanOrEqual(0);
    expect(idxApiKey).toBeGreaterThanOrEqual(0);
    expect(mounted[idxRate].path).toBe('/api/');
    expect(mounted[idxApiKey].path).toBe('/api/');

    // 关键顺序：IP 全局限流 → 认证 → 按 key 限流
    expect(idxAuth).toBeGreaterThan(idxRate);
    expect(idxApiKey).toBeGreaterThan(idxAuth);
  });
});

describe('安全响应头中间件（helmet）', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    h.apiKeyHash = VALID_HASH;
  });

  it('helmet 中间件应挂在根路径且先于 body 解析器', async () => {
    await resetAndImport();
    // 归一化：app.use(fn) 单参调用视为无路径中间件
    const mounted = h.appUse.mock.calls.map(([p, mw]) =>
      mw === undefined ? { path: undefined, mw: p } : { path: p, mw });
    const idxHelmet = mounted.findIndex((m) => m.mw === 'helmet-middleware');
    const idxJson = mounted.findIndex((m) => m.mw === 'express-json-middleware');

    expect(idxHelmet).toBeGreaterThanOrEqual(0);
    expect(mounted[idxHelmet].path).toBeUndefined();
    expect(idxJson).toBeGreaterThan(idxHelmet);
  });
});

describe('API Key Hash 启动校验', () => {
  describe('公网监听的 SETUP_TOKEN 提示（清单 #32 附带）', () => {
    // 直接拦 stderr 落点（logger.warn 的出口）：vitest 的 resetModules 会让 logger 模块
    // 重新实例化，spy 旧实例收不到新实例的调用
    let warnSpy;
    const warnText = () => warnSpy.mock.calls.map((c) => String(c[0])).join(String.fromCharCode(92) + 'n');

    beforeAll(() => {
      warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterAll(() => {
      warnSpy.mockRestore();
    });
    beforeEach(() => {
      warnSpy.mockClear();
      h.apiKeyHash = VALID_HASH;
      isPublicBind.mockReturnValue(true);
      AdminAccountModel.isConfigured.mockReturnValue(false);
      vi.stubEnv('NODE_ENV', 'development');
    });

    it('对外可达 + 尚未设密 + 未配置 token → 打告警（含修法）', async () => {
      await resetAndImport();
      const text = warnText();
      expect(text).toContain('对外可达');
      expect(text).toContain('SETUP_TOKEN');
      // 告警必须给出可执行修法（不是只报风险）
      expect(text).toContain('openssl rand -hex 32');
    });

    it('已设密 → 不打告警（setup 端点已不可达，没有抢注窗口）', async () => {
      AdminAccountModel.isConfigured.mockReturnValue(true);
      await resetAndImport();
      expect(warnText()).not.toContain('对外可达');
    });

    it('已配置 SETUP_TOKEN → 不打告警', async () => {
      const cfg = (await import('../config.js')).default;
      cfg.setupToken = 'configured-token';
      try {
        await resetAndImport();
        expect(warnText()).not.toContain('对外可达');
      } finally {
        cfg.setupToken = '';
      }
    });

    it('仅本机监听 → 不打告警（本机/可信网络部署的既有便利不被打扰）', async () => {
      isPublicBind.mockReturnValue(false);
      await resetAndImport();
      expect(warnText()).not.toContain('对外可达');
    });
  });

  describe('启动时哈希存在性校验', () => {
    let exitSpy;

    beforeAll(() => {
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    });

    afterAll(() => {
      exitSpy.mockRestore();
      vi.unstubAllEnvs();
    });

    beforeEach(() => {
      exitSpy.mockClear();
      vi.unstubAllEnvs();
    });

    it('无 API Key Hash：服务端签发并写回 .env，不退出', async () => {
      h.apiKeyHash = '';
      bootstrapApiKey.mockClear();
      await resetAndImport();

      // 播种入口收到 .env 路径（写回目标由 config 决定，不写死仓库路径）
      expect(bootstrapApiKey).toHaveBeenCalledTimes(1);
      expect(String(bootstrapApiKey.mock.calls[0][0]).endsWith('.env')).toBe(true);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('无 API Key Hash 且写回失败：横幅报错 + exit(1)（不留「每次重启换一把」的临时凭据）', async () => {
      h.apiKeyHash = '';
      bootstrapApiKey.mockImplementationOnce(() => { throw new Error('EACCES'); });
      await resetAndImport();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('有 API Key Hash 不退出', async () => {
      h.apiKeyHash = VALID_HASH;
      await resetAndImport();
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});

describe('端口占用错误处理（EADDRINUSE）', () => {
  let exitSpy;
  let errorSpy;

  beforeAll(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true); // logger.error 走 stderr
  });

  afterAll(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    exitSpy.mockClear();
    errorSpy.mockClear();
    h.serverOn.mockClear();
    vi.unstubAllEnvs();
    vi.stubEnv('NODE_ENV', 'development');
    h.apiKeyHash = VALID_HASH;
  });

  it('server.listen 前应注册 error 事件监听', async () => {
    await resetAndImport();
    expect(h.serverOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('EADDRINUSE 错误应输出友好提示并以 exit code 1 退出', async () => {
    await resetAndImport();
    const errorHandler = h.serverOn.mock.calls.find(
      ([event]) => event === 'error',
    )?.[1];
    expect(errorHandler).toBeDefined();

    const err = new Error('port in use');
    err.code = 'EADDRINUSE';
    errorHandler(err);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('端口'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('.env'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('非 EADDRINUSE 错误应抛出（不吞掉）', async () => {
    await resetAndImport();
    const errorHandler = h.serverOn.mock.calls.find(
      ([event]) => event === 'error',
    )?.[1];
    expect(errorHandler).toBeDefined();

    const err = new Error('something else');
    expect(() => errorHandler(err)).toThrow('something else');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
