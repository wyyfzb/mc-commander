/**
 * second-factor 纯函数契约测试（第二因子输入纪律的单一事实源）。
 *
 * 母题：清洗**不得改动输入的长度语义**。服务端字母表 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
 * 含 2–9 共 8 个数字字符 ⇒ 10 位**纯数字**的合法恢复码确实存在（每枚 ≈1/2^20，10 枚码池
 * ≈1/10 万）。任何「纯数字就截到 6 位」的规则都会把这种码改造成 6 位 TOTP 形状，
 * 服务端据此改走动态口令分支而必然失败，且截断发生在 onChange 上，用户看不到原文。
 *
 * 判定口径与服务端逐条对齐（routes/auth.js verifySecondFactor 的分流 +
 * utils/recovery-codes.js normalizeRecoveryCode + utils/totp.js normalizeTotpCode）：
 * - 恰好 6 位纯数字 → 动态口令（TOTP）
 * - 去分隔后 10 位、字符全在去混淆字母表内（大小写不敏感，服务端先 toUpperCase）→ 恢复码
 * - 其余形状两端都拒；前端拦下可为用户省掉一次计入封禁的失败往返
 */
import { describe, it, expect } from 'vitest'
import {
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
  SECOND_FACTOR_HINT,
  SECOND_FACTOR_SHAPE_HINT,
  TOTP_CODE_LENGTH,
  isSecondFactorSubmittable,
  sanitizeSecondFactorInput,
} from '../second-factor'

/** 服务端 normalizeTotpCode 的接收形状（仅用于断言「不会被服务端分到 TOTP 分支」） */
const TOTP_SHAPE = /^\d{6}$/

describe('sanitizeSecondFactorInput：只去分隔符，不改长度语义', () => {
  it('全数字 10 位恢复码原样透传（不被截成 6 位）', () => {
    // 服务端字母表含 2-9 ⇒ 这是合法恢复码；截断会让它永远失败
    expect(sanitizeSecondFactorInput('2345678923')).toBe('2345678923')
    expect(sanitizeSecondFactorInput('2345678923')).toHaveLength(RECOVERY_CODE_LENGTH)
  })

  it('展示形态（5-5 分组）只去连字符，10 位一位不少', () => {
    expect(sanitizeSecondFactorInput('23456-78923')).toBe('2345678923')
  })

  it('去空格与连字符，其余字符保留', () => {
    expect(sanitizeSecondFactorInput('ABCDE FGH-JK')).toBe('ABCDEFGHJK')
    expect(sanitizeSecondFactorInput('  ABCDEFGHJK  ')).toBe('ABCDEFGHJK')
    // 尾随换行（终端/文档复制常见）
    expect(sanitizeSecondFactorInput('ABCDEFGHJK\n')).toBe('ABCDEFGHJK')
    expect(sanitizeSecondFactorInput('ABCDEFGHJK\r\n')).toBe('ABCDEFGHJK')
  })

  it('恰好 6 位纯数字（含分组写法）仍是 6 位 → 走动态口令', () => {
    expect(sanitizeSecondFactorInput('123456')).toBe('123456')
    expect(sanitizeSecondFactorInput('123-456')).toBe('123456')
    expect(TOTP_SHAPE.test('123456')).toBe(true)
  })

  it('7 位及以上纯数字不被截断（长度语义交给可提交性判定）', () => {
    expect(sanitizeSecondFactorInput('1234567')).toBe('1234567')
    expect(sanitizeSecondFactorInput('1234567890')).toBe('1234567890')
    // 不被截断 ⇒ 不会被服务端分到 TOTP 分支（它只认恰好 6 位）
    expect(TOTP_SHAPE.test('1234567')).toBe(false)
  })
})

