import { describe, it, expect } from 'vitest';
import fs from 'fs';

/**
 * 常数时间比较的源码级守卫（与 `error-codes.contract` 同风格的静态断言）。
 *
 * 为什么必须有它：常数时间是**侧信道属性**，功能断言天然抓不到——把
 * `crypto.timingSafeEqual` 换成 `===` 并提前 return/break，全部功能用例仍会全绿
 * （独立审查的变异探针实测：改掉恢复码的恒时比较后 74 条断言 0 红）。本文件把
 * 「用了恒时比较」「循环内不提前退出」「不按摘要做等值查询」钉成可执行断言，
 * 防止未来重构无声破坏这个无法用行为用例覆盖的性质。
 */

const TOTP_SRC = fs.readFileSync(new URL('../utils/totp.js', import.meta.url), 'utf-8');
const MODEL_SRC = fs.readFileSync(new URL('../db/admin.model.js', import.meta.url), 'utf-8');

/** 取 marker 之后第一个 `{` 起、花括号配平到对应 `}` 的函数体源码 */
function sliceBracedBody(src, marker) {
  const at = src.indexOf(marker);
  expect(at, `源码中未找到 ${marker}`).toBeGreaterThan(-1);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`函数体未闭合：${marker}`);
}

describe('动态口令比较：恒时比较源码守卫', () => {
  it('6 位码比较走 crypto.timingSafeEqual，且带长度守卫（不等长返回 false 而非抛出）', () => {
    const body = sliceBracedBody(TOTP_SRC, 'function timingSafeEqualDigits');
    expect(body).toContain('crypto.timingSafeEqual(');
    // 长度不等必须先返回：timingSafeEqual 对不等长入参抛异常，异常本身就是信号
    expect(body).toMatch(/length\s*!==\s*\w+\.length/);
    expect(body).toContain('return false');
  });

  it('候选码与期望码之间不存在字符串等值比较（比较必须经恒时比较器）', () => {
    // 期望码来自 hotp(...)：它不得直接与候选码做 ===/==（null 判定等非比较用途不在此列）
    expect(TOTP_SRC).not.toMatch(/hotp\([^)]*\)\s*===/);
    expect(TOTP_SRC).not.toMatch(/===\s*hotp\(/);
    // 漂移窗内的比较唯一入口是恒时比较器
    expect(TOTP_SRC).toMatch(/timingSafeEqualDigits\(hotp\(/);
  });

  it('漂移窗三个候选全部比较完再判定（循环内无 return/break）', () => {
    const body = sliceBracedBody(TOTP_SRC, 'export function verifyTotpCode');
    const loopStart = body.indexOf('for (');
    const loopEnd = body.indexOf('if (matchedStep === null)');
    expect(loopStart).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loop = body.slice(loopStart, loopEnd);
    expect(loop).toContain('timingSafeEqualDigits(');
    expect(loop).not.toContain('return');
    expect(loop).not.toContain('break');
  });
});

describe('恢复码比较：恒时比较 + 不提前退出源码守卫', () => {
  it('定长摘要比对走 crypto.timingSafeEqual', () => {
    const body = sliceBracedBody(MODEL_SRC, 'static verifyAndConsume(code)');
    expect(body).toContain('crypto.timingSafeEqual(');
  });

  it('不按摘要做等值查询（等值索引查询会通过命中顺序泄漏前缀命中信息）', () => {
    const body = sliceBracedBody(MODEL_SRC, 'static verifyAndConsume(code)');
    expect(body).not.toMatch(/code_hash\s*=\s*\?/i);
    expect(body).not.toMatch(/WHERE\s+code_hash\s*=/i);
  });

  it('循环内先比长度再恒时比较，且无 break / 命中即 return', () => {
    const body = sliceBracedBody(MODEL_SRC, 'static verifyAndConsume(code)');
    const loopStart = body.indexOf('for (');
    const loopEnd = body.indexOf('if (matchedId === null)');
    expect(loopStart).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loop = body.slice(loopStart, loopEnd);
    expect(loop).toContain('length !==');
    expect(loop).toContain('crypto.timingSafeEqual(');
    expect(loop).not.toContain('break');
    expect(loop).not.toContain('return');
  });

  it('一次性消费走条件更新（并发同码只有一次成功）', () => {
    const body = sliceBracedBody(MODEL_SRC, 'static verifyAndConsume(code)');
    expect(body).toContain('WHERE id = ? AND used_at IS NULL');
  });
});
