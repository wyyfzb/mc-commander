/**
 * mc-deploy 单测
 */
import { describe, it, expect } from 'vitest'
import {
  SERVER_TYPES,
  SERVER_TYPE_LABELS,
  TASK_TYPES,
  TASK_TYPE_LABELS,
  TASK_TYPE_OPTIONS,
  TASK_TYPE_TONES,
  formatNextRunCountdown,
  formatTaskDate,
  recommendedJavaVersion,
} from '../mc-deploy'

describe('recommendedJavaVersion', () => {
  it('版本区间映射', () => {
    expect(recommendedJavaVersion(null)).toBe('未知')
    expect(recommendedJavaVersion('')).toBe('未知')
    expect(recommendedJavaVersion('abc')).toBe('17')
    expect(recommendedJavaVersion('26.2')).toBe('25') // 新版版本号体系（major≥20）
    expect(recommendedJavaVersion('20.1')).toBe('25')
    expect(recommendedJavaVersion('1.21.4')).toBe('21')
    expect(recommendedJavaVersion('1.20.5')).toBe('21')
    expect(recommendedJavaVersion('1.20.4')).toBe('17')
    expect(recommendedJavaVersion('1.17.1')).toBe('17')
    expect(recommendedJavaVersion('1.16.5')).toBe('8') // 版本基线：1.7-1.16 → Java 8
    expect(recommendedJavaVersion('1.7.10')).toBe('8')
    expect(recommendedJavaVersion('1.6.4')).toBe('17')
  })
})

describe('服务端类型静态数据', () => {
  it('5 种类型与标签', () => {
    expect(SERVER_TYPES).toEqual(['vanilla', 'paper', 'fabric', 'forge', 'purpur'])
    expect(SERVER_TYPE_LABELS.vanilla).toBe('原版 (Vanilla)')
    expect(SERVER_TYPE_LABELS.paper).toBe('Paper')
    expect(SERVER_TYPE_LABELS.fabric).toBe('Fabric')
    expect(SERVER_TYPE_LABELS.forge).toBe('Forge')
    expect(SERVER_TYPE_LABELS.purpur).toBe('Purpur')
  })
})

describe('任务类型静态数据', () => {
  it('类型标签与选项文案', () => {
    expect(TASK_TYPES).toEqual(['restart', 'backup', 'command', 'stop', 'start'])
    expect(TASK_TYPE_LABELS.restart).toBe('重启')
    expect(TASK_TYPE_LABELS.backup).toBe('备份')
    expect(TASK_TYPE_LABELS.command).toBe('命令')
    expect(TASK_TYPE_LABELS.stop).toBe('停止')
    expect(TASK_TYPE_LABELS.start).toBe('启动')
    expect(TASK_TYPE_OPTIONS.map((o) => o.label)).toEqual([
      '重启服务器',
      '创建备份（世界+配置+插件）',
      '执行命令',
      '停止服务器',
      '启动服务器',
    ])
  })

  it('类型状态色映射', () => {
    expect(TASK_TYPE_TONES.restart).toBe('warning')
    expect(TASK_TYPE_TONES.backup).toBe('info')
    expect(TASK_TYPE_TONES.command).toBe('purple')
    expect(TASK_TYPE_TONES.stop).toBe('error')
    expect(TASK_TYPE_TONES.start).toBe('success')
  })
})

describe('formatTaskDate', () => {
  it('MM-DD HH:mm 本地时区；null/非法 → 从未', () => {
    expect(formatTaskDate(null)).toBe('从未')
    expect(formatTaskDate('')).toBe('从未')
    expect(formatTaskDate('not-a-date')).toBe('从未')
    const d = new Date(2026, 7, 15, 9, 5) // 2026-08-15 09:05 本地时区
    expect(formatTaskDate(d.toISOString())).toBe('08-15 09:05')
  })
})

describe('formatNextRunCountdown（下次执行倒计时）', () => {
  const NOW = new Date(2026, 7, 15, 9, 0, 0).getTime() // 2026-08-15 09:00 本地时区基准
  const at = (ms: number) => new Date(NOW + ms).toISOString()

  it('null/空/非法 → null（保持「从未」）', () => {
    expect(formatNextRunCountdown(null, NOW)).toBeNull()
    expect(formatNextRunCountdown('', NOW)).toBeNull()
    expect(formatNextRunCountdown('not-a-date', NOW)).toBeNull()
  })

  it('分钟级：向上取整，不足 1 分钟按 1m', () => {
    expect(formatNextRunCountdown(at(45 * 60_000), NOW)).toBe('45m 后')
    expect(formatNextRunCountdown(at(59 * 60_000 + 30_000), NOW)).toBe('1h 0m 后')
    expect(formatNextRunCountdown(at(30_000), NOW)).toBe('1m 后')
  })

  it('小时级：h m 格式', () => {
    expect(formatNextRunCountdown(at((2 * 60 + 15) * 60_000), NOW)).toBe('2h 15m 后')
    expect(formatNextRunCountdown(at((23 * 60 + 59) * 60_000), NOW)).toBe('23h 59m 后')
  })

  it('天级：d h 格式', () => {
    expect(formatNextRunCountdown(at(2 * 86_400_000 + 3 * 3_600_000), NOW)).toBe('2d 3h 后')
  })

  it('已过期（含当前时刻）→ 已过期', () => {
    expect(formatNextRunCountdown(at(0), NOW)).toBe('已过期')
    expect(formatNextRunCountdown(at(-60_000), NOW)).toBe('已过期')
  })
})
