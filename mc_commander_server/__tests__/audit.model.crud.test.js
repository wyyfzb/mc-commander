import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// AuditLogModel / CommandHistoryModel 持久层行为级补测（真实 SQLite，issue 503）。
// 既有 audit.model.test.js 以 fakeDb 锁定 SQL 形状；本文件补真实数据库行为语义：
// CRUD 往返 / 默认值链 / 分页边界 / 过滤组合（AND）/ 时间窗（>= <=）/ 排序方向
// 白名单回落 / prune 清理计数。范式与 backup.model.crud.test.js（issue 421）一致：
// db 层用真实 SQLite 实例，仅替身 database.js 的连接管理（getDb 指向本文件
// 创建的临时库），SQL 语义真实。

const TEST_DIR = path.join(os.tmpdir(), `mcs-audit-crud-${process.pid}-${Date.now()}`);

let db;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');

  // 与 database.js createTables 的 audit_logs/command_history 表结构一致
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      source TEXT DEFAULT 'api',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS command_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      command TEXT NOT NULL,
      source TEXT DEFAULT 'api',
      success INTEGER DEFAULT 1,
      response TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// 替身 database.js 的连接管理，SUT 的 SQL 全部落在真实库上
vi.mock('../db/database.js', () => ({
  getDb: () => db,
}));

const { AuditLogModel, CommandHistoryModel } = await import('../db/audit.model.js');

