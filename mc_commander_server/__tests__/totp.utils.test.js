import { describe, it, expect, beforeAll } from 'vitest';
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_DRIFT_STEPS,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  currentTimeStep,
  hotp,
  totpCodeAtStep,
  normalizeTotpCode,
  verifyTotpCode,
  buildOtpauthUrl,
} from '../utils/totp.js';

/**
 * RFC 6238 附录 B 的 SHA-1 测试向量。secret 是 ASCII 串 "12345678901234567890"
 * （20 字节，与 RFC 4226 附录 D 同源），base32 形态即认证器 App 里录入的那个。
 * 附录 B 给的是 8 位码；本仓固定 6 位（主流认证器默认），故断言「8 位码的后 6 位」。
 */
const RFC_SECRET_ASCII = '12345678901234567890';
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS = [
  { time: 59, code8: '94287082' },
  { time: 1111111109, code8: '07081804' },
  { time: 1111111111, code8: '14050471' },
  { time: 1234567890, code8: '89005924' },
  { time: 2000000000, code8: '69279037' },
];

/**
 * 步长边界对齐：确保接下来的断言期间不会跨过 30s 边界。
 * 漂移窗用例同时涉及 t-2 与 t+2——若断言中途时间前进一步，t+2 的码会落进
 * 漂移窗（假绿）、或 t-2 的码进一步远离（假红），用例会随机失真。
 */
async function alignToStepStart() {
  const periodMs = TOTP_PERIOD_SECONDS * 1000;
  const remain = periodMs - (Date.now() % periodMs);
  if (remain < 4000) await new Promise((r) => setTimeout(r, remain + 200));
}

beforeAll(async () => {
  await alignToStepStart();
});

describe('TOTP 参数口径（与主流认证器 App 互操作基线）', () => {
  it('6 位数字 / 30 秒步长 / 漂移窗 ±1 步长', () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_DRIFT_STEPS).toBe(1);
  });
});

