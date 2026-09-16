/**
 * 只读角色 fail-closed 守卫（HTTP 角色门 + WS 握手拒绝 + 凭据通道语义）。
 *
 * 承重点：不枚举「哪些端点该拦」，而是从 Express **实际注册的路由表**取出全部端点，
 * 断言除显式白名单外一律 403——将来任何新增端点无需改测试即自动纳入覆盖，这正是
 * 「逐个 router / 逐端点加守卫必漏」的解药。白名单自身另有一条逐条钉死的断言，
 * 防止敏感读（文件内容 / 日志 / 配置）被静默加入白名单：只测「非白名单必拒」的
 * 话，把敏感读加进白名单会让它自动跳过，测试反而变绿。
 *
 * 全部写盘面（dataDir / envFilePath）指向 os.tmpdir()，不触碰仓库真实 .env 与数据目录。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsMod = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mcs-readonly-role-'));
  return {
    default: {
      ...actual.default,
      dataDir: tmpRoot,
      envFilePath: path.join(tmpRoot, '.env'),
      // 两个通道开关的初值必须钉死：真实 config 从部署机 .env 解析，
      // 关掉通道的机器上跑全量会假红
      apiKeyEnabled: true,
      readonlyApiKeyEnabled: true,
    },
  };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminSessionModel } from '../db/admin.model.js';
import {
  authMiddleware,
  authenticateWebSocket,
  isReadonlyAllowed,
  requireAdminRole,
  READONLY_ALLOWED,
  PUBLIC_ENDPOINTS,
} from '../middleware/auth.js';
import { createApiV1Router, setupRoutes, API_V1_MOUNT } from '../routes/index.js';
import { errorHandler } from '../middleware/error_handler.js';
import { hashToken, generateSessionToken } from '../utils/password.js';
import { ErrorCodes } from '../utils/response.js';

const ADMIN_KEY = 'test-api-key-for-unit-tests';
const READONLY_KEY = 'readonly-test-key-for-unit-tests';
const READONLY_HASH = hashToken(READONLY_KEY);

/** 白名单的预期内容逐条钉死：改动必须是有意为之并同步更新本测试 */
const EXPECTED_READONLY_ALLOWED = [
  'GET /instances',
  'GET /instances/:id',
  'GET /instances/:id/players',
  'GET /overview',
  'GET /system-stats',
];

/** 认证前必须可达的公开端点（角色门不得把它们变成 401/403），相对 v1Router 的路径形式 */
const PUBLIC_V1 = new Set([...PUBLIC_ENDPOINTS].map((p) => p.replace(/^\/v1/, '')));

/** 敏感读：逐条显式列出，白名单被偷偷扩张时由本表兜住 */
const SENSITIVE_READS = [
  'GET /instances/probe/files',
  'GET /instances/probe/files/content',
  'GET /instances/probe/files/download',
  'GET /instances/probe/logs',
  'GET /instances/probe/properties',
  'GET /instances/probe/world',
  'GET /instances/probe/tasks',
  'GET /instances/probe/plugins',
  'GET /instances/probe/upgrade/status',
  'GET /backups/probe',
  'GET /backups/probe/download',
  'GET /command-history',
  'GET /audit-logs',
  'GET /auth/sessions',
  'GET /auth/capabilities',
  'GET /auth/totp/status',
  'GET /tasks',
  'GET /tasks/probe',
  'GET /tasks/probe/history',
  'GET /webhooks',
  'GET /webhooks/probe',
  'GET /webhooks/probe/deliveries',
];

/** 路由表里的 :param 段替换为具体值，得到可直接请求的 URL */
function concreteUrl(pattern) {
  return pattern.replace(/:[A-Za-z0-9_]+/g, 'probe');
}

/**
 * 枚举路由表全部已注册端点。子 router 一律挂载在 '/'（/api/v1 路径空间扁平，
 * 见 routes/index.js）——用该层自身的 matcher 断言这一前提，挂到别处会让枚举
 * 立刻失准而不是静默漏项。
 */
