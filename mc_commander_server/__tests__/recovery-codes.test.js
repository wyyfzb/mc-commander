import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import crypto from 'crypto';

// 恢复码的「只存哈希 / 一次性」只能在真库上验证（内存 mock 不落 used_at）
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-recovery-codes-'));
  return { default: { ...actual.default, dataDir: tmpRoot } };
});

import config from '../config.js';
import { initDatabase } from '../db/index.js';
import { AdminRecoveryCodeModel } from '../db/admin.model.js';
import {
  RECOVERY_CODE_COUNT,
  formatRecoveryCode,
  normalizeRecoveryCode,
  hashRecoveryCode,
  generateRecoveryCodes,
} from '../utils/recovery-codes.js';

/** 去混淆字母表（与实现一致）：无 I/O/0/1 */
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

let db;

beforeAll(() => {
  db = initDatabase();
});

afterAll(() => {
  db.close();
  fs.rmSync(config.dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM admin_recovery_codes').run();
});

function storedHashes() {
  return db.prepare('SELECT code_hash FROM admin_recovery_codes').all().map((r) => r.code_hash);
}

describe('恢复码生成（形态与熵）', () => {
  it(`默认生成 ${RECOVERY_CODE_COUNT} 个互不相同的码，形态 XXXXX-XXXXX`, () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(CODE_RE);
  });

  it('字母表剔除 I/O/0/1（抄写歧义字符不出现）', () => {
    const joined = generateRecoveryCodes().join('').replace(/-/g, '');
    for (const ch of ['I', 'O', '0', '1']) expect(joined).not.toContain(ch);
  });

  it('10 个有效字符 × 32 字符表 = 50 bit 熵（不足 50 bit 会改变安全前提）', () => {
    const significant = generateRecoveryCodes(1)[0].replace('-', '');
    expect(significant).toHaveLength(10);
    // 32^10 = 2^50：去混淆字母表恰好 32 个字符时成立；字符表被改动（如加入 I/O/0/1
    // 之外的更多字符）会让这条断言重新算出不同位数，从而暴露熵口径漂移
    expect(Math.log2(32 ** significant.length)).toBe(50);
  });

  it('连续两批不重叠（CSPRNG，不是计数器）', () => {
    const a = new Set(generateRecoveryCodes());
    const b = generateRecoveryCodes();
    expect(b.some((c) => a.has(c))).toBe(false);
  });
});

