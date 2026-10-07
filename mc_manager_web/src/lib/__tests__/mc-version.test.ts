import { describe, it, expect } from 'vitest'
import { compareVersions, isVersionAtLeast, parseVersion } from '../mc-version'

/**
 * 版本解析与比较（全仓唯一一份）。
 *
 * 重点不是「某个版本的数值」，而是三件容易静默出错的事：
 * ① 逐段数值比较（字符串比较会把 `1.9` 排在 `1.10` 之后）；
 * ② 不可解析时**不返回 NaN**——NaN 参与比较会让所有分支静默为 false，把「读不懂」伪装成
 *    「比较结果是否」；
 * ③ 不可解析的处置由调用方显式给：同一个空串，物品可用性要偏保守、附魔格式判定要以新版为准。
 */
describe('parseVersion - 取三段（缺失按 0，无数字为 null）', () => {
  it.each([
    ['1.21.6', [1, 21, 6]],
    ['1.21', [1, 21, 0]],
    ['26', [26, 0, 0]],
    ['v1.21.5', [1, 21, 5]],
    ['26.3-snapshot-2', [26, 3, 0]],
  ])('%s → %j', (input, expected) => {
    expect(parseVersion(input)).toEqual(expected)
  })

  it('整串没有数字才是不可解析（返回 null，不是 NaN 三元组）', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('unknown')).toBeNull()
    expect(parseVersion('snapshot')).toBeNull()
  })
})

describe('compareVersions - 逐段数值比较', () => {
  it('按段比较而非字符串比较（1.9 < 1.10）', () => {
    // 字符串比较会得出 '1.9' > '1.10'（'9' > '1'），这是本函数存在的唯一理由
    expect(compareVersions('1.9', '1.10')).toBeLessThan(0)
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0)
  })

  it('主/次/修订逐级比较', () => {
    expect(compareVersions('1.20.5', '1.21')).toBeLessThan(0)
    expect(compareVersions('1.21', '1.21.2')).toBeLessThan(0)
    expect(compareVersions('1.21.2', '1.21.10')).toBeLessThan(0)
    expect(compareVersions('26.1', '26.2')).toBeLessThan(0)
    expect(compareVersions('26.3', '1.21.11')).toBeGreaterThan(0)
  })

  it('相同版本为 0（含缺段视为 0）', () => {
    expect(compareVersions('1.21', '1.21')).toBe(0)
    expect(compareVersions('1.21', '1.21.0')).toBe(0)
  })
})

describe('isVersionAtLeast - 不可解析的处置由调用方显式给', () => {
  it('可解析时按比较结果', () => {
    expect(isVersionAtLeast('1.21.6', '1.21.6', false)).toBe(true)
    expect(isVersionAtLeast('1.21.5', '1.21.6', true)).toBe(false)
  })

  it('不可解析时返回 whenUnknown：同一入参在两种口径下结论相反', () => {
    // 物品可用性偏保守（宁可少列），附魔/gamerule 以新版为准
    expect(isVersionAtLeast('', '1.21.6', false)).toBe(false)
    expect(isVersionAtLeast('', '1.21.6', true)).toBe(true)
    expect(isVersionAtLeast('unknown', '1.21.6', false)).toBe(false)
    expect(isVersionAtLeast('unknown', '1.21.6', true)).toBe(true)
  })
})