function enumerateEndpoints(router) {
  const found = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        const pattern = prefix + layer.route.path;
        for (const method of Object.keys(layer.route.methods)) {
          if (layer.route.methods[method]) {
            found.push({ method: method.toUpperCase(), pattern });
          }
        }
      } else if (layer.handle?.stack) {
        expect(
          layer.matchers?.[0]?.('/') ?? false,
          '子 router 必须挂载在 "/"，否则枚举前缀失准'
        ).toBeTruthy();
        walk(layer.handle.stack, prefix);
      }
    }
  };
  walk(router.stack, '');
  return found;
}

let app;
let endpoints;
let db;

beforeAll(() => {
  db = initDatabase();
  // 全局阻断出网：路由表逐端点遍历会真实进入管理员的处理链路，
  // /check-update 与 /versions 会外呼（离线降级虽可用，但测试不应依赖网络）
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ version: '0.0.0-test' }) })));
  const stubManager = {
    instances: new Map(),
    getAllInstances: () => [],
    // 未提供实例：白名单内的 :id 端点走到业务层会 404，但角色门已放行——
    // 反向对照断言「不是 401/403」而非「必须 200」，与业务数据无关
    getInstance: () => null,
  };
  const v1Router = createApiV1Router(stubManager, {});
  endpoints = enumerateEndpoints(v1Router);

  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use(API_V1_MOUNT, v1Router);
  app.use(errorHandler);
});