describe('base32（RFC 4648 §6 标准表，严格解码）', () => {
  it('编码 RFC 向量 secret 得到认证器通行的 32 字符 base32', () => {
    expect(base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'))).toBe(RFC_SECRET_BASE32);
  });

  it('编解码往返一致，且解码结果就是原始字节', () => {
    const buf = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Decode(RFC_SECRET_BASE32)).toEqual(Buffer.from(RFC_SECRET_ASCII, 'ascii'));
  });

  it('RFC 4648 §10 官方向量（带填充形态可解、无填充形态即本仓编码输出）逐条吻合', () => {
    // 表出自 RFC 4648 §10：BASE32("f") = "MY======" … BASE32("foobar") = "MZXW6YTBOI======"。
    // 本仓编码器输出**无填充**形态（otpauth URL / 认证器展示口径），解码器两种都收
    const vectors = [
      ['f', 'MY======'],
      ['fo', 'MZXQ===='],
      ['foo', 'MZXW6==='],
      ['foob', 'MZXW6YQ='],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI======'],
    ];
    for (const [plain, padded] of vectors) {
      const unpadded = padded.replace(/=+$/, '');
      expect(base32Encode(Buffer.from(plain, 'ascii')), plain).toBe(unpadded);
      expect(base32Decode(padded), padded).toEqual(Buffer.from(plain, 'ascii'));
      expect(base32Decode(unpadded), unpadded).toEqual(Buffer.from(plain, 'ascii'));
    }
    // 末位 'I' 出自标准表（RFC 4648 §6 Table 3 的 value 8）——不是表外字符
    expect(base32Decode('MZXW6YTBOI======')).toEqual(Buffer.from('foobar', 'ascii'));
  });

  it('容忍分隔符/大小写/填充；表外字符与非法填充返回 null', () => {
    expect(base32Decode('gezd gnbv-gy3t qojqgezdgnbvgy3tqojq')).toEqual(
      Buffer.from(RFC_SECRET_ASCII, 'ascii'),
    );
    expect(base32Decode('mzxw6ytboi======')).toEqual(Buffer.from('foobar', 'ascii'));
    // 数字 0/1/8/9 与符号不在 A-Z2-7 内（RFC 4648 §3.3：必须拒绝表外字符）
    expect(base32Decode('GEZD1NBV')).toBeNull();
    expect(base32Decode('GEZD8NBV')).toBeNull();
    expect(base32Decode('GEZD0NBV')).toBeNull();
    expect(base32Decode('GEZD9NBV')).toBeNull();
    expect(base32Decode('GEZD!NBV')).toBeNull();
    // 填充只在末尾、个数须匹配、带填充时总长须为 8 的倍数
    expect(base32Decode('MZXW6YQ')).toEqual(Buffer.from('foob', 'ascii')); // 合法无填充
    expect(base32Decode('MZXW6YTB=')).toBeNull(); // 8 字符数据无需填充（过填充）
    expect(base32Decode('MZXW6Y==')).toBeNull(); // 填充个数与数据长度不符
    expect(base32Decode('MZXW6YQ==')).toBeNull(); // 带填充但总长非 8 的倍数
    expect(base32Decode('MZ=XW6YQ')).toBeNull(); // 内嵌 '='
    expect(base32Decode('====')).toBeNull();
    expect(base32Decode('')).toBeNull();
    expect(base32Decode(null)).toBeNull();
  });

  it('I / O 是标准表内字符（认证器互操作所需），这里不去混淆', () => {
    // 与恢复码字母表（刻意剔除 I/O/0/1）用意不同：secret 走 App 同款标准表
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJI')).not.toBeNull();
    expect(base32Decode('MZXW6YTBOI')).toEqual(Buffer.from('foobar', 'ascii'));
  });

  it('拒绝静默位级截断：长度非法或尾位非零一律 null（不同输入不得同密钥）', () => {
    // §6 收尾量子只允许 2/4/5/7/8 字符：长度 %8 ∈ {1,3,6} 非法
    for (const bad of ['A', 'ABC', 'ABCDEF', 'MZXW6YTBX']) {
      expect(base32Decode(bad), `${bad}（长度非法）`).toBeNull();
    }
    // 'AB'（2 字符 = 1 字节）长度合法，但尾位非零 → 必须拒绝，否则与 'AA' 同密钥
    expect(base32Decode('AB')).toBeNull();
    expect(base32Decode('AA')).toEqual(Buffer.from([0x00]));
    // 'ABA' 长度非法；且它正是与 'AB' 解出同一密钥的那个形态（静默截断的样本）
    expect(base32Decode('ABA')).toBeNull();
    // 真实密钥多抄一位：必须报错，而不是静默解成另一个密钥
    const secret = base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'));
    expect(base32Decode(secret)).toEqual(Buffer.from(RFC_SECRET_ASCII, 'ascii'));
    expect(base32Decode(`${secret}A`)).toBeNull();
  });
});

describe('RFC 6238 官方测试向量（SHA-1，逐条断言）', () => {
  const key = base32Decode(RFC_SECRET_BASE32);

  for (const { time, code8 } of RFC_VECTORS) {
    const step = Math.floor(time / TOTP_PERIOD_SECONDS);
    it(`T=${time}s（step ${step}）→ 8 位码 ${code8}，6 位截取 ${code8.slice(-6)}`, () => {
      // 直接对已解码密钥调 HOTP（跳过 base32 路径）与经 secret 的完整路径双向锁定
      expect(hotp(key, step)).toBe(code8.slice(-6));
      expect(totpCodeAtStep(RFC_SECRET_BASE32, step)).toBe(code8.slice(-6));
    });
  }

  it('8 位向量与 6 位实现同源：逐位取模前的整数截断关系成立', () => {
    for (const { time, code8 } of RFC_VECTORS) {
      const step = Math.floor(time / TOTP_PERIOD_SECONDS);
      const code6 = totpCodeAtStep(RFC_SECRET_BASE32, step);
      // 6 位码 = 8 位码后 6 位（同一动态截断整数对 10^6 取模）
      expect(Number(code8) % 10 ** 6).toBe(Number(code6));
    }
  });
});

