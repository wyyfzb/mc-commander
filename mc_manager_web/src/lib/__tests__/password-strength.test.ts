import { describe, it, expect } from 'vitest'
import { assessPasswordStrength } from '../password-strength'

describe('assessPasswordStrength（密码强度评估）', () => {
  it('低于 8 位 → 0 分（服务端会拒绝）', () => {
    expect(assessPasswordStrength('').score).toBe(0)
    expect(assessPasswordStrength('Ab1').score).toBe(0)
    expect(assessPasswordStrength('a'.repeat(7)).score).toBe(0)
  })

  it('长度达标但单一字符类 → 1 分', () => {
    expect(assessPasswordStrength('abcdefgh').score).toBe(1)
    expect(assessPasswordStrength('12345678').score).toBe(1)
  })

  it('命中弱口令词根 → 1 分（即使字符类多样）', () => {
    expect(assessPasswordStrength('password1!').score).toBe(1)
    expect(assessPasswordStrength('Minecraft123').score).toBe(1)
    expect(assessPasswordStrength('admin123456').score).toBe(1)
  })

  it('重复模式 → 1 分', () => {
    expect(assessPasswordStrength('aaaaaaaa1').score).toBe(1)
  })

  it('两类字符 → 2 分；长度 ≥12 的两类 → 3 分', () => {
    expect(assessPasswordStrength('ab12cd34').score).toBe(2)
    expect(assessPasswordStrength('abcdef1234ab').score).toBe(3)
  })

  it('三类字符 → 3 分；三类 + 长度 ≥12 → 4 分', () => {
    expect(assessPasswordStrength('Ab1defgh').score).toBe(3)
    expect(assessPasswordStrength('Ab1cdefghijk').score).toBe(4)
  })

  it('强度标签与分数对应', () => {
    expect(assessPasswordStrength('ab12cd34').label).toBe('一般')
    expect(assessPasswordStrength('Ab1cdefghijk').label).toBe('很强')
    expect(assessPasswordStrength('short').label).toBe('至少 8 位')
  })
})
