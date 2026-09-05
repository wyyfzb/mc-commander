import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

// 三处 append-only 表 prune 的 cutoff 边界行为级测试（真实 SQLite，issue 541）。
// 修复前：cutoff 用 toISOString()（"T" 分隔 + 毫秒 + "Z"），与 CURRENT_TIMESTAMP 列值
// （空格分隔、无毫秒）字典序比较在 cutoff 同日恒成立（' ' < 'T'），边界日全天记录被误删，
// 保留窗口缩水 N-1 天。修复后：cutoff 经 db/sqlite-time.js 与列格式字节级同构。
// 本文件以固定系统时间锁定三表各自的边界语义：同日晚于 cutoff 时刻不删、
// 同日早于 cutoff 时刻删、等于 cutoff 不删（严格 <）、前一日删、now 当日不删。
// 范式与 audit.model.crud.test.js（issue 503）一致：真实 SQLite 实例 +
// 替身 database.js 连接管理（getDb 指向本文件创建的临时库）。

const TEST_DIR = path.join(os.tmpdir(), `mcs-prune-cutoff-${process.pid}-${Date.now()}`);

let db;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  db = new Database(path.join(TEST_DIR, 'test.db'));
  db.pragma('journal_mode = WAL');

  // 与 database.js createTables 的三表结构一致
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      instance_id TEXT,
      payload TEXT,
      status TEXT DEFAULT 'pending',
      response_status INTEGER,
      response_body TEXT,
      duration_ms INTEGER,
      attempts INTEGER DEFAULT 1,
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
const { WebhookModel } = await import('../db/webhook.model.js');
const { sqliteTimestamp, sqliteCutoff } = await import('../db/sqlite-time.js');

// 固定系统时间：cutoff(90d) = 2026-06-07 10:30:00；cutoff(30d) = 2026-08-06 10:30:00。
// 注意 fake timers 只影响 JS 层 Date，SQLite 的 CURRENT_TIMESTAMP 用真实系统时钟。
const NOW = Date.parse('2026-09-05T10:30:00Z');

const CUT_DAY = '2026-06-07'; // 90 天窗口的 cutoff 同日
const BEFORE_DAY = '2026-06-06'; // cutoff 前一日

function withFixedNow(fn) {
  // fake timers 必须在测试运行时开启（而非模块加载时）：同文件内其他用例的
  // useRealTimers 会恢复真实 Date，固定 now 必须与用例生命周期绑定
  return async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await fn();
    } finally {
      vi.useRealTimers();
    }
  };
}

function remainingTimestamps(table) {
  return db.prepare(`SELECT created_at AS t FROM ${table} ORDER BY id`).all().map((r) => r.t);
}

describe('sqlite-time 与 CURRENT_TIMESTAMP 字节级同构（issue 541 单一来源）', () => {
  it('sqliteTimestamp 输出与 SQLite CURRENT_TIMESTAMP 格式同域（同正则锚定）', () => {
    const colFmt = db.prepare('SELECT CURRENT_TIMESTAMP AS t').get().t;
    const jsFmt = sqliteTimestamp(NOW);
    const fmtRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    expect(colFmt).toMatch(fmtRe);
    expect(jsFmt).toMatch(fmtRe);
  });

  it('sqliteTimestamp 值可被 SQLite datetime() 原样解析回同格式（互认）', () => {
    const ts = sqliteTimestamp(NOW);
    const round = db.prepare('SELECT datetime(?) AS d').get(ts).d;
    expect(round).toBe(ts);
  });

  it('sqliteCutoff(90) 在固定 now 下字节级等于预期 cutoff', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      expect(sqliteCutoff(90)).toBe(`${CUT_DAY} 10:30:00`);
      expect(sqliteCutoff(30)).toBe('2026-08-06 10:30:00');
    } finally {
      vi.useRealTimers();
    }
  });

  it('同格式域内字典序与时间序一致（同构后边界比较的前提）', () => {
    // 同日 "HH:MM:SS" 字符串比较 == 时刻比较；这正是同构修复能消除误删的依据
    expect(`${CUT_DAY} 23:59:59` < `${CUT_DAY} 10:30:00`).toBe(false);
    expect(`${BEFORE_DAY} 23:59:59` < `${CUT_DAY} 10:30:00`).toBe(true);
  });
});