describe('漂移窗（t-1 / t / t+1 通过，t-2 / t+2 拒绝）', () => {
  const secret = generateTotpSecret();

  it('t-1 / t / t+1 三个步长全部通过', () => {
    const t = currentTimeStep();
    for (const step of [t - 1, t, t + 1]) {
      const res = verifyTotpCode(secret, totpCodeAtStep(secret, step), null);
      expect(res, `step ${step - t} 应通过`).toMatchObject({ ok: true, step });
    }
  });

  it('t-2 / t+2 拒绝（reason=mismatch，非 replay）', () => {
    const t = currentTimeStep();
    for (const step of [t - 2, t + 2]) {
      const res = verifyTotpCode(secret, totpCodeAtStep(secret, step), null);
      expect(res, `step ${step - t} 应拒绝`).toMatchObject({ ok: false, reason: 'mismatch' });
    }
  });

  it('另一个 secret 算出的同窗口码一律拒绝（不是「窗内任意码都收」）', () => {
    const other = generateTotpSecret();
    const t = currentTimeStep();
    expect(verifyTotpCode(secret, totpCodeAtStep(other, t), null).ok).toBe(false);
  });
});

describe('重放防护（≤ 已接受步长一律拒绝）', () => {
  const secret = generateTotpSecret();

  it('同一个码第二次使用被拒（reason=replay）', () => {
    const t = currentTimeStep();
    const code = totpCodeAtStep(secret, t);
    const first = verifyTotpCode(secret, code, null);
    expect(first).toMatchObject({ ok: true, step: t });
    // 以第一次接受的步长为基线再试同一个码
    const second = verifyTotpCode(secret, code, first.step);
    expect(second).toMatchObject({ ok: false, reason: 'replay' });
  });

  it('上一窗口的码在当前窗口重放被拒（仍在漂移窗内也不放行）', () => {
    const t = currentTimeStep();
    // 基线 = 已接受 t+1：此刻的 t（= 当前窗口，属漂移窗 t-1）不得再被接受
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t), t + 1)).toMatchObject({
      ok: false,
      reason: 'replay',
    });
    // 基线 = 已接受 t：t-1 的码同样拒绝
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t - 1), t)).toMatchObject({
      ok: false,
      reason: 'replay',
    });
  });

  it('未来步长（> 基线）仍可通过：重放防护只挡「≤ 基线」', () => {
    const t = currentTimeStep();
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t + 1), t)).toMatchObject({
      ok: true,
      step: t + 1,
    });
  });
});

describe('基线合理性护栏（仅「越过漂移窗的未来基线」视为损坏值）', () => {
  const secret = generateTotpSecret();

  it('损坏基线（未来值）：正确码放行且标记 stale-baseline，供调用方写回纠正', () => {
    const t = currentTimeStep();
    // 只可能来自「库被手工改写」或「时钟前跳期间成功验证后残留」：这类基线若照旧参与
    // 比较，正确码会被永久判为重放（自锁死，只剩恢复码退路）
    for (const corrupt of [t + TOTP_DRIFT_STEPS + 1, t + 1000, 99999999999]) {
      expect(verifyTotpCode(secret, totpCodeAtStep(secret, t), corrupt), `baseline=${corrupt}`).toMatchObject({
        ok: true,
        step: t,
        reason: 'stale-baseline',
      });
    }
  });

  it('护栏不是绕过重放的路径：纠正后的基线立刻照旧拒绝同一个码', () => {
    const t = currentTimeStep();
    const code = totpCodeAtStep(secret, t);
    const first = verifyTotpCode(secret, code, 99999999999);
    expect(first).toMatchObject({ ok: true, step: t, reason: 'stale-baseline' });
    // 调用方把 first.step 写回后，同一码必须被拒
    expect(verifyTotpCode(secret, code, first.step)).toMatchObject({ ok: false, reason: 'replay' });
  });

  it('边界：基线 = current + 漂移窗仍参与重放判定（恰好不算损坏值）', () => {
    const t = currentTimeStep();
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t + TOTP_DRIFT_STEPS), t + TOTP_DRIFT_STEPS))
      .toMatchObject({ ok: false, reason: 'replay' });
    // 同一基线下，更新的（窗口外）码也不可能命中 ⇒ 仍被拒
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t), t + TOTP_DRIFT_STEPS))
      .toMatchObject({ ok: false, reason: 'replay' });
  });

  it('窗口内 / 刚过去的基线语义不变（current、current-1、current-2 照旧拒绝重放）', () => {
    const t = currentTimeStep();
    // 基线 = current：当前码重放被拒
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t), t)).toMatchObject({
      ok: false,
      reason: 'replay',
    });
    // 基线 = current-1：t-1 的码（仍在窗口内）重放被拒
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t - 1), t - 1)).toMatchObject({
      ok: false,
      reason: 'replay',
    });
    // 基线 = current-2：t-2 的码已滑出漂移窗 ⇒ mismatch（同样拒绝，理由不同）
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t - 2), t - 2)).toMatchObject({
      ok: false,
      reason: 'mismatch',
    });
    // 但 t-1 的码相对 current-2 基线是「更新的码」⇒ 正常放行（护栏没有放宽窗口内判定）
    expect(verifyTotpCode(secret, totpCodeAtStep(secret, t - 1), t - 2)).toMatchObject({
      ok: true,
      step: t - 1,
      reason: 'ok',
    });
  });
});

