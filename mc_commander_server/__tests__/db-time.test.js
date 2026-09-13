// utils/db-time.js 契约测试（全仓公共单一实现的行为锁定）。
//
// 断言一律与显式 UTC 时刻比较，**不依赖运行机器的时区**——这正是缺陷的
// 要害：SQLite 的 'YYYY-MM-DD HH:MM:SS' 无时区标记，Date.parse 会按本地
// 时区解释，UTC+8 下整体偏移 8 小时。
//
// ⚠️ 注意鉴别力边界：上面这些断言在 UTC 宿主（CI 默认）上**无法区分**归一化
// 实现与裸 Date.parse（两者结果相同）。故末尾另有「时区不变性」用例，在子进程
// 固定 TZ=Asia/Shanghai 复算——改回裸解析时它才会在任意时区的 CI 上变红。

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { toIsoUtc, parseDbTime, toDbUtcString } from '../utils/db-time.js';

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

  it('epoch 毫秒数值按时刻处理（不是 String(v) 原样透传）', () => {
    expect(toIsoUtc(Date.UTC(2026, 8, 10, 16, 55, 36))).toBe('2026-09-10T16:55:36.000Z');
  });

  it('Date 对象按时刻处理（与 toDbUtcString 对称；原实现会透传 toString() 本地化长串）', () => {
    expect(toIsoUtc(new Date(Date.UTC(2026, 8, 10, 16, 55, 36)))).toBe('2026-09-10T16:55:36.000Z');
    expect(toIsoUtc(new Date('not a date'))).toBeNull();
  });

  it('非有限与越界数值一律返回 null（Date 构造抛 RangeError 的两档）', () => {
    // 非有限：NaN / ±Infinity
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(toIsoUtc(v)).toBeNull();
    }
    // 有限但越界（|v| > 8.64e15）：Number.isFinite 拦不住，须由 getTime() 判 NaN
    for (const v of [8.64e15 + 1, 1e16, 1e300, Number.MAX_SAFE_INTEGER]) {
      expect(toIsoUtc(v)).toBeNull();
    }
    // 边界值本身仍是合法时刻
    expect(toIsoUtc(8.64e15)).not.toBeNull();
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

  it('epoch 毫秒入参返回该时刻本身（回归：原实现经 String(v) 得 NaN → 0）', () => {
    const t = Date.UTC(2026, 8, 10, 16, 55, 36);
    expect(parseDbTime(t)).toBe(t);
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

// ── toDbUtcString：cutoff 必须与 naive 列同口径 ──
//
// 保留策略（prune）拿 cutoff 与 created_at 做**字符串**比较。若 cutoff 用
// toISOString()，同一天的记录在第 11 位比较时 ' '(0x20) < 'T'(0x54) 恒成立，
// 整日被判为「更旧」而被多删（最多约一天）——本组用例锁住正确口径。
describe('toDbUtcString', () => {
  it('Date → CURRENT_TIMESTAMP 口径（秒级、空格分隔、UTC）', () => {
    expect(toDbUtcString(new Date(Date.UTC(2026, 8, 10, 16, 55, 36, 789)))).toBe('2026-09-10 16:55:36');
  });

  it('epoch 毫秒入参等价', () => {
    expect(toDbUtcString(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01 00:00:00');
  });

  it('结果是真时间序：同一天内较早时刻字符串更小；ISO 形态则会判错', () => {
    const early = toDbUtcString(Date.UTC(2026, 8, 10, 1, 0, 0));
    const late = toDbUtcString(Date.UTC(2026, 8, 10, 23, 0, 0));
    expect(early < late).toBe(true);
    // 反证：cutoff 若取 ISO 形态，同一天 23:00 的记录与 01:00 的 cutoff 比较时
    // 在第 11 位 ' '(0x20) < 'T'(0x54) 直接判小 → 明明更晚却算「更旧」被删
    const isoCutoff = new Date(Date.UTC(2026, 8, 10, 1, 0, 0)).toISOString();
    expect(late < isoCutoff).toBe(true);
    expect(early < isoCutoff).toBe(true);
  });

  it('无法解析返回 null（调用方不得拿它当 cutoff）', () => {
    expect(toDbUtcString('garbage')).toBeNull();
  });
});

// ── 时区不变性（本文件唯一具备跨时区鉴别力的用例）──
//
// 前面所有断言拿显式 UTC 常量比较，在 UTC 宿主上裸解析恰好给出同一值，
// 即 CI（默认 UTC）会放行「改回裸 Date.parse」的回退。本用例在子进程里
// 固定 TZ=Asia/Shanghai 复算，两条断言分别锁住「该时区下裸解析确实偏移」
// （前提）与「本模块不受宿主时区影响」（结论）。
describe('时区不变性（子进程强制 TZ=Asia/Shanghai）', () => {
  it('UTC+8 下裸解析偏移 8 小时，本模块不偏移', () => {
    const modUrl = new URL('../utils/db-time.js', import.meta.url).href;
    const script = `
      const m = await import(${JSON.stringify(modUrl)});
      console.log(JSON.stringify({
        naive: Date.parse('2026-09-10 16:55:36'),
        normalized: m.parseDbTime('2026-09-10 16:55:36'),
        expected: Date.UTC(2026, 8, 10, 16, 55, 36),
      }));
    `;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, TZ: 'Asia/Shanghai' },
    });
    const { naive, normalized, expected } = JSON.parse(stdout.trim());
    expect(naive, 'TZ=Asia/Shanghai 未生效，本用例失去鉴别力（应修复子进程环境，而非放宽本断言）').not.toBe(expected); // 前提：若无此偏移，TZ 未生效
    expect(normalized).toBe(expected);
  });
});
