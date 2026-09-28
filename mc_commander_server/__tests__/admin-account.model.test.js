import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';

// dataDir 指向临时目录（真实 SQLite）：本文件验证的是「改密与 TOTP 挂靠共处同一行」
// 的列保留语义，必须在真库上验证（内存 mock 无法呈现 REPLACE 的先删后插）
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-admin-account-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminAccountModel } from '../db/admin.model.js';
import { hashPassword, verifyPassword } from '../utils/password.js';

let db;

// 预置固定历史时间戳再断言：CURRENT_TIMESTAMP 只有秒级精度，重置值与断言时的当前秒
// 相同时，「被重置」与「未被触碰」会得到同一结果，守卫退化为恒真
const HISTORICAL = '2020-01-01 00:00:00';

function seedTimestamps(createdAt = HISTORICAL, updatedAt = createdAt) {
  db.prepare('UPDATE admin_account SET created_at = ?, updated_at = ? WHERE id = 1').run(
    createdAt,
    updatedAt,
  );
}

function readAccount() {
  return db.prepare('SELECT * FROM admin_account WHERE id = 1').get();
}

beforeAll(() => {
  db = initDatabase();
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM admin_account').run();
});

// 每个 it 只守一条不变式：断言从上到下短路，合并进同一用例会让首条失败掩盖其余守卫，
// 使「用例名宣称的守卫」实际未被验证
describe('AdminAccountModel 单行更新语义', () => {
  it('首次 setPassword 走插入路径：单行、哈希可验证、时间列有值', () => {
    AdminAccountModel.setPassword(hashPassword('first-pass-123'));

    const rows = db.prepare('SELECT * FROM admin_account').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(verifyPassword('first-pass-123', rows[0].password_hash)).toBe(true);
    expect(rows[0].created_at).toBeTruthy();
    expect(rows[0].updated_at).toBeTruthy();
    expect(rows[0].totp_secret).toBeNull();
  });

  it('改密不重置 created_at', () => {
    AdminAccountModel.setPassword(hashPassword('old-pass-1234'));
    seedTimestamps();

    AdminAccountModel.setPassword(hashPassword('new-pass-5678'));

    expect(readAccount().created_at).toBe(HISTORICAL);
  });

  it('改密不清空 totp_secret，且旧密码失效、新密码可验', () => {
    AdminAccountModel.setPassword(hashPassword('old-pass-1234'));
    AdminAccountModel.setTotpSecret('JBSWY3DPEHPK3PXP');

    const newHash = hashPassword('new-pass-5678');
    AdminAccountModel.setPassword(newHash);

    const row = readAccount();
    expect(row.totp_secret).toBe('JBSWY3DPEHPK3PXP');
    expect(row.password_hash).toBe(newHash);
    expect(verifyPassword('new-pass-5678', row.password_hash)).toBe(true);
    expect(verifyPassword('old-pass-1234', row.password_hash)).toBe(false);
  });

  it('改密刷新 updated_at', () => {
    AdminAccountModel.setPassword(hashPassword('old-pass-1234'));
    seedTimestamps();

    AdminAccountModel.setPassword(hashPassword('new-pass-5678'));

    expect(readAccount().updated_at).not.toBe(HISTORICAL);
  });

  it('setTotpSecret 不触碰密码哈希与 created_at', () => {
    const stored = hashPassword('keep-pass-999');
    AdminAccountModel.setPassword(stored);
    seedTimestamps();

    AdminAccountModel.setTotpSecret('KRSXG5CTMVRXEZLU');

    const row = readAccount();
    expect(row.password_hash).toBe(stored);
    expect(row.created_at).toBe(HISTORICAL);
  });
});