describe('输入归一化与非法输入', () => {
  const secret = generateTotpSecret();

  it('容忍 App 常见的分组写法（空格 / 连字符）', () => {
    const t = currentTimeStep();
    const code = totpCodeAtStep(secret, t);
    expect(normalizeTotpCode(code)).toBe(code);
    expect(normalizeTotpCode(`${code.slice(0, 3)} ${code.slice(3)}`)).toBe(code);
    expect(normalizeTotpCode(`${code.slice(0, 3)}-${code.slice(3)}`)).toBe(code);
    expect(verifyTotpCode(secret, `${code.slice(0, 3)} ${code.slice(3)}`, null).ok).toBe(true);
  });

  it('形状不符（位数/非数字/空/非字符串/超长/控制字符/全角）→ malformed，不静默当 0 处理', () => {
    const cases = [
      '12345', '1234567', 'abcdef', '12 34', '', '   ', null, undefined, 123456,
      '1'.repeat(1000), '\u0000'.repeat(6), '１２３４５６', '12345\u0000',
    ];
    for (const bad of cases) {
      // 长度不等的输入绝不能触发 timingSafeEqual 的长度异常（异常路径本身即侧信道信号）
      expect(() => verifyTotpCode(secret, bad, null), `${String(bad)} 不应抛出`).not.toThrow();
      expect(verifyTotpCode(secret, bad, null), `${String(bad)} 应判 malformed`).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('secret 不可用（缺列/被改坏）→ no-secret，不抛出', () => {
    expect(verifyTotpCode(null, '123456', null)).toMatchObject({ ok: false, reason: 'no-secret' });
    expect(verifyTotpCode('', '123456', null)).toMatchObject({ ok: false, reason: 'no-secret' });
    expect(verifyTotpCode('NOT!BASE32', '123456', null)).toMatchObject({ ok: false, reason: 'no-secret' });
  });
});

describe('secret 生成与 otpauth 挂靠 URI', () => {
  it('生成的 secret 是 32 字符 base32（20 字节熵），每次不同', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });

  it('otpauth URI 形态锁定：全部走百分号编码，空间不出现在 query 里', () => {
    const url = buildOtpauthUrl({ secret: RFC_SECRET_BASE32, issuer: 'MC Commander', account: 'admin' });
    // 逐字符锁定最终形态：URLSearchParams 会把空格编成 '+'（otpauth 客户端按 URI
    // 语义逐字解析，'+' 不是空格 → 发行方名会变成 "MC+Commander"）
    expect(url).toBe(
      'otpauth://totp/MC%20Commander:admin'
      + `?secret=${RFC_SECRET_BASE32}`
      + '&issuer=MC%20Commander&algorithm=SHA1&digits=6&period=30',
    );
    expect(url).not.toContain('+');

    const parsed = new URL(url);
    expect(parsed.hostname).toBe('totp');
    expect(decodeURIComponent(parsed.pathname.slice(1))).toBe('MC Commander:admin');
    expect(parsed.searchParams.get('secret')).toBe(RFC_SECRET_BASE32);
    expect(parsed.searchParams.get('issuer')).toBe('MC Commander');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });

  it('issuer/account 含需转义字符时逐段编码，分隔符仍是字面量 ":"', () => {
    const url = buildOtpauthUrl({ secret: RFC_SECRET_BASE32, issuer: 'ACME & Co', account: 'a b@x' });
    expect(url).toBe(
      'otpauth://totp/ACME%20%26%20Co:a%20b%40x'
      + `?secret=${RFC_SECRET_BASE32}`
      + '&issuer=ACME%20%26%20Co&algorithm=SHA1&digits=6&period=30',
    );
    expect(decodeURIComponent(new URL(url).pathname.slice(1))).toBe('ACME & Co:a b@x');
  });
});