describe('AuditLogModel.prune 边界日不误删（issue 541）', () => {
  it(
    'cutoff 同日时刻边界：晚于/等于不删、早于删、前一日删、now 当日不删',
    withFixedNow(async () => {
      db.prepare('DELETE FROM audit_logs').run();
      const ins = (t) =>
        db.prepare(
          `INSERT INTO audit_logs (instance_id, action, created_at) VALUES (?, ?, ?)`
        ).run('s1', 'INSTANCE_START', t);
      ins(`${CUT_DAY} 23:59:59`); // 同日，晚于 cutoff 时刻 → 保留（修复前被误删的回归锚点）
      ins(`${CUT_DAY} 10:30:00`); // == cutoff（严格 <）→ 保留
      ins(`${CUT_DAY} 10:29:59`); // 同日，早于 cutoff 时刻 → 删
      ins(`${BEFORE_DAY} 23:59:59`); // cutoff 前一日 → 删
      ins('2026-09-05 00:00:00'); // now 当日 → 保留
      // 真实 CURRENT_TIMESTAMP 产出的列值（端到端格式同构验证）→ 保留
      db.prepare(`INSERT INTO audit_logs (instance_id, action) VALUES (?, ?)`).run('s1', 'INSTANCE_START');

      const deleted = AuditLogModel.prune(90);
      expect(deleted).toBe(2);
      expect(remainingTimestamps('audit_logs')).toEqual([
        `${CUT_DAY} 23:59:59`,
        `${CUT_DAY} 10:30:00`,
        '2026-09-05 00:00:00',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/), // CURRENT_TIMESTAMP 行
      ]);
    }),
  );
});

describe('CommandHistoryModel.prune 边界日不误删（issue 541）', () => {
  it(
    'cutoff 同日时刻边界：晚于/等于不删、早于删、前一日删、now 当日不删',
    withFixedNow(async () => {
      db.prepare('DELETE FROM command_history').run();
      const ins = (t) =>
        db.prepare(
          `INSERT INTO command_history (instance_id, command, created_at) VALUES (?, ?, ?)`
        ).run('s1', 'say hi', t);
      ins(`${CUT_DAY} 23:59:59`);
      ins(`${CUT_DAY} 10:30:00`);
      ins(`${CUT_DAY} 10:29:59`);
      ins(`${BEFORE_DAY} 23:59:59`);
      ins('2026-09-05 00:00:00');
      db.prepare(`INSERT INTO command_history (instance_id, command) VALUES (?, ?)`).run('s1', 'list');

      const deleted = CommandHistoryModel.prune(90);
      expect(deleted).toBe(2);
      expect(remainingTimestamps('command_history')).toEqual([
        `${CUT_DAY} 23:59:59`,
        `${CUT_DAY} 10:30:00`,
        '2026-09-05 00:00:00',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      ]);
    }),
  );
});

describe('WebhookModel.pruneDeliveries 边界日不误删（issue 541）', () => {
  it(
    'cutoff(30d) 同日时刻边界：晚于/等于不删、早于删、前一日删、now 当日不删',
    withFixedNow(async () => {
      db.prepare('DELETE FROM webhook_deliveries').run();
      const ins = (t) =>
        db.prepare(
          `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(1, 'instance.start', '{}', 'success', t);
      ins('2026-08-06 23:59:59'); // cutoff 同日，晚于 cutoff 时刻 → 保留
      ins('2026-08-06 10:30:00'); // == cutoff → 保留
      ins('2026-08-06 10:29:59'); // 同日，早于 cutoff 时刻 → 删
      ins('2026-08-05 23:59:59'); // cutoff 前一日 → 删
      ins('2026-09-05 00:00:00'); // now 当日 → 保留
      db.prepare(
        `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status) VALUES (?, ?, ?, ?)`
      ).run(1, 'instance.stop', '{}', 'success'); // CURRENT_TIMESTAMP 行 → 保留

      const deleted = WebhookModel.pruneDeliveries(30);
      expect(deleted).toBe(2);
      expect(remainingTimestamps('webhook_deliveries')).toEqual([
        '2026-08-06 23:59:59',
        '2026-08-06 10:30:00',
        '2026-09-05 00:00:00',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      ]);
    }),
  );
});