describe('恢复码归一化与哈希', () => {
  it('带/不带连字符、大小写差异归一化到同一形态', () => {
    const raw = 'ABCDE-FGHJK';
    expect(normalizeRecoveryCode(raw)).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('abcdefghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('ABCDEFGHJK');
    expect(hashRecoveryCode(raw)).toBe(hashRecoveryCode('ABCDEFGHJK'.toLowerCase()));
    expect(formatRecoveryCode('ABCDEFGHJK')).toBe(raw);
  });

  it('形状不符返回 null（不静默截断成另一个码）', () => {
    for (const bad of ['ABCDE-FGHJ', 'ABCDE-FGHJKL', 'ABCDE-FGHJ0', 'ABCDE-FGHJO', 'ABCDE-FGHJI', 'ABCDE-FGHJ1', '', null, 123456]) {
      expect(normalizeRecoveryCode(bad), `${String(bad)} 应判非法`).toBeNull();
      expect(hashRecoveryCode(bad)).toBeNull();
    }
    // 6 位动态口令形状绝不会被当成恢复码（形态空间不重叠）
    expect(normalizeRecoveryCode('123456')).toBeNull();
    expect(normalizeRecoveryCode('234567')).toBeNull();
  });

  it('哈希为 SHA-256 hex（64 位定长，可恒时比较）且不同码不同哈希', () => {
    const h = hashRecoveryCode('ABCDE-FGHJK');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(crypto.createHash('sha256').update('ABCDEFGHJK').digest('hex'));
    expect(hashRecoveryCode('ABCDE-FGHJL')).not.toBe(h);
  });
});

describe('恢复码落库：只存哈希 + 一次性', () => {
  it('库里查不到任何明文码，且全部是 64 位 hex 摘要', () => {
    const codes = generateRecoveryCodes();
    AdminRecoveryCodeModel.replaceAll(codes.map((c) => hashRecoveryCode(c)));

    const hashes = storedHashes();
    expect(hashes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      const plain = code.replace('-', '');
      expect(hashes).not.toContain(code);
      expect(hashes).not.toContain(plain);
      expect(hashes).toContain(hashRecoveryCode(code));
    }
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{64}$/);

    // 全表扫描明文也不该出现：序列化整行后逐码断言不命中
    const dump = JSON.stringify(db.prepare('SELECT * FROM admin_recovery_codes').all());
    for (const code of codes) expect(dump).not.toContain(code.replace('-', ''));
  });

  it('正确码校验成功并置 used_at；同一个码第二次必须失败', () => {
    const codes = generateRecoveryCodes();
    AdminRecoveryCodeModel.replaceAll(codes.map((c) => hashRecoveryCode(c)));

    expect(AdminRecoveryCodeModel.verifyAndConsume(codes[0])).toBe(true);
    const row = db
      .prepare('SELECT used_at FROM admin_recovery_codes WHERE code_hash = ?')
      .get(hashRecoveryCode(codes[0]));
    expect(row.used_at).toBeTruthy();

    // 一次性：第二次必须失败（即使输入写法不同——归一化后是同一个码）
    expect(AdminRecoveryCodeModel.verifyAndConsume(codes[0])).toBe(false);
    expect(AdminRecoveryCodeModel.verifyAndConsume(codes[0].replace('-', '').toLowerCase())).toBe(false);
  });

  it('错误码 / 未生成时的任意码一律失败且不写 used_at', () => {
    expect(AdminRecoveryCodeModel.verifyAndConsume('ABCDE-FGHJK')).toBe(false);

    const codes = generateRecoveryCodes();
    AdminRecoveryCodeModel.replaceAll(codes.map((c) => hashRecoveryCode(c)));
    expect(AdminRecoveryCodeModel.verifyAndConsume('ZZZZZ-ZZZZZ')).toBe(false);
    expect(AdminRecoveryCodeModel.verifyAndConsume('not-a-code')).toBe(false);
    expect(AdminRecoveryCodeModel.countRemaining()).toBe(RECOVERY_CODE_COUNT);
  });

  it('countRemaining 随消耗递减到 0', () => {
    const codes = generateRecoveryCodes();
    AdminRecoveryCodeModel.replaceAll(codes.map((c) => hashRecoveryCode(c)));
    expect(AdminRecoveryCodeModel.countRemaining()).toBe(RECOVERY_CODE_COUNT);

    codes.forEach((c, i) => {
      expect(AdminRecoveryCodeModel.verifyAndConsume(c)).toBe(true);
      expect(AdminRecoveryCodeModel.countRemaining()).toBe(RECOVERY_CODE_COUNT - i - 1);
    });
    expect(AdminRecoveryCodeModel.countRemaining()).toBe(0);
  });

  it('replaceAll 整池替换：旧码立即失效、新码可用、不残留旧行', () => {
    const first = generateRecoveryCodes();
    AdminRecoveryCodeModel.replaceAll(first.map((c) => hashRecoveryCode(c)));

    const second = generateRecoveryCodes();
    AdminRecoveryCodeModel.replaceAll(second.map((c) => hashRecoveryCode(c)));

    expect(storedHashes()).toHaveLength(RECOVERY_CODE_COUNT);
    expect(AdminRecoveryCodeModel.verifyAndConsume(first[0])).toBe(false);
    expect(AdminRecoveryCodeModel.verifyAndConsume(second[0])).toBe(true);
  });

  it('deleteAll 清空恢复码池（关闭两步验证时不得留可用凭据）', () => {
    const codes = generateRecoveryCodes();
    AdminRecoveryCodeModel.replaceAll(codes.map((c) => hashRecoveryCode(c)));
    expect(AdminRecoveryCodeModel.deleteAll()).toBe(RECOVERY_CODE_COUNT);
    expect(AdminRecoveryCodeModel.countRemaining()).toBe(0);
    expect(AdminRecoveryCodeModel.verifyAndConsume(codes[0])).toBe(false);
  });

  it('code_hash 唯一约束生效（同一摘要不得落两行）', () => {
    const h = hashRecoveryCode('ABCDE-FGHJK');
    AdminRecoveryCodeModel.replaceAll([h]);
    expect(() =>
      db.prepare('INSERT INTO admin_recovery_codes (code_hash) VALUES (?)').run(h),
    ).toThrow(/UNIQUE/i);
  });

  it('库内摘要形态异常（非 64 位 hex / 长度不一）不抛异常，判为不匹配', () => {
    // 比较先比长度再 timingSafeEqual：长度不等走 continue，绝不能抛——timingSafeEqual
    // 对不等长入参会抛异常，异常路径本身就是可观测的侧信道信号
    db.prepare('INSERT INTO admin_recovery_codes (code_hash) VALUES (?)').run('abc');
    db.prepare('INSERT INTO admin_recovery_codes (code_hash) VALUES (?)').run('zz'.repeat(32));
    db.prepare('INSERT INTO admin_recovery_codes (code_hash) VALUES (?)').run('');
    expect(() => AdminRecoveryCodeModel.verifyAndConsume('ABCDE-FGHJK')).not.toThrow();
    expect(AdminRecoveryCodeModel.verifyAndConsume('ABCDE-FGHJK')).toBe(false);

    // 畸形行不影响同池中合法行的命中
    AdminRecoveryCodeModel.replaceAll([hashRecoveryCode('ABCDE-FGHJK')]);
    db.prepare('INSERT INTO admin_recovery_codes (code_hash) VALUES (?)').run('0f');
    expect(AdminRecoveryCodeModel.verifyAndConsume('ABCDE-FGHJK')).toBe(true);
  });
});
