import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// BanModel 持久层语义补测（真实 SQLite，ban.model.js 语义锁定）。
// 覆盖：create 覆盖写（同目标新封禁压制旧未到期记录）/ 全查询语义与排序 /
// 到期查询 / 手动与定向解封清理链。db 层用真实 SQLite 实例，仅替身
// database.js 的连接管理（getDb 指向本文件创建的临时库），SQL 语义真实。

const TEST_DIR = path.join(os.tmpdir(), `mcs-ban-model-${process.pid}-${Date.now()}`);

let db;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 与 database.js createTables 的 temp_bans 表结构一致
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS temp_bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'player',
      target TEXT NOT NULL,
      reason TEXT,
      expires_at INTEGER NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
    )
  `);

  // temp_bans.instance_id 带 FK 约束，预置各用例引用的实例行（s1-s9）
  const seed = db.prepare('INSERT INTO instances (id, name) VALUES (?, ?)');
  for (let i = 1; i <= 9; i++) seed.run(`s${i}`, `Instance ${i}`);
});

afterAll(() => {
  db?.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// 替身 database.js 的连接管理，SUT 的 SQL 全部落在真实库上
vi.mock('../db/database.js', () => ({
  getDb: () => db,
}));

const { BanModel } = await import('../db/ban.model.js');

const NOW = 1_700_000_000_000;

describe('BanModel.create / findById', () => {
  it('创建返回 camelCase 行（isActive 布尔化、reason 缺省 null）', () => {
    const ban = BanModel.create({
      instanceId: 's1',
      targetType: 'player',
      target: 'Griefer',
      expiresAt: NOW + 60_000,
    });
    expect(ban.id).toBeGreaterThan(0);
    expect(ban.instanceId).toBe('s1');
    expect(ban.targetType).toBe('player');
    expect(ban.target).toBe('Griefer');
    expect(ban.reason).toBeNull();
    expect(ban.isActive).toBe(true);
    expect(ban.expiresAt).toBe(NOW + 60_000);
  });

  it('reason 缺省兜底 null，显式 reason 落库', () => {
    const ban = BanModel.create({
      instanceId: 's1',
      targetType: 'ip',
      target: '1.2.3.4',
      reason: 'spam',
      expiresAt: NOW + 60_000,
    });
    expect(ban.reason).toBe('spam');
  });

  it('同目标新封禁压制旧未到期记录（避免到期重复 pardon）', () => {
    const old = BanModel.create({
      instanceId: 's2', targetType: 'player', target: 'Repeat',
      reason: 'first', expiresAt: NOW + 60_000,
    });
    const fresh = BanModel.create({
      instanceId: 's2', targetType: 'player', target: 'Repeat',
      reason: 'second', expiresAt: NOW + 120_000,
    });
    const oldRow = db.prepare('SELECT is_active FROM temp_bans WHERE id = ?').get(old.id);
    expect(oldRow.is_active).toBe(0);
    expect(fresh.isActive).toBe(true);
    expect(fresh.reason).toBe('second');
  });

  it('同实例同目标但 targetType 不同不互相压制', () => {
    const p = BanModel.create({
      instanceId: 's3', targetType: 'player', target: 'Dual', expiresAt: NOW + 60_000,
    });
    const ip = BanModel.create({
      instanceId: 's3', targetType: 'ip', target: 'Dual', expiresAt: NOW + 60_000,
    });
    expect(db.prepare('SELECT is_active FROM temp_bans WHERE id = ?').get(p.id).is_active).toBe(1);
    expect(db.prepare('SELECT is_active FROM temp_bans WHERE id = ?').get(ip.id).is_active).toBe(1);
  });

  it('findById 缺失返回 null', () => {
    expect(BanModel.findById(999999)).toBeNull();
  });
});

describe('BanModel 查询语义', () => {
  beforeAll(() => {
    // 固定场景：s4 实例 4 条记录（1 active 玩家 / 2 active 已过期 / 3 inactive 历史）
    BanModel.create({ instanceId: 's4', targetType: 'player', target: 'Active', expiresAt: NOW + 60_000 });
    const expired = BanModel.create({ instanceId: 's4', targetType: 'player', target: 'Expired', expiresAt: NOW - 60_000 });
    BanModel.create({ instanceId: 's4', targetType: 'ip', target: '1.2.3.4', expiresAt: NOW - 120_000 });
    BanModel.deactivate(expired.id);
  });

  it('findActiveByInstance 只返回 active 记录（含已过期，按 id DESC）', () => {
    const rows = BanModel.findActiveByInstance('s4');
    // 1.2.3.4（active 已过期）与 Active（active 未到期）均生效中；Expired 已解封不返回
    expect(rows.map((r) => r.target)).toEqual(['1.2.3.4', 'Active']);
    expect(rows.every((r) => r.isActive)).toBe(true);
  });

  it('findActiveByInstance 不含已解封记录', () => {
    const rows = BanModel.findActiveByInstance('s4');
    expect(rows.map((r) => r.target)).not.toContain('Expired');
    expect(rows.length).toBe(2);
  });

  it('findAllByInstance 返回全部记录（active 优先 + expires_at ASC + id DESC）', () => {
    const rows = BanModel.findAllByInstance('s4');
    expect(rows.length).toBe(3);
    // active 记录（1.2.3.4 id 最大 / Active）在前按 id DESC；inactive（Expired）在后
    expect(rows.filter((r) => r.isActive).map((r) => r.target)).toEqual(['1.2.3.4', 'Active']);
    expect(rows.filter((r) => !r.isActive).map((r) => r.target)).toEqual(['Expired']);
  });

  it('findExpiredActive(now) 只返回 active 且 expires_at <= now（id ASC）', () => {
    const rows = BanModel.findExpiredActive(NOW);
    expect(rows.map((r) => r.target)).toEqual(['1.2.3.4']);
    // 未到期记录不在结果内
    expect(rows.map((r) => r.expiresAt)).toEqual([NOW - 120_000]);
  });

  it('findExpiredActive 省略 now 参数时默认取当前时间', () => {
    // 与显式传入当前时间行为一致（默认参数等价性），且 NOW 相对真实当前时间
    // 已过期——全表 active 记录（expires_at 均在 NOW 附近）都应被计入
    const rows = BanModel.findExpiredActive();
    expect(rows).toEqual(BanModel.findExpiredActive(Date.now()));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const ids = rows.map((r) => r.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('findExpiredActive 未来到期记录不返回', () => {
    const rows = BanModel.findExpiredActive(NOW - 200_000);
    expect(rows).toEqual([]);
  });
});

describe('BanModel 解封清理链', () => {
  it('deactivate 按 id 置 inactive', () => {
    const ban = BanModel.create({ instanceId: 's5', targetType: 'player', target: 'D1', expiresAt: NOW + 60_000 });
    expect(BanModel.findById(ban.id).isActive).toBe(true);
    BanModel.deactivate(ban.id);
    expect(BanModel.findById(ban.id).isActive).toBe(false);
  });

  it('deactivateByPlayer 只清该实例 player 型 active 记录，ip 型保留', () => {
    const p1 = BanModel.create({ instanceId: 's6', targetType: 'player', target: 'Mixed', expiresAt: NOW + 60_000 });
    const ip1 = BanModel.create({ instanceId: 's6', targetType: 'ip', target: 'Mixed', expiresAt: NOW + 60_000 });
    BanModel.deactivateByPlayer('s6', 'Mixed');
    expect(BanModel.findById(p1.id).isActive).toBe(false);
    expect(BanModel.findById(ip1.id).isActive).toBe(true);
  });

  it('deactivateByPlayer 不影响其他实例同名记录', () => {
    const other = BanModel.create({ instanceId: 's7', targetType: 'player', target: 'Solo', expiresAt: NOW + 60_000 });
    BanModel.deactivateByPlayer('s6', 'Solo');
    expect(BanModel.findById(other.id).isActive).toBe(true);
  });

  it('deactivateByIp 只清该实例 ip 型 active 记录，player 型保留', () => {
    const p = BanModel.create({ instanceId: 's8', targetType: 'player', target: '5.6.7.8', expiresAt: NOW + 60_000 });
    const ip = BanModel.create({ instanceId: 's8', targetType: 'ip', target: '5.6.7.8', expiresAt: NOW + 60_000 });
    BanModel.deactivateByIp('s8', '5.6.7.8');
    expect(BanModel.findById(p.id).isActive).toBe(true);
    expect(BanModel.findById(ip.id).isActive).toBe(false);
  });

  it('deactivateByIp 对 inactive 记录幂等（不报错不复活）', () => {
    const ip = BanModel.create({ instanceId: 's9', targetType: 'ip', target: '9.9.9.9', expiresAt: NOW + 60_000 });
    BanModel.deactivate(ip.id);
    BanModel.deactivateByIp('s9', '9.9.9.9');
    expect(BanModel.findById(ip.id).isActive).toBe(false);
  });
});
