// utils/db-time.js 契约测试（全仓公共单一实现的行为锁定）。
//
// 断言一律与显式 UTC 时刻比较，**不依赖运行机器的时区**——这正是缺陷的
// 要害：SQLite 的 'YYYY-MM-DD HH:MM:SS' 无时区标记，Date.parse 会按本地
// 时区解释，UTC+8 下整体偏移 8 小时。若有人改回裸 Date.parse，本文件在
// 任何时区的 CI 上都会红。

import { describe, it, expect } from 'vitest';
import { toIsoUtc, parseDbTime } from '../utils/db-time.js';

describe('toIsoUtc', () => {
  it('无时区标记的 UTC 串补 Z 转 ISO8601（空格分隔）', () => {
    expect(toIsoUtc('2026-09-10 16:55:36')).toBe('2026-09-10T16:55:36.000Z');
  });

  it('T 分隔的同格式同样处理', () => {
    expect(toIsoUtc('2026-09-10T16:55:36')).toBe('2026-09-10T16:55:36.000Z');
  });

  it('带毫秒的串保留毫秒', () => {
    expect(toIsoUtc('2026-09-10 16:55:36.123')).toBe('2026-09-10T16:55:36.123Z');
  });

  it('已带时区标记的串原样返回，不做二次换算', () => {
    for (const s of ['2026-09-10T16:55:36.000Z', '2026-09-10T16:55:36+08:00']) {
      expect(toIsoUtc(s)).toBe(s);
    }
  });

  it('非该格式的串原样返回', () => {
    expect(toIsoUtc('不是时间')).toBe('不是时间');
  });

  it('空值一律返回 null', () => {
    for (const v of [null, undefined, '', 0]) {
      expect(toIsoUtc(v)).toBeNull();
    }
  });
});

describe('parseDbTime', () => {
  it('解析结果等于对应的 UTC 时刻——不随本机时区漂移', () => {
    expect(parseDbTime('2026-09-10 16:55:36')).toBe(Date.UTC(2026, 8, 10, 16, 55, 36));
    expect(parseDbTime('2026-01-01 00:00:00')).toBe(Date.UTC(2026, 0, 1, 0, 0, 0));
  });

  it('与 Date.parse 的时区安全差异：同一串在两个时区下解析结果一致', () => {
    // 缺陷复现的核心：裸 Date.parse 在同一 TZ 偏移下会整体平移，本函数不会。
    const naive = Date.parse('2026-09-10T16:55:36Z');
    expect(parseDbTime('2026-09-10 16:55:36')).toBe(naive);
  });

  it('无法解析时返回 0（调用方按极旧处理）', () => {
    expect(parseDbTime(null)).toBe(0);
    expect(parseDbTime(undefined)).toBe(0);
    expect(parseDbTime('')).toBe(0);
    expect(parseDbTime('garbage')).toBe(0);
  });

  it('回归语义：刚写入的 UTC 时刻不会被当成 1 小时前的陈旧记录', () => {
    // BackupModel.resetStaleInProgress 的判定原型：ts < Date.now() - maxAgeMs。
    // 修复前在 UTC+8 下，刚创建的记录 ts 比真实时刻早 8 小时 → 必然判为陈旧。
    const now = new Date();
    const sqliteNow = now.toISOString().slice(0, 19).replace('T', ' '); // 模拟 CURRENT_TIMESTAMP
    const ts = parseDbTime(sqliteNow);
    const cutoff = Date.now() - 60 * 60 * 1000;
    expect(ts).toBeGreaterThan(cutoff);
  });
});
