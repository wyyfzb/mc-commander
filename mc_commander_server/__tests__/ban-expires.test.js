/**
 * 原版封禁条目到期时间口径。
 *
 * 承重点：永久只由**缺失/空串/哨兵**判定，临时按 MC 的日期格式解析——此前读侧一律当永久，
 * 于是任何带 `expires` 的官方条目在面板里都显示「永久」，用户看不出它什么时候解封。
 */
import { describe, it, expect } from 'vitest';
import { isBanExpired, parseBanExpires, PERMANENT_EXPIRES } from '../utils/ban-expires.js';

describe('parseBanExpires', () => {
  it('缺失、空串与哨兵 = 永久（MC 自己在无到期时间时写哨兵）', () => {
    for (const value of [undefined, null, '', '  ', 'forever', 'FOREVER', 'Forever']) {
      expect(parseBanExpires(value)).toEqual({ isPermanent: true, expiresAt: null });
    }
  });

  it('MC 的日期格式按带时区解析', () => {
    const mc = parseBanExpires('2030-01-01 06:00:00 +0000');
    expect(mc.isPermanent).toBe(false);
    expect(mc.expiresAt).toBe(Date.parse('2030-01-01T06:00:00Z'));
  });

  it('MC 格式与等价 ISO 串解出同一时刻（写入侧用 ISO，读侧不能只认 MC 格式）', () => {
    expect(parseBanExpires('2030-01-01 06:00:00 +0000').expiresAt).toBe(
      parseBanExpires('2030-01-01T06:00:00Z').expiresAt,
    );
  });

  it('非零时区偏移按其偏移解析', () => {
    expect(parseBanExpires('2030-01-01 06:00:00 -0800').expiresAt).toBe(
      Date.parse('2030-01-01T14:00:00Z'),
    );
  });

  it('已过去的时间点仍如实解出（是否过期交给调用方按 now 判）', () => {
    expect(parseBanExpires('1999-01-01 00:00:00 +0000').expiresAt).toBe(
      Date.parse('1999-01-01T00:00:00Z'),
    );
  });

  it('有值但解析不出 = 非永久且到期时间未知，不假装成永久', () => {
    expect(parseBanExpires('不是时间')).toEqual({ isPermanent: false, expiresAt: null });
    expect(parseBanExpires('2030-13-45 99:99:99 +0000')).toEqual({
      isPermanent: false,
      expiresAt: null,
    });
  });

  it('永久哨兵值与 DB 口径用的远未来值不是一回事', () => {
    expect(PERMANENT_EXPIRES).toBeGreaterThan(Date.now());
  });
});

describe('isBanExpired', () => {
  const NOW = Date.parse('2026-10-08T00:00:00Z');

  it('过期时间已过 = 到期；未到 = 未到期', () => {
    expect(isBanExpired('2026-10-07 15:00:00 +0800', NOW)).toBe(true); // = 07:00Z，早于 NOW
    expect(isBanExpired('2026-10-09 15:00:00 +0800', NOW)).toBe(false);
  });

  it('永久（缺失/哨兵）与解析不出的都不算到期：不擅自替用户解封', () => {
    expect(isBanExpired(undefined, NOW)).toBe(false);
    expect(isBanExpired('forever', NOW)).toBe(false);
    expect(isBanExpired('下周三', NOW)).toBe(false);
  });
});
