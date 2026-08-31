import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { checkApiKeyStrength } from '../index.js';

// ── 模块级共享状态与桩对象 ─────────────────────────────────────
// 全部依赖在下方 vi.mock 为桩：避免 import index.js 时产生真实副作用
// （真实数据库初始化 / 端口监听 / MC 子进程等）。测试用密钥均为 mock，
// 仅用于验证强度判定逻辑，非真实数据。
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
  return {
    apiKey: 'mock-strong-key-0123456789abcdef',
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
    // getter：测试间可通过 h.apiKey 动态切换，重新 import 后生效
    get apiKey() {
      return h.apiKey;
    },
    port: 1,
    serversDir: 'mock:/servers',
    dataDir: 'mock:/data',
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
vi.mock('../db/index.js', () => ({ initDatabase: vi.fn() }));

// 满足强度规则的 mock 强 Key（≥16 位且非低熵形态）
const STRONG_KEY = 'mock-strong-key-0123456789abcdef';

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
    h.apiKey = STRONG_KEY;
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
    h.apiKey = STRONG_KEY;
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

describe('API Key 强度校验', () => {
  describe('checkApiKeyStrength 纯函数', () => {
    it('强随机 Key 应通过（≥16 位且非低熵形态）', () => {
      expect(checkApiKeyStrength(STRONG_KEY).ok).toBe(true);
      expect(checkApiKeyStrength('Ab3#xK9!qW2@zL7%v').ok).toBe(true);
    });

    it('长度不足 16 位应拒绝', () => {
      const r = checkApiKeyStrength('short-key-123');
      expect(r.ok).toBe(false);
      expect(r.reason).toContain('长度');
    });

    it('纯数字低熵形态应拒绝', () => {
      expect(checkApiKeyStrength('1234567890123456').ok).toBe(false);
    });

    it('纯小写字母低熵形态应拒绝', () => {
      expect(checkApiKeyStrength('abcdefghijklmnop').ok).toBe(false);
    });

    it('纯大写字母低熵形态应拒绝', () => {
      expect(checkApiKeyStrength('ABCDEFGHIJKLMNOP').ok).toBe(false);
    });

    it('纯重复字符低熵形态应拒绝', () => {
      expect(checkApiKeyStrength('aaaaaaaaaaaaaaaa').ok).toBe(false);
      expect(checkApiKeyStrength('1111111111111111').ok).toBe(false);
    });

    it('非字符串输入应拒绝', () => {
      expect(checkApiKeyStrength(undefined).ok).toBe(false);
      expect(checkApiKeyStrength(null).ok).toBe(false);
    });
  });

  describe('启动时强度校验行为', () => {
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

    it('生产环境低熵强度 Key 应 process.exit(1)', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      h.apiKey = '1234567890123456'; // 纯数字低熵
      await resetAndImport();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('生产环境默认弱 Key（精确匹配）应 process.exit(1)', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      h.apiKey = 'mc-commander-default-key';
      await resetAndImport();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('开发环境低熵强度 Key 仅告警不退出', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      h.apiKey = '1234567890123456';
      await resetAndImport();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('生产环境强 Key 不退出', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      h.apiKey = STRONG_KEY;
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
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    h.apiKey = STRONG_KEY;
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
