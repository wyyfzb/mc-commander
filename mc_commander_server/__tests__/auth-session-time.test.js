// 会话中间件时间口径契约：把「naive UTC 串 → 会话过期/续期判定」这条链路钉死在
// **任意宿主时区**下都成立。
//
// 为什么单独一个文件、且必须走子进程：`utils/db-time.js` 自身有 db-time.test.js
// 的时区不变性用例护着，但那只证明工具函数是对的——**调用点被改回裸解析时它不会红**。
// 实测：把 middleware/auth.js 的 parseDbTime 换回 new Date(...).getTime()，服务端
// 全量 1839 例依旧全绿（会话 fixture 用 ISO 种子，任何时区下裸解析都恰好正确）。
// 本文件用 production 同款的 CURRENT_TIMESTAMP 口径种子 + 子进程固定
// TZ=Asia/Shanghai，让「调用点回退」在 UTC 的 CI 上也变红。

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const DAY = 86_400_000;

/** 在指定时区下复算会话判定，返回结构化结果 */
function probeSessionTime(tz) {
  const mwUrl = new URL('../middleware/auth.js', import.meta.url).href;
  const cfgUrl = new URL('../config.js', import.meta.url).href;
  const dbTimeUrl = new URL('../utils/db-time.js', import.meta.url).href;
  const script = `
    const m = await import(${JSON.stringify(mwUrl)});
    const dbTime = await import(${JSON.stringify(dbTimeUrl)});
    const { default: config } = await import(${JSON.stringify(cfgUrl)});
    config.adminSession.absoluteTtlMs = 30 * ${DAY};
    config.adminSession.ttlMs = 7 * ${DAY};
    const DAY = ${DAY};
    // production 同款口径：SQLite CURRENT_TIMESTAMP 的无时区 UTC 串
    const naive = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
    const created29 = naive(29 * DAY);
    const created31 = naive(31 * DAY);
    // 边界探针：29 天 20 小时（未过期）。裸解析在 UTC+8 下把 created_at 算早 8 小时
    // → 边界前移到 30 天 4 小时前，这条会话被误判为**已过期**，与正确判定相反
    // （缺陷方向是「会话过早失效」，故探针取边界内侧而非外侧）。
    const created29d20h = naive(29.83 * DAY);
    const created29_5 = naive(29.5 * DAY);
    const cap = m.slidingExpiry({ created_at: created29_5 });
    console.log(JSON.stringify({
      // 前提：该时区下裸解析与本模块的归一化解析确实不同（否则本用例失去鉴别力）
      bareParseDiffers: Date.parse(created29) !== Date.parse(created29.replace(' ', 'T') + 'Z'),
      expired29: m.isAbsolutelyExpired({ created_at: created29 }),
      expired31: m.isAbsolutelyExpired({ created_at: created31 }),
      expired29d20h: m.isAbsolutelyExpired({ created_at: created29d20h }),
      // 缺列语义：created_at 取不到时不施加绝对上限（不据此把会话判死）
      expiredMissing: m.isAbsolutelyExpired({ created_at: null }),
      capParsed: Date.parse(cap),
      capExpected: dbTime.parseDbTime(created29_5) + 30 * DAY,
    }));
  `;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    // DOTENV_CONFIG_QUIET：config.js 经 .env 加载会往 stdout 打一行提示，
    // 与子进程的 JSON 输出混流；取最后一行兜底，双保险。
    env: { ...process.env, TZ: tz, DOTENV_CONFIG_QUIET: 'true' },
  });
  return JSON.parse(stdout.trim().split('\n').pop());
}

describe('会话时间口径（子进程固定 TZ=Asia/Shanghai，UTC+8）', () => {
  const r = probeSessionTime('Asia/Shanghai');

  it('前提：UTC+8 下裸解析与归一化解析结果不同（本用例具备鉴别力）', () => {
    expect(r.bareParseDiffers).toBe(true);
  });

  it('绝对过期边界按真实 UTC 时刻判定，不因宿主时区前移 8 小时', () => {
    expect(r.expired29).toBe(false);
    expect(r.expired31).toBe(true);
    // 边界探针：回退到裸 new Date() 时在 UTC+8 下会被误判为「已过期」→ 断言失败
    expect(r.expired29d20h).toBe(false);
  });

  it('created_at 缺失时不施加绝对上限（旧库缺列不至于把全部会话判死）', () => {
    expect(r.expiredMissing).toBe(false);
  });

  it('滑动续期 cap 锚在归一化后的 created_at + absoluteTtlMs', () => {
    // 回退到裸 new Date() 时 capParsed 会整体早 8 小时 → 断言失败
    expect(Math.abs(r.capParsed - r.capExpected)).toBeLessThanOrEqual(2_000);
  });
});
