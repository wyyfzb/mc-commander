/**
 * 本地时区日期键（utils/local-date.js）
 * 契约：取「本地那一天」，而非 UTC 那一天；格式 YYYY-MM-DD（月/日补零）。
 * 用「本地构造的 Date」断言可绕过机器时区差异：`new Date(2026, 0, 5, 7, 30)` 的本地日
 * 恒为 01-05，而 UTC 实现会在 UTC+8 这类东八区返回 01-04（07:30 本地 = 前一天 23:30Z）。
 */
import { describe, it, expect } from 'vitest';
import { localDateKey, localTimestamp } from '../utils/local-date.js';

describe('localDateKey', () => {
  it('月/日补零为 YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5, 12, 0))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('取本地那一天：与 toISOString 的 UTC 口径在时区偏移下分叉', () => {
    // 取本地当日的两端：**非零偏移**时区至少有一端与 UTC 日不同
    // （+08 的 00:30 本地 = 前一天 16:30Z；-05 的 23:30 本地 = 次日 04:30Z）。
    // 注意：零偏移时区（UTC 机器、欧洲/伦敦冬季）两端都不分叉——CI 是 ubuntu 默认 UTC，
    // 这条断言在 CI 上没有分辨力，只能守开发机（本仓开发机为 +08）。要让它进 CI 需在
    // 服务端 vitest 配置里钉 TZ，届时须全量复跑验证。
    expect(localDateKey(new Date(2026, 0, 5, 0, 30))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });

  it('默认参数取当前时间', () => {
    const now = new Date();
    expect(localDateKey()).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    );
  });
});

describe('localTimestamp（用户可见备份名里的时刻）', () => {
  it('格式为 YYYY-MM-DDTHH-mm-ss-SSS，补零到毫秒且不带 Z（带 Z 会被读成 UTC）', () => {
    const t = localTimestamp(new Date(2026, 0, 5, 7, 8, 9, 42));
    expect(t).toBe('2026-01-05T07-08-09-042');
    expect(t).not.toContain('Z');
  });

  it('取本地时刻：零点前后与 UTC 口径在非零偏移时区下分叉', () => {
    // 同 localDateKey 的时区前提：零偏移时区（CI 的 UTC）不分叉
    expect(localTimestamp(new Date(2026, 0, 5, 0, 30, 0, 0))).toBe('2026-01-05T00-30-00-000');
    expect(localTimestamp(new Date(2026, 0, 5, 23, 30, 0, 0))).toBe('2026-01-05T23-30-00-000');
  });
});