describe('isSecondFactorSubmittable：与服务端字母表逐条对齐', () => {
  it('全数字 10 位恢复码可提交，且**不**匹配服务端的 TOTP 形状（⇒ 走恢复码分支）', () => {
    const code = sanitizeSecondFactorInput('23456-78923')
    expect(isSecondFactorSubmittable(code)).toBe(true)
    // 服务端 verifySecondFactor：normalizeTotpCode(raw) !== null 才走 TOTP。
    // 该判定等价于 ^\d{6}$；10 位纯数字不匹配 ⇒ 落到恢复码分支（服务端 normalizeRecoveryCode 认它）
    expect(TOTP_SHAPE.test(code)).toBe(false)
    // 且字符全部落在服务端字母表内（normalizeRecoveryCode 的第二个条件）
    for (const ch of code) expect(RECOVERY_CODE_ALPHABET, ch).toContain(ch)
  })

  it('恰好 6 位纯数字始终可提交（TOTP）', () => {
    for (const t of ['000000', '123456', '999999']) {
      expect(isSecondFactorSubmittable(t), t).toBe(true)
      expect(TOTP_SHAPE.test(t), t).toBe(true)
    }
  })

  it('字母表内的 10 位字母数字恢复码可提交（小写亦可：服务端先大写化）', () => {
    for (const c of ['ABCDEFGHJK', 'LMNPQRSTUV', 'WXYZ234567', 'abcdefghjk']) {
      expect(isSecondFactorSubmittable(c), c).toBe(true)
      expect(c.toUpperCase()).toHaveLength(RECOVERY_CODE_LENGTH)
    }
  })

  it('含 I/O/0/1 的值被拒（服务端字母表不含它们，放行只会白烧一次失败计数）', () => {
    for (const c of ['ABCDEIO012', 'IIII9999ZZ', 'JJJJ0000ZZ', 'ABCDE1GHJK', 'ABCDE0GHJK']) {
      expect(isSecondFactorSubmittable(c), c).toBe(false)
    }
  })

  it('长度不符的值被拒（8/9/11/16 位都不放过）', () => {
    for (const c of ['AAAA1111', 'ABCDEFGHJ', 'ABCDEFGHJKL', 'ABCDEFGHJKLMNPQR']) {
      expect(isSecondFactorSubmittable(c), c).toBe(false)
    }
  })

  it('7–9 位打字噪音被前置拦下（不再发出必然失败的请求）', () => {
    for (const c of ['1234567', 'ABCDEFGH', '12345678']) {
      expect(isSecondFactorSubmittable(c), c).toBe(false)
    }
  })

  it('周围空白由清洗吸收后可提交（清洗是判定前的必经一步）', () => {
    expect(isSecondFactorSubmittable(sanitizeSecondFactorInput(' ABCDEFGH-JK '))).toBe(true)
  })

  it('空串不可提交（区别于「形状不符」，调用方另有空值文案）', () => {
    expect(isSecondFactorSubmittable('')).toBe(false)
  })
})

describe('文案常量', () => {
  it('形状提示点名两种码的长度与字母表约束', () => {
    expect(SECOND_FACTOR_SHAPE_HINT).toContain(`${TOTP_CODE_LENGTH} 位`)
    expect(SECOND_FACTOR_SHAPE_HINT).toContain(`${RECOVERY_CODE_LENGTH} 位`)
    expect(SECOND_FACTOR_SHAPE_HINT).toContain('I/O/0/1')
  })

  it('区分提示说明恢复码是 10 位字母数字', () => {
    expect(SECOND_FACTOR_HINT).toContain(`${RECOVERY_CODE_LENGTH} 位`)
    expect(SECOND_FACTOR_HINT).toContain('一次性恢复码')
  })
})

describe('字母表常量', () => {
  it('与服务端一致：32 字符、去混淆（无 I/O/0/1）', () => {
    expect(RECOVERY_CODE_ALPHABET).toHaveLength(32)
    for (const forbidden of ['I', 'O', '0', '1']) {
      expect(RECOVERY_CODE_ALPHABET, forbidden).not.toContain(forbidden)
    }
    // 含 2-9 共 8 个数字字符——这正是「纯数字恢复码合法」的来源
    expect([...RECOVERY_CODE_ALPHABET].filter((c) => /\d/.test(c))).toEqual(
      '23456789'.split(''),
    )
    expect(new Set(RECOVERY_CODE_ALPHABET).size).toBe(32)
  })
})