afterAll(() => {
  vi.unstubAllGlobals();
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

const originalApiKeyEnabled = config.apiKeyEnabled;
const originalReadonlyApiKeyEnabled = config.readonlyApiKeyEnabled;
const originalReadonlyApiKeyHash = config.readonlyApiKeyHash;
const originalApiKeyHash = config.apiKeyHash;

beforeEach(() => {
  db.prepare('DELETE FROM admin_sessions').run();
  config.apiKeyEnabled = originalApiKeyEnabled;
  config.readonlyApiKeyEnabled = originalReadonlyApiKeyEnabled;
  config.readonlyApiKeyHash = READONLY_HASH;
  config.apiKeyHash = hashToken(ADMIN_KEY);
});

afterEach(() => {
  config.apiKeyEnabled = originalApiKeyEnabled;
  config.readonlyApiKeyEnabled = originalReadonlyApiKeyEnabled;
  config.readonlyApiKeyHash = originalReadonlyApiKeyHash;
  config.apiKeyHash = originalApiKeyHash;
});

const asReadonly = (method, url) =>
  request(app)[method.toLowerCase()](url).set('X-API-Key', READONLY_KEY);

function seedSession() {
  const token = generateSessionToken();
  AdminSessionModel.create({
    tokenHash: hashToken(token),
    userAgent: 'vitest-readonly-role',
    ip: '127.0.0.1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return token;
}

describe('路由表枚举本身（结构性前提）', () => {
  it('枚举到全部已注册端点且数量不低于现状（枚举空转会让下面的断言假绿）', () => {
    // 现网 /api/v1 下 87 个端点（另有 app 级未认证 /health，不在 v1Router 管辖范围）
    expect(endpoints.length).toBe(87);
    expect(new Set(endpoints.map((e) => `${e.method} ${e.pattern}`)).size).toBe(87);
    // 三个公开端点在册（下方豁免逻辑依赖它们存在）
    expect(PUBLIC_V1).toEqual(new Set(['/auth/status', '/auth/login', '/auth/setup']));
  });

  it('白名单逐条与预期一致，且每条都对应一个真实注册端点（防笔误/防静默扩张）', () => {
    expect([...READONLY_ALLOWED].sort()).toEqual([...EXPECTED_READONLY_ALLOWED].sort());
    for (const entry of READONLY_ALLOWED) {
      const [method, pattern] = entry.split(' ');
      expect(
        endpoints.some((e) => e.method === method && e.pattern === pattern),
        `白名单项 ${entry} 未匹配任何已注册端点`
      ).toBe(true);
    }
  });
});

describe('结构性默认拒绝：非白名单端点对只读凭据一律 403', () => {
  it('遍历全部已注册端点：仅公开端点与白名单放行，其余 403/40305', async () => {
    const leaked = [];
    const reached = [];
    let denied = 0;

    for (const { method, pattern } of endpoints) {
      const url = API_V1_MOUNT + concreteUrl(pattern);
      if (PUBLIC_V1.has(pattern)) {
        // 公开端点在认证层即放行（req.auth 缺失），角色门不得改判 401/403
        const res = await asReadonly(method, url);
        if (res.status === 401 || res.status === 403) {
          leaked.push(`${method} ${pattern} -> 公开端点被角色门拦成 ${res.status}`);
        }
        continue;
      }
      const res = await asReadonly(method, url);
      if (isReadonlyAllowed(method, concreteUrl(pattern))) {
        if (res.status === 401 || res.status === 403) {
          leaked.push(`${method} ${pattern} -> 白名单端点被拒 ${res.status}`);
        } else {
          reached.push(`${method} ${pattern} -> ${res.status}`);
        }
      } else if (res.status === 403 && res.body.code === ErrorCodes.AUTH_INSUFFICIENT_ROLE.code) {
        denied += 1;
      } else {
        leaked.push(`${method} ${pattern} -> 未拦截，返回 ${res.status}/${res.body.code}`);
      }
    }

    expect(leaked, `越权可达: ${leaked.join('; ')}`).toEqual([]);
    // 承重证据：端点账目必须闭合——公开豁免 + 白名单放行 + 其余拒绝 = 全部已注册端点
    expect(denied).toBe(endpoints.length - PUBLIC_V1.size - EXPECTED_READONLY_ALLOWED.length);
    expect(reached.length).toBe(EXPECTED_READONLY_ALLOWED.length);
  });

  it('敏感读逐条 403：文件族 / 日志 / 配置 / 世界 / 备份 / 命令史 / 审计 / 会话 / 任务定义', async () => {
    for (const entry of SENSITIVE_READS) {
      const [method, path] = entry.split(' ');
      const res = await asReadonly(method, API_V1_MOUNT + path);
      expect(res.status, `${entry} 应被拒绝`).toBe(403);
      expect(res.body.code, `${entry} 错误码`).toBe(ErrorCodes.AUTH_INSUFFICIENT_ROLE.code);
    }
  });

  it('写操作对只读凭据一律 403（含只读凭据自我轮换）', async () => {
    // 公开端点含两条写（login/setup）：它们在认证层即放行、不带角色，不属角色门裁决面
    const writes = endpoints.filter(
      (e) => e.method !== 'GET' && !PUBLIC_V1.has(e.pattern)
    );
    expect(writes.length).toBeGreaterThan(40);
    for (const { method, pattern } of writes) {
      const res = await asReadonly(method, API_V1_MOUNT + concreteUrl(pattern));
      expect(`${method} ${pattern} -> ${res.status}/${res.body.code}`).toBe(
        `${method} ${pattern} -> 403/${ErrorCodes.AUTH_INSUFFICIENT_ROLE.code}`
      );
    }
  });
});

describe('只读凭据的放行面（反向对照：全拒也能假绿）', () => {
  it('白名单端点放行：概览/系统指标/实例列表 200，其余不是 401/403', async () => {
    for (const entry of ['GET /overview', 'GET /system-stats', 'GET /instances']) {
      const [method, path] = entry.split(' ');
      const res = await asReadonly(method, API_V1_MOUNT + path);
      expect(res.status, `${entry} 应对只读凭据放行`).toBe(200);
      expect(res.body.status).toBe('ok');
    }

    for (const entry of READONLY_ALLOWED) {
      const [method, pattern] = entry.split(' ');
      const res = await asReadonly(method, API_V1_MOUNT + concreteUrl(pattern));
      expect(res.status, `${entry} 不应被角色门拒绝`).not.toBe(403);
      expect(res.status, `${entry} 不应被判未认证`).not.toBe(401);
    }
  });

  it('只读响应体不含任何凭据/哈希/白名单内容', async () => {
    const res = await asReadonly('GET', `${API_V1_MOUNT}/overview`);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(READONLY_KEY);
    expect(raw).not.toContain(READONLY_HASH);
    expect(raw).not.toContain(ADMIN_KEY);
  });
});

describe('拒绝语义与信息暴露', () => {
  it('403（不是 401）+ 错误信封 + 不回显请求路径/凭据/哈希', async () => {
    const res = await asReadonly('GET', `${API_V1_MOUNT}/instances/probe/files/content`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      status: 'error',
      code: ErrorCodes.AUTH_INSUFFICIENT_ROLE.code,
      message: ErrorCodes.AUTH_INSUFFICIENT_ROLE.message,
      details: null,
    });
    expect(typeof res.body.timestamp).toBe('string');

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(READONLY_KEY);
    expect(raw).not.toContain(READONLY_HASH);
    expect(raw).not.toContain('/instances/probe/files/content');
    expect(raw).not.toContain('READONLY_ALLOWED');
  });

  it('只读凭据访问未注册路径同样 403（不给资源枚举面）', async () => {
    const res = await asReadonly('GET', `${API_V1_MOUNT}/no-such-endpoint`);
    expect(res.status).toBe(403);
  });

  it('尾斜杠归一化不放宽权限面：/instances/ 与 /instances 同判，路径变体一律 403', async () => {
    // 与 Express 路由 strict:false 一致：两条路径命中同一个已授权处理器
    const withSlash = await asReadonly('GET', `${API_V1_MOUNT}/instances/`);
    const withoutSlash = await asReadonly('GET', `${API_V1_MOUNT}/instances`);
    expect(withoutSlash.status).toBe(200);
    expect(withSlash.status).toBe(withoutSlash.status);
    expect(withSlash.body.data).toEqual(withoutSlash.body.data);

    // 大小写、额外段、空段（//）都不是同一个处理器，必须拒绝
    for (const path of [
      '/instances//probe/logs',
      '/instances//players',
      '/INSTANCES',
      '/Overview',
      '/overview/extra',
      '/instances/probe/logs/',
      '/tasks/../audit-logs',
      '/instances/%2e%2e/audit-logs',
    ]) {
      const res = await asReadonly('GET', API_V1_MOUNT + path);
      expect(`${path} -> ${res.status}/${res.body.code}`).toBe(
        `${path} -> 403/${ErrorCodes.AUTH_INSUFFICIENT_ROLE.code}`
      );
    }
  });
});

describe('凭据通道与角色赋值', () => {
  it('管理员 API Key → admin 角色且不被角色门拦（既有行为零变化）', async () => {
    for (const { method, pattern } of endpoints) {
      const url = API_V1_MOUNT + concreteUrl(pattern);
      // 两个轮换端点会真实改写内存中的哈希（并把新哈希写进临时 .env），
      // 逐请求快照/还原，避免遍历途中把自己那把 Key 换掉而使后续请求全部 401
      const savedApiKeyHash = config.apiKeyHash;
      const savedReadonlyKeyHash = config.readonlyApiKeyHash;
      let res;
      try {
        res = await request(app)[method.toLowerCase()](url).set('X-API-Key', ADMIN_KEY);
      } finally {
        config.apiKeyHash = savedApiKeyHash;
        config.readonlyApiKeyHash = savedReadonlyKeyHash;
      }
      expect(`${method} ${pattern} -> ${res.status}`).not.toBe(`${method} ${pattern} -> 401`);
      expect(res.body.code, `${method} ${pattern} 被角色门拒绝`).not.toBe(
        ErrorCodes.AUTH_INSUFFICIENT_ROLE.code
      );
    }
  });

  it('管理员会话 → admin 角色且可读敏感端点；公开端点仍可达', async () => {
    const token = seedSession();
    const authed = (method, url) =>
      request(app)[method.toLowerCase()](url).set('Authorization', `Bearer ${token}`);

    expect((await authed('GET', `${API_V1_MOUNT}/audit-logs`)).status).toBe(200);
    expect((await authed('GET', `${API_V1_MOUNT}/command-history`)).status).toBe(200);
    expect((await authed('GET', `${API_V1_MOUNT}/auth/sessions`)).status).toBe(200);

    // 公开端点：认证层显式标记 role=public，角色门据角色放行；带/不带凭据都不得变成 401/403
    expect((await authed('GET', `${API_V1_MOUNT}/auth/status`)).status).toBe(200);
    expect((await request(app).get(`${API_V1_MOUNT}/auth/status`)).status).toBe(200);
  });

  it('两条既有通道的角色均为 admin（role 字段落点）', async () => {
    const app2 = express();
    app2.use('/api/', authMiddleware);
    app2.get('/api/v1/role-probe', (req, res) => res.json({ auth: req.auth ?? null }));

    const viaKey = await request(app2).get('/api/v1/role-probe').set('X-API-Key', ADMIN_KEY);
    expect(viaKey.body.auth).toMatchObject({ source: 'apiKey', role: 'admin' });

    const viaSession = await request(app2)
      .get('/api/v1/role-probe')
      .set('Authorization', `Bearer ${seedSession()}`);
    expect(viaSession.body.auth).toMatchObject({ source: 'session', role: 'admin' });

    const viaReadonly = await request(app2).get('/api/v1/role-probe').set('X-API-Key', READONLY_KEY);
    expect(viaReadonly.body.auth).toMatchObject({ source: 'apiKey', role: 'readonly' });

    // 公开端点由认证层显式标记 role=public：不再靠「req.auth 缺失」表达放行
    const publicProbe = express();
    publicProbe.use('/api/', authMiddleware);
    publicProbe.get('/api/v1/auth/status', (req, res) => res.json({ auth: req.auth ?? null }));
    const pub = await request(publicProbe).get('/api/v1/auth/status');
    expect(pub.body.auth).toEqual({ source: 'public', role: 'public' });
  });

  it('角色门只认显式角色：无 req.auth（未经认证层）一律 403，不再默认放行', async () => {
    // ① 直接单测中间件：模拟「v1Router 被挂到没有认证层的组装路径」
    const middlewareApp = express();
    middlewareApp.use(API_V1_MOUNT, createApiV1Router({ instances: new Map() }, {}));
    const viaRouter = await request(middlewareApp).get(`${API_V1_MOUNT}/overview`);
    expect(viaRouter.status).toBe(403);
    expect(viaRouter.body.code).toBe(ErrorCodes.AUTH_INSUFFICIENT_ROLE.code);

    // ② 单元级：req.auth 为 undefined / null / 空对象 都必须拒绝
    const calls = [];
    const res = {
      status(code) { calls.push(code); return this; },
      json(body) { calls.push(body.code); return this; },
    };
    for (const auth of [undefined, null, {}, { source: 'apiKey' }, { role: 'unknown' }]) {
      calls.length = 0;
      const next = vi.fn();
      requireAdminRole({ auth, method: 'GET', path: '/overview' }, res, next);
      expect(next, `req.auth=${JSON.stringify(auth)} 不应放行`).not.toHaveBeenCalled();
      expect(calls[0]).toBe(403);
      expect(calls[1]).toBe(ErrorCodes.AUTH_INSUFFICIENT_ROLE.code);
    }

    // ③ 反向对照：显式 admin / public 放行，readonly 命中白名单放行
    for (const auth of [{ role: 'admin' }, { role: 'public' }]) {
      const next = vi.fn();
      requireAdminRole({ auth, method: 'GET', path: '/audit-logs' }, res, next);
      expect(next, `role=${auth.role} 应放行`).toHaveBeenCalled();
    }
    const nextReadonly = vi.fn();
    requireAdminRole({ auth: { role: 'readonly' }, method: 'GET', path: '/instances' }, res, nextReadonly);
    expect(nextReadonly).toHaveBeenCalled();
  });

  it('GET /health（app 级、不在 /api/ 下）不经角色门：仍返回 200', async () => {
    const healthApp = express();
    healthApp.use('/api/', authMiddleware);
    setupRoutes(healthApp, { instances: new Map(), getAllInstances: () => [], getInstance: () => null }, {});
    const res = await request(healthApp).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('只读凭据在管理员 Key 通道关闭时仍可用（两通道开关相互独立）', async () => {
    config.apiKeyEnabled = false;
    expect((await asReadonly('GET', `${API_V1_MOUNT}/overview`)).status).toBe(200);
    // 管理员 Key 通道关闭语义不变：携带管理员 Key 仍是 403/40303
    const adminRes = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', ADMIN_KEY);
    expect(adminRes.status).toBe(403);
    expect(adminRes.body.code).toBe(ErrorCodes.API_KEY_DISABLED.code);
  });
});

describe('只读通道关闭（READONLY_API_KEY_ENABLED=false）', () => {
  it('携带只读凭据 403/40304，且不因关闭而放行为管理员', async () => {
    config.readonlyApiKeyEnabled = false;
    const res = await asReadonly('GET', `${API_V1_MOUNT}/overview`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCodes.READONLY_API_KEY_DISABLED.code);
    expect(JSON.stringify(res.body)).not.toContain(READONLY_KEY);

    // 关闭的是通道而非「降级为管理员」：敏感读仍不可达（先吃 40304）
    const sensitive = await asReadonly('GET', `${API_V1_MOUNT}/audit-logs`);
    expect(sensitive.status).toBe(403);
  });

  it('管理员通道不受影响，且只读关闭不影响未配置只读哈希的部署路径', async () => {
    config.readonlyApiKeyEnabled = false;
    const adminRes = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', ADMIN_KEY);
    expect(adminRes.status).toBe(200);

    config.readonlyApiKeyHash = '';
    const adminRes2 = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', ADMIN_KEY);
    expect(adminRes2.status).toBe(200);
  });
});

describe('未配置只读 Key：该通道不存在（负向对照）', () => {
  beforeEach(() => {
    config.readonlyApiKeyHash = '';
  });

  it('任意值（含曾用只读值、空串）都拿不到 readonly 权限，也不是管理员', async () => {
    for (const value of [READONLY_KEY, '', 'mcro-00000000-00000000-00000000', ADMIN_KEY + 'x']) {
      const res = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', value);
      expect(res.status, `只读哈希未配置时 ${JSON.stringify(value)} 不应被接受`).toBe(401);
      expect(res.body.code).toBe(ErrorCodes.INVALID_API_KEY.code);
    }
  });

  it('管理员 Key 行为与今天完全一致（未配置只读键不改变既有通道）', async () => {
    const res = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');

    const bad = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', 'wrong-key');
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe(ErrorCodes.INVALID_API_KEY.code);
  });

  it('空哈希不会与空输入恒等而放行（verify 侧先判 storedHash 存在性）', async () => {
    config.apiKeyHash = '';
    const res = await request(app).get(`${API_V1_MOUNT}/overview`).set('X-API-Key', '');
    expect(res.status).toBe(401);
    config.apiKeyHash = hashToken(ADMIN_KEY);
  });
});

describe('WebSocket 握手', () => {
  it('只读凭据一律拒绝握手（能开 WS 即等于能执行命令）', () => {
    expect(authenticateWebSocket(READONLY_KEY, null)).toBe(false);
    // 同时给出会话令牌也不回退（与关闭通道同款 fail-closed）
    expect(authenticateWebSocket(READONLY_KEY, seedSession())).toBe(false);
    // 通道关闭时同样拒绝
    config.readonlyApiKeyEnabled = false;
    expect(authenticateWebSocket(READONLY_KEY, null)).toBe(false);
  });

  it('管理员 API Key 与会话令牌照常可握手（既有行为不变）', () => {
    expect(authenticateWebSocket(ADMIN_KEY, null)).toBe(true);
    expect(authenticateWebSocket(null, seedSession())).toBe(true);
    expect(authenticateWebSocket('wrong-key', null)).toBe(false);
  });

  it('未配置只读哈希时凭据不会被误当管理员 Key', () => {
    config.readonlyApiKeyHash = '';
    expect(authenticateWebSocket(READONLY_KEY, null)).toBe(false);
    expect(authenticateWebSocket(ADMIN_KEY, null)).toBe(true);
  });
});
