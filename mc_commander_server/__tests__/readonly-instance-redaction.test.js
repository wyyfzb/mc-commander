/**
 * 只读角色响应裁剪（实例列表 / 实例详情）。
 *
 * 承重点：白名单只决定「能不能进」，不保证「进来后看到什么」——`GET /instances` 与
 * `GET /instances/:id` 的 `instanceStatusSchema` 含 `jvmArgs`/`startCommand`/`javaPath`/`seed`，
 * 而运维把口令写进 JVM 参数（JMX/DB 连接串/模组）是常见做法，只读凭据因此能读到凭据。
 * 本文件用哨兵钉住「readonly 必须看不到」，并用双向对照钉住「admin 逐字节不变」——
 * 只测单向的话，两边都裁掉也会假绿。
 *
 * 临时库/临时 .env 双重重定向，不触碰仓库真实 .env 与数据目录。
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
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mcs-readonly-redact-'));
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
import { instanceStatusSchema } from '@mc-commander/schemas';
import { READONLY_REDACTED_FIELDS, readonlyInstanceStatusSchema } from '../routes/status.js';
import { authMiddleware } from '../middleware/auth.js';
import { createApiV1Router, API_V1_MOUNT } from '../routes/index.js';
import { errorHandler } from '../middleware/error_handler.js';
import { hashToken } from '../utils/password.js';

const ADMIN_KEY = 'test-api-key-for-unit-tests';
const READONLY_KEY = 'readonly-test-key-for-unit-tests';

/** 哨兵写在最可能藏口令的位置：JVM 参数与启动命令 */
const SENTINEL = '-Drcon.password=SENTINEL_JVM_XYZ_1.2.3.4';
const REDACTED_FIELDS = ['jvmArgs', 'startCommand', 'javaPath', 'seed'];
/** 裁剪必须保留的监控字段（抽样子集，防「一刀切删字段」式过度裁剪） */
const KEPT_FIELDS = [
  'id', 'name', 'address', 'isRunning', 'playerCount', 'tps', 'mspt',
  'cpuUsage', 'memoryUsage', 'uptime', 'mcVersion', 'playerCount',
];

/** 完整的实例状态基线：即 toStatus() 的产物，也是 admin 响应的逐字段对照基准 */
const BASELINE_STATUS = {
  id: 'srv-1',
  name: 'Survival',
  isRunning: true,
  isRconConnected: true,
  autoRestart: true,
  autoStart: true,
  circuitBreakerTripped: false,
  consecutiveCrashes: 0,
  uptime: 3600,
  address: '1.2.3.4:25565',
  players: [],
  playerCount: 2,
  maxPlayers: 20,
  mcVersion: '1.21.4',
  modLoader: 'vanilla',
  tps: 19.8,
  mspt: 12.3,
  cpuUsage: 25.5,
  memoryUsage: 2.5,
  totalMemory: 8,
  worldSize: '128.5 MB',
  seed: '1234567890',
  lastSave: '2026-09-16T00:00:00.000Z',
  lastOutput: 'Done (1.234s)! For help, type "help"',
  gameMode: 'survival',
  difficulty: 'normal',
  whitelisted: false,
  onlineMode: true,
  viewDistance: 10,
  spawnProtection: 16,
  worldDay: 42,
  worldTime: 6000,
  weather: 'clear',
  opCount: 1,
  opNames: ['Steve'],
  todayNewPlayers: 0,
  sleepingPlayers: 0,
  sleepingPlayerNames: [],
  awakePlayerNames: ['Alex'],
  totalUptime: 86400,
  startTime: '2026-09-15T00:00:00.000Z',
  startCommand: `java ${SENTINEL} -jar server.jar`,
  jvmArgs: [SENTINEL, '-Xmx4G'],
  javaPath: '/opt/java/bin/java',
  maxMemory: '4G',
  minMemory: '1G',
  jarFile: 'server.jar',
};

let app;

