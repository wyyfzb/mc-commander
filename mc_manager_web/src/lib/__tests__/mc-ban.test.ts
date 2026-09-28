/**
 * 封禁档位与时长解析单测（时长语法对照服务端 parseDuration）
 */
import { describe, expect, it } from 'vitest'
import {
  BAN_DURATION_OPTIONS,
  BAN_REASONS,
  BAN_REASON_FALLBACK,
  formatBanRemaining,
  parseDurationToMs,
  validateBanForm,
} from '../mc-ban'

describe('封禁时长档位（6 档）', () => {
  it('档位顺序与映射（永久 = null duration）', () => {
    expect(BAN_DURATION_OPTIONS.map((o) => o.label)).toEqual([
      '1小时',
      '12小时',
      '1天',
      '7天',
      '30天',
      '永久',
    ])
    expect(BAN_DURATION_OPTIONS.map((o) => o.value)).toEqual(['1h', '12h', '1d', '7d', '30d', null])
  })
})

describe('封禁理由（9 项）', () => {
  it('理由清单与「其他」回退', () => {
    expect(BAN_REASONS).toEqual([
      '作弊',
      '辱骂/骚扰',
      '恶意破坏',
      '广告',
      '刷屏',
      '恶意PVP',
      '不当语言',
      '使用Bug',
      '其他',
    ])
    expect(BAN_REASON_FALLBACK).toBe('其他')
  })
})

describe('parseDurationToMs（服务端语法复刻）', () => {
  it('各档位换算（1mo = 30 天）', () => {
    expect(parseDurationToMs('1s')).toBe(1000)
    expect(parseDurationToMs('30m')).toBe(1_800_000)
    expect(parseDurationToMs('1h')).toBe(3_600_000)
    expect(parseDurationToMs('12h')).toBe(43_200_000)
    expect(parseDurationToMs('1d')).toBe(86_400_000)
    expect(parseDurationToMs('7d')).toBe(604_800_000)
    expect(parseDurationToMs('1w')).toBe(604_800_000)
    expect(parseDurationToMs('30d')).toBe(2_592_000_000)
    expect(parseDurationToMs('1mo')).toBe(2_592_000_000)
  })

  it('非法输入返回 null', () => {
    expect(parseDurationToMs('')).toBeNull()
    expect(parseDurationToMs('1')).toBeNull()
    expect(parseDurationToMs('h')).toBeNull()
    expect(parseDurationToMs('1y')).toBeNull()
    expect(parseDurationToMs('1.5h')).toBeNull()
  })
})

describe('formatBanRemaining（封禁徽章剩余时间）', () => {
  const NOW = 1_000_000_000
  it('天级', () => {
    expect(formatBanRemaining(NOW + 2 * 86_400_000 + 3_600_000, NOW)).toBe('剩2天1小时')
  })
  it('小时级', () => {
    expect(formatBanRemaining(NOW + 2 * 3_600_000 + 5 * 60_000, NOW)).toBe('剩2小时5分钟')
  })
  it('分钟级（不足 1 分钟按 1 分钟显示）', () => {
    expect(formatBanRemaining(NOW + 5 * 60_000, NOW)).toBe('剩5分钟')
    expect(formatBanRemaining(NOW + 30_000, NOW)).toBe('剩1分钟')
  })
  it('已过期返回 null（即将解封）', () => {
    expect(formatBanRemaining(NOW - 1000, NOW)).toBeNull()
    expect(formatBanRemaining(NOW, NOW)).toBeNull()
  })
})

describe('封禁表单校验', () => {
  it('IP 封禁需玩家有 IP 地址', () => {
    expect(
      validateBanForm({ targetType: 'ip', duration: '1h', reason: '作弊', kickFirst: true }, null),
    ).toBe('该玩家暂无 IP 信息')
    expect(
      validateBanForm({ targetType: 'ip', duration: '1h', reason: '作弊', kickFirst: true }, ''),
    ).toBe('该玩家暂无 IP 信息')
  })
  it('玩家封禁或 IP 存在时通过', () => {
    expect(
      validateBanForm(
        { targetType: 'player', duration: null, reason: '作弊', kickFirst: true },
        null,
      ),
    ).toBeNull()
    expect(
      validateBanForm(
        { targetType: 'ip', duration: '1d', reason: '作弊', kickFirst: true },
        '10.0.0.1',
      ),
    ).toBeNull()
  })
})
