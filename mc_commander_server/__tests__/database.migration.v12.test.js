import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

// 独立临时 dataDir：本文件模拟「存量 v11 库（无 TOTP 列）升级到 v12」
vi.mock('../config.js', async () => {
  const fsMod = await import('fs');
  const os = await import('os');
  const tmpRoot = fsMod.mkdtempSync(path.join(os.tmpdir(), 'mc-db-v12-'));
  return { default: { dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/database.js';

const dbPath = path.join(config.dataDir, 'mc_commander.db');

/** 存量 v11 库：admin_account 只有密码与预留 secret 列，且带一行真实数据 */
function buildLegacyV11Db() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('user_version = 11');
  raw.exec(`
    CREATE TABLE admin_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      password_hash TEXT NOT NULL,
      totp_secret TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  raw
    .prepare(
      `INSERT INTO admin_account (id, password_hash, totp_secret, created_at)
     VALUES (1, 'scrypt$131072$8$1$c2FsdA==$aGFzaA==', 'KEEP-ME-PLEASE', '2026-01-01 00:00:00')`,
    )
    .run();
  raw.close();
}

function columnsOf(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

describe('数据库 v11→v12 迁移（存量库 + 存量行）', () => {
  let db;

  beforeAll(() => {
    buildLegacyV11Db();
    // 首次升级：v12 块逐列 ALTER + 建恢复码表
    db = initDatabase();
  });

  afterAll(() => {
    db?.close();
    fs.rmSync(config.dataDir, { recursive: true, force: true });
  });

  it('user_version 升到 15（v11→v12→v13 连续；后续迁移块照常衔接）', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(15);
  });

  it('admin_account 补齐三列，类型与默认值符合契约', () => {
    expect(columnsOf(db, 'admin_account')).toEqual(
      expect.arrayContaining([
        'totp_secret',
        'totp_enabled',
        'totp_confirmed_at',
        'totp_last_step',
      ]),
    );
    const info = Object.fromEntries(
      db
        .prepare('PRAGMA table_info(admin_account)')
        .all()
        .map((c) => [c.name, c]),
    );
    // 存量行必须回填 0（NOT NULL DEFAULT），否则 getTotpState 的 === 1 判定会漏
    expect(info.totp_enabled.type).toBe('INTEGER');
    expect(info.totp_enabled.notnull).toBe(1);
    expect(info.totp_enabled.dflt_value).toBe('0');
  });

  it('存量行保留：密码哈希与预留 secret 不被清空，新列取默认值', () => {
    const row = db.prepare('SELECT * FROM admin_account WHERE id = 1').get();
    expect(row.password_hash).toBe('scrypt$131072$8$1$c2FsdA==$aGFzaA==');
    expect(row.totp_secret).toBe('KEEP-ME-PLEASE');
    expect(row.totp_enabled).toBe(0);
    expect(row.totp_confirmed_at).toBeNull();
    expect(row.totp_last_step).toBeNull();
    expect(row.created_at).toBe('2026-01-01 00:00:00');
  });

  it('恢复码表与索引就位（只存哈希的一次性码池）', () => {
    expect(columnsOf(db, 'admin_recovery_codes')).toEqual(
      expect.arrayContaining(['id', 'code_hash', 'used_at', 'created_at']),
    );
    const indexes = db
      .prepare('PRAGMA index_list(admin_recovery_codes)')
      .all()
      .map((i) => i.name);
    expect(indexes).toContain('idx_admin_recovery_codes_unused');
    // code_hash 唯一（同一摘要不得落两行）
    const unique = db
      .prepare('PRAGMA index_list(admin_recovery_codes)')
      .all()
      .some((i) => i.unique === 1);
    expect(unique).toBe(true);
  });

  it('重复执行迁移幂等：列已存在时不报错、user_version 保持 14、数据不变', () => {
    // 把版本号退回 11，强制 v12 块再跑一次（模拟「列已存在但版本落后」的导入/半迁移）
    db.pragma('user_version = 11');
    db.close();
    db = initDatabase();

    expect(db.pragma('user_version', { simple: true })).toBe(15);
    expect(db.prepare('SELECT totp_secret FROM admin_account WHERE id = 1').get().totp_secret).toBe(
      'KEEP-ME-PLEASE',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM admin_account').get().n).toBe(1);
  });
});