beforeAll(() => {
  const stubManager = {
    instances: new Map(),
    // 与生产同形：getAllInstances() 返回的已是状态对象（不是实例）
    getAllInstances: () => [BASELINE_STATUS],
    getInstance: (id) => (id === BASELINE_STATUS.id
      ? { toStatus: () => BASELINE_STATUS }
      : null),
  };
  app = express();
  app.use(express.json());
  app.use('/api/', authMiddleware);
  app.use(API_V1_MOUNT, createApiV1Router(stubManager, {}));
  app.use(errorHandler);
});

afterAll(() => {
  // 清理 mock 工厂建的临时目录（本文件不初始化数据库，目录内无真实数据）
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

const originalReadonlyApiKeyHash = config.readonlyApiKeyHash;
const originalReadonlyApiKeyEnabled = config.readonlyApiKeyEnabled;

beforeEach(() => {
  config.readonlyApiKeyEnabled = true;
  config.readonlyApiKeyHash = hashToken(READONLY_KEY);
});

afterEach(() => {
  config.readonlyApiKeyHash = originalReadonlyApiKeyHash;
  config.readonlyApiKeyEnabled = originalReadonlyApiKeyEnabled;
});

const get = (url, key) => request(app).get(url).set('X-API-Key', key);
const LIST_URL = `${API_V1_MOUNT}/instances`;
const DETAIL_URL = `${API_V1_MOUNT}/instances/${BASELINE_STATUS.id}`;

/** 从两条端点的响应中取出实例状态对象（列表取首项） */
function statusOf(res, url) {
  return url === LIST_URL ? res.body.data[0] : res.body.data;
}

describe('只读凭据看不到凭据可能驻留的字段（哨兵双向对照）', () => {
  it('GET /instances：哨兵不出现，四个字段键都不存在', async () => {
    const res = await get(LIST_URL, READONLY_KEY);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    const raw = JSON.stringify(res.body);
    expect(raw, 'JVM 参数里的哨兵不得出现在只读响应里').not.toContain(SENTINEL);
    expect(raw).not.toContain('SENTINEL_JVM_XYZ');

    const item = statusOf(res, LIST_URL);
    for (const field of REDACTED_FIELDS) {
      expect(Object.keys(item), `只读列表不得含字段 ${field}`).not.toContain(field);
    }
  });

  it('GET /instances/:id：哨兵不出现，四个字段键都不存在', async () => {
    const res = await get(DETAIL_URL, READONLY_KEY);

    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain('SENTINEL_JVM_XYZ');

    const item = statusOf(res, DETAIL_URL);
    for (const field of REDACTED_FIELDS) {
      expect(Object.keys(item), `只读详情不得含字段 ${field}`).not.toContain(field);
    }
  });

  it('反向对照：管理员凭据在两条端点上都能看到哨兵与四个字段（防「两边都裁掉」假绿）', async () => {
    for (const url of [LIST_URL, DETAIL_URL]) {
      const res = await get(url, ADMIN_KEY);
      expect(res.status, `${url} 管理员应可达`).toBe(200);
      const raw = JSON.stringify(res.body);
      expect(raw, `${url} 管理员应看到 JVM 参数`).toContain(SENTINEL);

      const item = statusOf(res, url);
      for (const field of REDACTED_FIELDS) {
        expect(Object.keys(item), `${url} 管理员应保留字段 ${field}`).toContain(field);
      }
      expect(item.jvmArgs).toEqual([SENTINEL, '-Xmx4G']);
      expect(item.javaPath).toBe('/opt/java/bin/java');
      expect(item.seed).toBe('1234567890');
      expect(item.startCommand).toBe(`java ${SENTINEL} -jar server.jar`);
    }
  });
});

describe('管理员响应零回归（与改动前逐字段一致）', () => {
  it('GET /instances 与 GET /instances/:id 的 admin 响应 deep-equal 基线', async () => {
    const list = await get(LIST_URL, ADMIN_KEY);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([BASELINE_STATUS]);

    const detail = await get(DETAIL_URL, ADMIN_KEY);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toEqual(BASELINE_STATUS);
  });
});

describe('裁剪只删该删的（不过度裁剪）', () => {
  it('只读响应仍保留监控所需字段，且值与管理员的同名字段一致', async () => {
    const res = await get(DETAIL_URL, READONLY_KEY);
    const item = statusOf(res, DETAIL_URL);

    for (const field of KEPT_FIELDS) {
      expect(item, `只读详情应保留 ${field}`).toHaveProperty(field);
      expect(item[field], `只读详情的 ${field} 应与基线一致`).toEqual(BASELINE_STATUS[field]);
    }
    // 裁剪是「删字段」而非「改值」：除四个字段外其余键集合完全一致
    const expectedKeys = Object.keys(BASELINE_STATUS).filter((k) => !REDACTED_FIELDS.includes(k));
    expect(Object.keys(item).sort()).toEqual(expectedKeys.sort());
  });

  it('裁剪只作用于实例状态出参：同一凭据访问其它白名单端点不受影响（/overview 照常 200）', async () => {
    const res = await get(`${API_V1_MOUNT}/overview`, READONLY_KEY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    // overview 是聚合面、不含实例状态的敏感字段，故无裁剪逻辑介入
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  });
});

/**
 * 敏感字段 × 裁剪清单哨兵。
 *
 * 承重点：只读视图是「全量 schema 减黑名单」派生的——契约里新增字段会**自动**出现在
 * 只读响应里。响应侧的既有用例都基于固定基线对象，加字段时它们照样绿（基线里没有
 * 新字段，断言不到），也就是新增敏感字段会静默泄给只读凭据。
 * 本组用例把「只读视图键集合」钉成显式清单：契约加字段 → READONLY_STATUS_FIELDS
 * 必须同步，而同步动作本身就是一次「该字段敏感吗」的分类决策。
 *
 * 范围边界：只钉顶层键名（与裁剪机制同范围——omit 也只能删顶层字段），嵌套对象或
 * 数组元素内部新增的字段不在此守卫内；将来若出现嵌套敏感字段，裁剪机制本身要一并改。
 */
describe('敏感字段 × 裁剪清单哨兵（新增契约字段必须显式分类）', () => {
  it('黑名单成员都是契约里真实存在的字段（防笔误与字段删除后的悬空条目）', () => {
    const baseFields = Object.keys(instanceStatusSchema.shape);
    for (const field of READONLY_REDACTED_FIELDS) {
      expect(baseFields, `裁剪清单里的 ${field} 不在契约中`).toContain(field);
    }
  });

  it('只读视图 = 契约减黑名单（派生关系未被手工改写）', () => {
    const baseFields = Object.keys(instanceStatusSchema.shape);
    const expected = baseFields.filter((f) => !READONLY_REDACTED_FIELDS.includes(f));
    expect(Object.keys(readonlyInstanceStatusSchema.shape).sort()).toEqual(expected.sort());
  });

  it('只读视图键集合与显式清单逐一相等：契约新增字段不改清单即红', () => {
    // 新增字段时的处置：确认不敏感 → 加进本清单；确认敏感（凭据/主机布局/种子一类）
    // → 加进 READONLY_REDACTED_FIELDS。两条路都要在本文件留下痕迹，不允许「顺手加字段」
    const READONLY_STATUS_FIELDS = [
      'id', 'name', 'isRunning', 'isRconConnected', 'autoRestart', 'autoStart',
      'circuitBreakerTripped', 'consecutiveCrashes', 'uptime', 'address', 'players',
      'playerCount', 'maxPlayers', 'mcVersion', 'modLoader', 'tps', 'mspt',
      'cpuUsage', 'memoryUsage', 'totalMemory', 'worldSize', 'lastSave', 'lastOutput',
      'gameMode', 'difficulty', 'whitelisted', 'onlineMode', 'viewDistance',
      'spawnProtection', 'worldDay', 'worldTime', 'weather', 'opCount', 'opNames',
      'todayNewPlayers', 'sleepingPlayers', 'sleepingPlayerNames', 'awakePlayerNames',
      'totalUptime', 'startTime', 'maxMemory', 'minMemory', 'jarFile',
    ];
    expect(Object.keys(readonlyInstanceStatusSchema.shape).sort())
      .toEqual([...READONLY_STATUS_FIELDS].sort());
  });
});