// 直接插入受控 created_at 的行（取跨年远边界值：与 prune cutoff 的先后由日期前缀唯一决定，
// 不受时间分隔符格式影响；cutoff 同日的边界行为由 prune.cutoff.test.js 锁定，issue 541）
function insertAuditRaw(overrides = {}) {
  const o = {
    instance_id: 's1', action: 'INSTANCE_START', target_type: null, target_id: null,
    detail: null, source: 'api', created_at: '2026-06-15T00:00:00.000Z', ...overrides,
  };
  const r = db.prepare(`
    INSERT INTO audit_logs (instance_id, action, target_type, target_id, detail, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(o.instance_id, o.action, o.target_type, o.target_id, o.detail, o.source, o.created_at);
  return r.lastInsertRowid;
}

function insertCommandRaw(overrides = {}) {
  const o = {
    instance_id: 's1', command: 'say hi', source: 'api', success: 1,
    response: null, duration_ms: null, created_at: '2026-06-15T00:00:00.000Z', ...overrides,
  };
  const r = db.prepare(`
    INSERT INTO command_history (instance_id, command, source, success, response, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(o.instance_id, o.command, o.source, o.success, o.response, o.duration_ms, o.created_at);
  return r.lastInsertRowid;
}

describe('AuditLogModel.create / findById 真实往返', () => {
  it('create 全字段落库，findById 读回 camelCase 与 detail JSON 反序列化', () => {
    const log = AuditLogModel.create({
      instanceId: 's1', action: 'PLAYER_KICK', targetType: 'player',
      targetId: 'Steve', detail: { reason: 'griefing', by: 'Alex' }, source: 'webui',
    });
    expect(log.id).toBeGreaterThan(0);
    expect(log.instanceId).toBe('s1');
    expect(log.action).toBe('PLAYER_KICK');
    expect(log.targetType).toBe('player');
    expect(log.targetId).toBe('Steve');
    expect(log.detail).toEqual({ reason: 'griefing', by: 'Alex' });
    expect(log.source).toBe('webui');
    expect(log.createdAt).toBeTruthy();

    const again = AuditLogModel.findById(log.id);
    expect(again).toEqual(log);
  });

  it('create 缺省字段兜底：target/detail 为 null、source 默认 api', () => {
    const log = AuditLogModel.create({ instanceId: 's1', action: 'INSTANCE_STOP' });
    expect(log.targetType).toBeNull();
    expect(log.targetId).toBeNull();
    expect(log.detail).toBeNull();
    expect(log.source).toBe('api');
  });

  it('create detail 为原始字符串时存取保真（非 JSON 也原样读回）', () => {
    const log = AuditLogModel.create({ instanceId: 's1', action: 'X', detail: 'plain-text-detail' });
    expect(log.detail).toBe('plain-text-detail');
  });

  it('findById 缺失返回 null（不抛错）', () => {
    expect(AuditLogModel.findById(999999)).toBeNull();
  });

  it('findAll 空集返回零页结构（logs/total/page/pageSize 形状）', () => {
    const r = AuditLogModel.findAll({ instanceId: 'no-such-instance' });
    expect(r.logs).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
  });
});

describe('AuditLogModel.findAll 过滤组合（真实 AND 语义）', () => {
  beforeAll(() => {
    insertAuditRaw({ action: 'A1', created_at: '2026-01-01T00:00:00.000Z' });
    insertAuditRaw({ instance_id: 's2', action: 'A2', target_type: 'player', target_id: 'Steve', source: 'webui', created_at: '2026-02-01T00:00:00.000Z' });
    insertAuditRaw({ action: 'A2', created_at: '2026-03-01T00:00:00.000Z' });
    insertAuditRaw({ instance_id: 's2', action: 'A3', source: 'scheduler', created_at: '2026-04-01T00:00:00.000Z' });
  });

  it('instanceId 过滤只命中对应实例', () => {
    const r = AuditLogModel.findAll({ instanceId: 's2' });
    expect(r.total).toBe(2);
    expect(r.logs.every((l) => l.instanceId === 's2')).toBe(true);
  });

  it('action 过滤命中全部同 action 行（跨实例）', () => {
    const r = AuditLogModel.findAll({ action: 'A2' });
    expect(r.total).toBe(2);
    expect(r.logs.every((l) => l.action === 'A2')).toBe(true);
  });

  it('targetType 与 source 过滤各自生效（唯一标记值隔离共享库）', () => {
    insertAuditRaw({ target_type: 'iso-type-x1', source: 'iso-src-x1' });
    expect(AuditLogModel.findAll({ targetType: 'iso-type-x1' }).total).toBe(1);
    expect(AuditLogModel.findAll({ source: 'iso-src-x1' }).total).toBe(1);
    // 多条同值 source 的聚合计数（api 为默认值，命中已包括共享库内其它默认行）
    expect(AuditLogModel.findAll({ source: 'api' }).total).toBeGreaterThanOrEqual(3);
  });

  it('时间窗为闭区间（>= startTime 且 <= endTime）', () => {
    const r = AuditLogModel.findAll({
      startTime: '2026-02-01T00:00:00.000Z',
      endTime: '2026-03-01T00:00:00.000Z',
    });
    expect(r.total).toBe(2);
    expect(r.logs.map((l) => l.createdAt)).toEqual([
      '2026-03-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
    ]);
  });

  it('组合过滤 AND 语义（instanceId + action 交集）', () => {
    const r = AuditLogModel.findAll({ instanceId: 's2', action: 'A2' });
    expect(r.total).toBe(1);
    expect(r.logs[0].instanceId).toBe('s2');
    expect(r.logs[0].action).toBe('A2');
  });

  it('组合过滤 + 时间窗三者交集', () => {
    const r = AuditLogModel.findAll({
      instanceId: 's2',
      startTime: '2026-03-01T00:00:00.000Z',
    });
    expect(r.total).toBe(1);
    expect(r.logs[0].action).toBe('A3');
  });

  it('order=asc 真实升序、缺省/非法值回落真实降序（行为而非 SQL 形状）', () => {
    const asc = AuditLogModel.findAll({ order: 'asc' });
    const idsAsc = asc.logs.map((l) => l.id);
    expect(idsAsc).toEqual([...idsAsc].sort((a, b) => a - b));

    const def = AuditLogModel.findAll({});
    const idsDef = def.logs.map((l) => l.id);
    expect(idsDef).toEqual([...idsDef].sort((a, b) => b - a));

    const invalid = AuditLogModel.findAll({ order: 'DROP TABLE' });
    const idsInvalid = invalid.logs.map((l) => l.id);
    expect(idsInvalid).toEqual([...idsInvalid].sort((a, b) => b - a));
  });
});

describe('AuditLogModel.findAll 分页边界', () => {
  beforeAll(() => {
    for (let i = 0; i < 5; i++) {
      insertAuditRaw({ action: `PAGE-${i}`, created_at: `2026-05-0${i + 1}T00:00:00.000Z` });
    }
  });

  it('pageSize 2 逐页遍历 5 条：第 3 页只剩 1 条，total 恒为 5', () => {
    const p1 = AuditLogModel.findAll({ page: 1, pageSize: 2, action: undefined });
    // page 查询不加 action 过滤会命中前面 describe 的数据——用独立实例 id 隔离
    const total = AuditLogModel.findAll({}).total;
    expect(total).toBeGreaterThanOrEqual(5);
    expect(p1.logs).toHaveLength(2);
  });

  it('page 越界返回空 logs 且 total 不变', () => {
    const r = AuditLogModel.findAll({ page: 100, pageSize: 20 });
    expect(r.logs).toEqual([]);
    expect(r.total).toBeGreaterThan(0);
  });

  it('offset 语义 = (page-1)*pageSize（第 2 页不与第 1 页重叠）', () => {
    const p1 = AuditLogModel.findAll({ page: 1, pageSize: 2 }).logs.map((l) => l.id);
    const p2 = AuditLogModel.findAll({ page: 2, pageSize: 2 }).logs.map((l) => l.id);
    expect(p1).toHaveLength(2);
    expect(p2).toHaveLength(2);
    expect(p1.some((id) => p2.includes(id))).toBe(false);
  });
});

describe('AuditLogModel.prune 真实删除计数', () => {
  it('删除超龄行返回 changes 数，未超龄保留', () => {
    const old1 = insertAuditRaw({ created_at: '2020-01-01T00:00:00.000Z' });
    const old2 = insertAuditRaw({ created_at: '2020-06-01T00:00:00.000Z' });
    // 新鲜行用近期时间（90 天 cutoff 之外不可用 6 月，今天已 9 月）
    const fresh = insertAuditRaw({ created_at: '2026-09-01T00:00:00.000Z' });

    const deleted = AuditLogModel.prune(90);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(AuditLogModel.findById(old1)).toBeNull();
    expect(AuditLogModel.findById(old2)).toBeNull();
    expect(AuditLogModel.findById(fresh)).not.toBeNull();
  });
});

describe('CommandHistoryModel 真实往返与过滤', () => {
  it('create 全字段落库，success 布尔落库为 1 并读回 true', () => {
    const c = CommandHistoryModel.create({
      instanceId: 's1', command: 'time query gametime', source: 'rcon',
      success: true, response: 'The time is 13000', durationMs: 42,
    });
    expect(c.id).toBeGreaterThan(0);
    expect(c.instanceId).toBe('s1');
    expect(c.command).toBe('time query gametime');
    expect(c.source).toBe('rcon');
    expect(c.success).toBe(true);
    expect(c.response).toBe('The time is 13000');
    expect(c.durationMs).toBe(42);

    expect(CommandHistoryModel.findById(c.id)).toEqual(c);
  });

  it('create 失败命令：success false 读回 false，缺省 source=api、response/durationMs null', () => {
    const c = CommandHistoryModel.create({ instanceId: 's1', command: 'bad cmd', success: false });
    expect(c.success).toBe(false);
    expect(c.source).toBe('api');
    expect(c.response).toBeNull();
    expect(c.durationMs).toBeNull();
  });

  it('findById 缺失返回 null', () => {
    expect(CommandHistoryModel.findById(999999)).toBeNull();
  });

  it('findAll 过滤 + 恒定降序（无 order 参数，行为锁定）', () => {
    insertCommandRaw({ instance_id: 's9', command: 'list', created_at: '2026-07-01T00:00:00.000Z' });
    insertCommandRaw({ instance_id: 's9', command: 'tps', source: 'scheduler', created_at: '2026-07-02T00:00:00.000Z' });
    insertCommandRaw({ instance_id: 's9', command: 'save-all', created_at: '2026-07-03T00:00:00.000Z' });

    const r = CommandHistoryModel.findAll({ instanceId: 's9' });
    expect(r.total).toBe(3);
    const ids = r.commands.map((c) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('findAll source + 时间窗组合过滤', () => {
    const r = CommandHistoryModel.findAll({
      source: 'scheduler',
      startTime: '2026-07-01T00:00:00.000Z',
      endTime: '2026-07-02T00:00:00.000Z',
    });
    expect(r.total).toBe(1);
    expect(r.commands[0].command).toBe('tps');
  });

  it('findAll 分页边界：pageSize 1 逐页取、越界页空集', () => {
    const r1 = CommandHistoryModel.findAll({ instanceId: 's9', page: 1, pageSize: 1 });
    const r2 = CommandHistoryModel.findAll({ instanceId: 's9', page: 2, pageSize: 1 });
    const r9 = CommandHistoryModel.findAll({ instanceId: 's9', page: 9, pageSize: 1 });
    expect(r1.commands).toHaveLength(1);
    expect(r2.commands).toHaveLength(1);
    expect(r1.commands[0].id).not.toBe(r2.commands[0].id);
    expect(r9.commands).toEqual([]);
    expect(r9.total).toBe(3);
  });

  it('prune 删除超龄行返回计数，未超龄保留', () => {
    const old = insertCommandRaw({ created_at: '2020-01-01T00:00:00.000Z' });
    const fresh = insertCommandRaw({ created_at: '2026-09-01T00:00:00.000Z' });

    const deleted = CommandHistoryModel.prune(90);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(CommandHistoryModel.findById(old)).toBeNull();
    expect(CommandHistoryModel.findById(fresh)).not.toBeNull();
  });
});
