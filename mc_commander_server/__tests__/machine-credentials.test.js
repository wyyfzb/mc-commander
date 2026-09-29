/**
 * 作用域化机器凭据的端到端行为（HTTP 层）。
 *
 * 与 `readonly-role-guard.test.js` 的分工：那份锁**既有 `.env` 只读通道**的结构性默认
 * 拒绝（端点账目 + 白名单逐条钉死）；本份锁**新增的台账凭据**——它多出「名字 /
 * 作用域 / 启停 / 吊销」四个维度，而这四个维度正是「给 AI 限权」的全部承重面。
 *
 * 断言重点不是「接口能跑」，而是四条安全不变量：
 * 1. 只读三档**逐档**生效（持 instance:read 打不开 player 端点）
 * 2. 停用/吊销**立即**失效（热路径查询条件里排除，而非查回来再判）
 * 3. 明文只在创建那一次出现（列表/自检恒不含明文与摘要）
 * 4. 受限凭据**无法自我提权**（管理端点对它一律 403）
 *
 * 全部写盘面（dataDir / envFilePath）指向 os.tmpdir()，不触碰仓库真实 .env 与数据目录。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fsMod = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mcs-machine-cred-'));
  return {
    default: {
      ...actual.default,
      dataDir: tmpRoot,
      envFilePath: path.join(tmpRoot, '.env'),
      apiKeyEnabled: true,
      readonlyApiKeyEnabled: true,
    },
  };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { MachineCredentialModel } from '../db/machine_credential.model.js';
import { authMiddleware } from '../middleware/auth.js';
import { createApiV1Router, API_V1_MOUNT } from '../routes/index.js';
import { errorHandler } from '../middleware/error_handler.js';
import { hashToken } from '../utils/password.js';
import { ErrorCodes } from '../utils/response.js';
import { SCOPES } from '../utils/scopes.js';

const ADMIN_KEY = 'admin-test-key-for-machine-credential-tests';
const READONLY_KEY = 'readonly-test-key-for-machine-credential-tests';

let app;
let db;

/** 直接建一条台账凭据，返回 { id, token }（绕过 HTTP 以便聚焦被测行为） */
function seedCredential({
  name = '测试凭据',
  scopes = [SCOPES.INSTANCE_READ],
  enabled = true,
} = {}) {
  // token 必须是纯 ASCII：它要放进 X-API-Key 头，中文名进 header 会被 Node 拒绝
  // （Invalid character in header content），故名字不参与 token 构造
  const token = `mcs-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  const created = MachineCredentialModel.create({
    name,
    tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 12),
    scopes,
  });
  if (!enabled) MachineCredentialModel.setEnabled(created.id, false);
  return { id: created.id, token };
}

const asKey = (method, url, key) => request(app)[method.toLowerCase()](url).set('X-API-Key', key);

beforeAll(() => {
  db = initDatabase();
  const stubManager = {
    instances: new Map(),
    getAllInstances: () => [],
    getInstance: () => null,
  };
  const v1Router = createApiV1Router(stubManager, {});

  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use(API_V1_MOUNT, v1Router);
  app.use(errorHandler);

  config.apiKeyHash = hashToken(ADMIN_KEY);
  config.readonlyApiKeyHash = hashToken(READONLY_KEY);
});

afterAll(() => {
  db?.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM machine_credentials').run();
});

describe('作用域逐档生效（持什么档就只能进哪些门）', () => {
  it('instance:read → 可读实例列表与单实例，打不开玩家端点', async () => {
    const { token } = seedCredential({ scopes: [SCOPES.INSTANCE_READ] });

    const list = await asKey('GET', '/api/v1/instances', token);
    expect(list.status, 'instance:read 应能读实例列表').not.toBe(403);

    const one = await asKey('GET', '/api/v1/instances/probe', token);
    expect(one.status, 'instance:read 应能读单实例').not.toBe(403);

    const players = await asKey('GET', '/api/v1/instances/probe/players', token);
    expect(players.status, 'instance:read 不得读玩家端点').toBe(403);
    expect(players.body.code).toBe(ErrorCodes.AUTH_INSUFFICIENT_ROLE.code);
  });

  it('player:read → 可读玩家端点，但打不开实例列表（档位是并列的，不是包含关系）', async () => {
    const { token } = seedCredential({ scopes: [SCOPES.PLAYER_READ] });

    const players = await asKey('GET', '/api/v1/instances/probe/players', token);
    expect(players.status).not.toBe(403);

    const list = await asKey('GET', '/api/v1/instances', token);
    expect(list.status, 'player:read 不含 instance:read').toBe(403);
  });

  it('system:read → 可读概览与系统指标，越不过实例端点', async () => {
    const { token } = seedCredential({ scopes: [SCOPES.SYSTEM_READ] });

    const overview = await asKey('GET', '/api/v1/overview', token);
    expect(overview.status).not.toBe(403);

    const stats = await asKey('GET', '/api/v1/system-stats', token);
    expect(stats.status).not.toBe(403);

    const list = await asKey('GET', '/api/v1/instances', token);
    expect(list.status).toBe(403);
  });

  it('三档全持 → 三项都通（反向对照：不会因为多持有而互斥）', async () => {
    const { token } = seedCredential({
      scopes: [SCOPES.SYSTEM_READ, SCOPES.INSTANCE_READ, SCOPES.PLAYER_READ],
    });
    for (const url of [
      '/api/v1/overview',
      '/api/v1/system-stats',
      '/api/v1/instances',
      '/api/v1/instances/probe',
      '/api/v1/instances/probe/players',
    ]) {
      const res = await asKey('GET', url, token);
      expect(res.status, `${url} 应放行`).not.toBe(403);
    }
  });
});

describe('受限凭据无法自我提权', () => {
  it('管理端点（列表/创建/启停/吊销）对台账凭据一律 403', async () => {
    const { token } = seedCredential({
      scopes: [...[SCOPES.SYSTEM_READ, SCOPES.INSTANCE_READ, SCOPES.PLAYER_READ]],
    });

    const probes = [
      ['GET', '/api/v1/machine-credentials'],
      ['POST', '/api/v1/machine-credentials'],
      ['PUT', '/api/v1/machine-credentials/some-id/enabled'],
      ['DELETE', '/api/v1/machine-credentials/some-id'],
      ['POST', '/api/v1/rotate-key'],
      ['POST', '/api/v1/rotate-readonly-key'],
    ];
    for (const [method, url] of probes) {
      const res = await asKey(method, url, token);
      expect(res.status, `${method} ${url} 不该被受限凭据访问`).toBe(403);
    }
  });

  it('敏感读端点对台账凭据一律 403（文件/日志/审计/命令史/任务/备份）', async () => {
    const { token } = seedCredential({
      scopes: [SCOPES.SYSTEM_READ, SCOPES.INSTANCE_READ, SCOPES.PLAYER_READ],
    });
    for (const url of [
      '/api/v1/instances/probe/files',
      '/api/v1/instances/probe/logs',
      '/api/v1/instances/probe/properties',
      '/api/v1/instances/probe/tasks',
      '/api/v1/instances/probe/plugins',
      '/api/v1/command-history',
      '/api/v1/audit-logs',
      '/api/v1/backups/probe',
      '/api/v1/auth/sessions',
    ]) {
      const res = await asKey('GET', url, token);
      expect(res.status, `${url} 应被拒绝`).toBe(403);
    }
  });
});

describe('身份自省面（免作用域）', () => {
  it('台账凭据可读到自己的名字与作用域', async () => {
    const { token } = seedCredential({ name: '我的AI', scopes: [SCOPES.INSTANCE_READ] });
    const res = await asKey('GET', '/api/v1/machine-credentials/self', token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      role: 'readonly',
      name: '我的AI',
      scopes: [SCOPES.INSTANCE_READ],
    });
  });

  it('自省响应不含明文与摘要（防自省面变成凭据泄漏面）', async () => {
    const { token } = seedCredential({ scopes: [SCOPES.INSTANCE_READ] });
    const res = await asKey('GET', '/api/v1/machine-credentials/self', token);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(token);
    expect(body).not.toContain(hashToken(token));
    expect(body).not.toContain('tokenHash');
  });

  it('空作用域凭据也可自省（它需要能问出「我什么都做不了」）', async () => {
    const token = 'mcs-empty-scope-probe';
    MachineCredentialModel.create({
      name: '空权限',
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 12),
      scopes: [],
    });
    const res = await asKey('GET', '/api/v1/machine-credentials/self', token);
    expect(res.status).toBe(200);
    expect(res.body.data.scopes).toEqual([]);
  });

  it('管理员用自省面时报 role=admin 且 scopes 为空（不谎报「管理员也只有这三项」）', async () => {
    const res = await asKey('GET', '/api/v1/machine-credentials/self', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('admin');
    expect(res.body.data.scopes).toEqual([]);
  });

  it('.env 只读固定通道自省时报 role=readonly 且持全部只读作用域（既有通道行为不变）', async () => {
    const res = await asKey('GET', '/api/v1/machine-credentials/self', READONLY_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('readonly');
    expect(res.body.data.scopes.sort()).toEqual(
      [SCOPES.SYSTEM_READ, SCOPES.INSTANCE_READ, SCOPES.PLAYER_READ].sort(),
    );
  });
});

describe('停用与吊销立即失效（热路径查询条件里排除）', () => {
  it('停用后同一把 Key 立刻 401（不是「仍可用但记日志」）', async () => {
    const { id, token } = seedCredential({ scopes: [SCOPES.INSTANCE_READ] });
    expect((await asKey('GET', '/api/v1/instances', token)).status).not.toBe(401);

    MachineCredentialModel.setEnabled(id, false);
    const res = await asKey('GET', '/api/v1/instances', token);
    expect(res.status, '停用后必须按无效凭据拒绝').toBe(401);
    expect(res.body.code).toBe(ErrorCodes.INVALID_API_KEY.code);
  });

  it('重新启用后恢复可用（停用可逆，与吊销不同）', async () => {
    const { id, token } = seedCredential({ scopes: [SCOPES.INSTANCE_READ] });
    MachineCredentialModel.setEnabled(id, false);
    expect((await asKey('GET', '/api/v1/instances', token)).status).toBe(401);

    MachineCredentialModel.setEnabled(id, true);
    expect((await asKey('GET', '/api/v1/instances', token)).status).not.toBe(401);
  });

  it('吊销后立刻 401，且重复吊销不再命中（幂等语义由返回值承担）', async () => {
    const { id, token } = seedCredential({ scopes: [SCOPES.INSTANCE_READ] });
    expect(MachineCredentialModel.revoke(id)).toBe(true);
    expect(MachineCredentialModel.revoke(id), '重复吊销应返回 false').toBe(false);

    const res = await asKey('GET', '/api/v1/instances', token);
    expect(res.status).toBe(401);
  });

  it('吊销后行仍在台账里（保留「这把 Key 曾经是谁」的审计线索）', async () => {
    const { id } = seedCredential({ name: '待吊销' });
    MachineCredentialModel.revoke(id);
    expect(MachineCredentialModel.findById(id), '吊销不删行').not.toBe(null);
    expect(MachineCredentialModel.list(), '默认列表不含已吊销').toHaveLength(0);
    expect(MachineCredentialModel.list({ includeRevoked: true })).toHaveLength(1);
  });
});

describe('明文与摘要的出口面（按字段名断言，不靠子串）', () => {
  // 断言**键集合**而非「响应文本不含某个值」：后者的盲区正是本组要防的那类缺陷——
  // 摘要泄漏的形态是「多了一个字段」，而字段名 tokenHash 在 JSON 里只作为键出现，
  // 对它做 not.toContain('tokenHash') 恒为真，测不出多字段。实测：早期版本把
  // tokenHash 漏进了 201 响应，而当时这组用例全绿。

  /** 允许出现在凭据条目里的字段名（严格白名单：多一个就说明有东西漏了） */
  const ALLOWED_ENTRY_KEYS = [
    'createdAt',
    'id',
    'isEnabled',
    'lastUsedAt',
    'name',
    'revokedAt',
    'scopes',
    'tokenPrefix',
  ];

  it('列表条目键集合严格受限（不含摘要、不含明文）', async () => {
    seedCredential({ name: '列表检查', scopes: [SCOPES.INSTANCE_READ] });
    const res = await asKey('GET', '/api/v1/machine-credentials', ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(ALLOWED_ENTRY_KEYS);
  });

  it('创建响应 = 条目字段 + token（且 token 是唯一多出来的那个）', async () => {
    const res = await request(app)
      .post('/api/v1/machine-credentials')
      .set('X-API-Key', ADMIN_KEY)
      .send({ name: '新建凭据', scopes: [SCOPES.INSTANCE_READ] });
    expect(res.status).toBe(201);

    // 摘要绝不出现在出参里——本组最关键的一条（按字段名断言，能抓住「多字段」）
    expect(res.body.data).not.toHaveProperty('tokenHash');
    expect(Object.keys(res.body.data).sort()).toEqual([...ALLOWED_ENTRY_KEYS, 'token'].sort());

    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.token.startsWith('mcs-')).toBe(true);
    expect(res.body.data.scopes).toEqual([SCOPES.INSTANCE_READ]);
  });

  it('落库的是明文摘要而非明文，且该摘要能反查出这条凭据', async () => {
    const res = await request(app)
      .post('/api/v1/machine-credentials')
      .set('X-API-Key', ADMIN_KEY)
      .send({ name: '摘要串校验', scopes: [SCOPES.INSTANCE_READ] });
    const { token } = res.body.data;
    // 存明文等于「只存摘要」的承诺失效
    const raw = db.prepare('SELECT token_hash FROM machine_credentials').get();
    expect(raw.token_hash).not.toBe(token);
    expect(raw.token_hash).toBe(hashToken(token));
    // 且该摘要确实是热路径比对依据（能反查出这条）
    expect(MachineCredentialModel.findActiveByTokenHash(hashToken(token))).not.toBe(null);
  });

  it('创建后该 token 立即可用（明文与落库摘要确实对应）', async () => {
    const res = await request(app)
      .post('/api/v1/machine-credentials')
      .set('X-API-Key', ADMIN_KEY)
      .send({ name: '立即可用', scopes: [SCOPES.INSTANCE_READ] });
    const token = res.body.data.token;
    const used = await asKey('GET', '/api/v1/instances', token);
    expect(used.status, '新建的 Key 应立刻可用').not.toBe(401);
  });

  it('自省响应键集合严格受限（防自省面变成凭据泄漏面）', async () => {
    const { token } = seedCredential({ scopes: [SCOPES.INSTANCE_READ] });
    const res = await asKey('GET', '/api/v1/machine-credentials/self', token);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['name', 'role', 'scopes']);
    expect(res.body.data).not.toHaveProperty('tokenHash');
  });
});

describe('创建入参校验（一期只读、防重名、防超量）', () => {
  it('写作用域/未知作用域一律拒绝（不静默降级成只读）', async () => {
    for (const scopes of [['instance:write'], ['admin:all'], ['instance:read', 'instance:write']]) {
      const res = await request(app)
        .post('/api/v1/machine-credentials')
        .set('X-API-Key', ADMIN_KEY)
        .send({ name: `越权尝试-${scopes.join('_')}`, scopes });
      expect(res.status, `${scopes.join(',')} 应被拒`).toBe(400);
    }
  });

  it('空作用域数组被契约拒绝（无作用域凭据无任何用途，放开只会让人以为建好了）', async () => {
    const res = await request(app)
      .post('/api/v1/machine-credentials')
      .set('X-API-Key', ADMIN_KEY)
      .send({ name: '空作用域', scopes: [] });
    expect(res.status).toBe(400);
  });

  it('同名凭据被拒（名字是辨认「吊销哪一把」的唯一线索）', async () => {
    seedCredential({ name: '重名' });
    const res = await request(app)
      .post('/api/v1/machine-credentials')
      .set('X-API-Key', ADMIN_KEY)
      .send({ name: '重名', scopes: [SCOPES.INSTANCE_READ] });
    expect(res.status).toBe(400);
  });

  it('名称为空被拒', async () => {
    const res = await request(app)
      .post('/api/v1/machine-credentials')
      .set('X-API-Key', ADMIN_KEY)
      .send({ name: '', scopes: [SCOPES.INSTANCE_READ] });
    expect(res.status).toBe(400);
  });
});

describe('启停/吊销端点行为', () => {
  it('停用端点返回更新后的列表', async () => {
    const { id } = seedCredential({ name: '要停用' });
    const res = await request(app)
      .put(`/api/v1/machine-credentials/${id}/enabled`)
      .set('X-API-Key', ADMIN_KEY)
      .send({ isEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.data[0].isEnabled).toBe(false);
  });

  it('不存在的 id → 404（不是静默成功）', async () => {
    const res = await request(app)
      .put('/api/v1/machine-credentials/nope/enabled')
      .set('X-API-Key', ADMIN_KEY)
      .send({ isEnabled: false });
    expect(res.status).toBe(404);

    const del = await request(app)
      .delete('/api/v1/machine-credentials/nope')
      .set('X-API-Key', ADMIN_KEY);
    expect(del.status).toBe(404);
  });
});

describe('WebSocket 握手：机器凭据默认拒绝（fail-closed，不静默升级为只读事件面）', () => {
  it('台账凭据不能建立 WS 连接（HTTP 有作用域、WS 尚无作用域判据 ⇒ 宁拒不放过）', async () => {
    const { authenticateWebSocket } = await import('../middleware/auth.js');
    const { token } = seedCredential({ scopes: [SCOPES.INSTANCE_READ] });

    // 未在 WS 认证里接入作用域化凭据：握手必须返回 null（调用方以 1008 关闭），
    // 而不是因为「它是一把有效的 Key」就放行成只读事件面。
    // 放行才是危险的：WS 只按 role 过滤（admin/readonly 两档），没有作用域维度，
    // 一把只持 instance:read 的凭据会拿到全部只读事件（含日志/命令/备份/任务）。
    expect(authenticateWebSocket(token)).toBe(null);
  });

  it('停用/吊销后的台账凭据同样握手失败（不因缓存而残留）', async () => {
    const { authenticateWebSocket } = await import('../middleware/auth.js');
    const { id, token } = seedCredential({ scopes: [SCOPES.INSTANCE_READ] });
    MachineCredentialModel.setEnabled(id, false);
    expect(authenticateWebSocket(token)).toBe(null);
  });

  it('既有两把 .env 凭据的握手行为不变（管理员 admin / 只读 readonly）', async () => {
    const { authenticateWebSocket } = await import('../middleware/auth.js');
    expect(authenticateWebSocket(ADMIN_KEY)).toEqual({ role: 'admin' });
    expect(authenticateWebSocket(READONLY_KEY)).toEqual({ role: 'readonly' });
  });
});

describe('吊销/停用经 HTTP 全链路生效（不经模型直判）', () => {
  it('吊销后同一把 Key 立刻 401（走 authMiddleware 全链路，不是只测模型）', async () => {
    const { id, token } = seedCredential({ name: '吊销链路', scopes: [SCOPES.INSTANCE_READ] });
    // 先证明吊销前可用，否则「401」可能来自别的原因
    expect((await asKey('GET', '/api/v1/instances', token)).status).not.toBe(401);

    MachineCredentialModel.revoke(id);
    const res = await asKey('GET', '/api/v1/instances', token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCodes.INVALID_API_KEY.code);
  });

  it('吊销同时置 isEnabled=false（两个字段语义一致，不留「已吊销但显示启用」的行）', async () => {
    const { id } = seedCredential({ name: '吊销字段' });
    MachineCredentialModel.revoke(id);
    // 用 includeRevoked 取出该行：默认列表不含已吊销，直接 list() 会拿不到
    const row = MachineCredentialModel.list({ includeRevoked: true }).find((c) => c.id === id);
    expect(row.revokedAt).not.toBe(null);
    expect(row.isEnabled, '吊销必须同时停用，否则台账显示与实际相反').toBe(false);
  });
});

describe('最近使用时刻（可观测性；缺失只会静默退化）', () => {
  it('认证成功后 lastUsedAt 被填上（不是恒 null 的死字段）', async () => {
    const { token } = seedCredential({ name: '最近使用', scopes: [SCOPES.INSTANCE_READ] });
    const before = MachineCredentialModel.list()[0];
    expect(before.lastUsedAt, '新建时尚未使用过').toBe(null);

    await asKey('GET', '/api/v1/instances', token);

    const after = MachineCredentialModel.list()[0];
    expect(after.lastUsedAt, '认证通过后应记录最近使用时刻').not.toBe(null);
  });

  it('节流生效：同一秒内的多次请求只写一次（热路径不做写放大）', async () => {
    const { token } = seedCredential({ name: '节流', scopes: [SCOPES.INSTANCE_READ] });
    // 先打一次让它进入「刚写过」状态
    await asKey('GET', '/api/v1/instances', token);
    const first = MachineCredentialModel.list()[0].lastUsedAt;

    // 紧接着再打 4 次：节流窗口内不得更新（时间戳应逐字不变）
    for (let i = 0; i < 4; i++) await asKey('GET', '/api/v1/instances', token);
    const after = MachineCredentialModel.list()[0].lastUsedAt;

    expect(after, '节流窗口内时间戳应保持不变').toBe(first);
  });
});

describe('凭据管理端点仅管理员可达（含持全部只读作用域的凭据）', () => {
  it('持三档只读全量的凭据也不能创建/启停/吊销凭据', async () => {
    const { id, token } = seedCredential({
      name: '全量只读',
      scopes: [SCOPES.SYSTEM_READ, SCOPES.INSTANCE_READ, SCOPES.PLAYER_READ],
    });

    const create = await request(app)
      .post('/api/v1/machine-credentials')
      .set('X-API-Key', token)
      .send({ name: '自我提权尝试', scopes: [SCOPES.INSTANCE_READ] });
    expect(create.status, '受限凭据不得创建新凭据').toBe(403);

    const toggle = await request(app)
      .put(`/api/v1/machine-credentials/${id}/enabled`)
      .set('X-API-Key', token)
      .send({ isEnabled: false });
    expect(toggle.status, '受限凭据不得改自身状态').toBe(403);

    const revoke = await request(app)
      .delete(`/api/v1/machine-credentials/${id}`)
      .set('X-API-Key', token);
    expect(revoke.status, '受限凭据不得吊销凭据').toBe(403);

    // 反向对照：这三次尝试都不得真的改动台账
    const row = MachineCredentialModel.list({ includeRevoked: true }).find((c) => c.id === id);
    expect(row.isEnabled).toBe(true);
    expect(row.revokedAt).toBe(null);
    expect(MachineCredentialModel.list()).toHaveLength(1);
  });
});
