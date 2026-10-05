/**
 * TPS 阈值的唯一声明源。
 *
 * 承重点：展示分级（统计卡文字色）与告警（低 TPS 通知）必须同一判据。
 * 此前「≥19 健康 / ≥15 卡顿」写在统计卡、「tpsLow: 15」写在告警并再带一个 `?? 15`
 * 兜底，同一个 15 出现三处 ⇒ 改一处就会出现「卡片显示健康、却同时弹低 TPS 告警」。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TPS_HEALTHY_MIN, TPS_WARNING_MIN, tpsLevel } from '../mc-tps'
import { DEFAULT_ALERT_THRESHOLDS } from '../notifications'
import { tpsColor } from '@/features/dashboard/components/stat-cards'

describe('TPS 阈值唯一源', () => {
  it('分级按两个界分三档', () => {
    expect(tpsLevel(TPS_HEALTHY_MIN)).toBe('healthy')
    expect(tpsLevel(20)).toBe('healthy')
    expect(tpsLevel(TPS_HEALTHY_MIN - 0.1)).toBe('warning')
    expect(tpsLevel(TPS_WARNING_MIN)).toBe('warning')
    expect(tpsLevel(TPS_WARNING_MIN - 0.1)).toBe('critical')
    expect(tpsLevel(0)).toBe('critical')
  })

  it('告警默认阈值与分级的告警界是同一个常量（不是各写一份的巧合）', () => {
    expect(DEFAULT_ALERT_THRESHOLDS.tpsLow).toBe(TPS_WARNING_MIN)
  })

  it('告警与展示同判据：低于告警界时展示必然不是健康档', () => {
    // 这条钉住「卡片说健康、却同时弹低 TPS 告警」的自相矛盾
    for (const tps of [TPS_WARNING_MIN - 1, TPS_WARNING_MIN - 0.01]) {
      const alerts = tps < DEFAULT_ALERT_THRESHOLDS.tpsLow
      expect(alerts, `tps=${tps} 应告警`).toBe(true)
      expect(tpsLevel(tps), `tps=${tps} 不应判健康`).not.toBe('healthy')
    }
  })

  it('展示分级的两个界与文字色档位一致（不健康即非成功色）', () => {
    expect(tpsColor(20, true)).toBe('text-mcs-success-fg')
    expect(tpsColor(16, true)).toBe('text-mcs-warning-fg')
    expect(tpsColor(10, true)).toBe('text-mcs-error-fg')
    // 未运行 / 未采集 → 中性色，不谎报健康
    expect(tpsColor(20, false)).toBe('text-mcs-text-muted')
    expect(tpsColor(null, true)).toBe('text-mcs-text-muted')
  })

  it('两个消费点不得各自写死阈值（只认 mc-tps 的常量）', () => {
    // 值相同证明不了「同源」：把 15 写回两处，值断言照样绿。故这里查源码结构——
    // 只要消费点出现写死的 TPS 比较/默认值，就会转红。
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
    const statCards = read('../../features/dashboard/components/stat-cards.tsx')
    const notif = read('../notifications.ts')

    // 统计卡：不得出现 `tps >= 19` 这类写死比较，且必须走 tpsLevel/常量
    expect(statCards).not.toMatch(/tps\s*[<>]=?\s*\d/)
    expect(statCards).toMatch(/from '@\/lib\/mc-tps'/)
    // 告警：默认值与兜底都不得写死数字
    expect(notif).not.toMatch(/tpsLow:\s*\d/)
    expect(notif).not.toMatch(/tpsLow\s*\?\?\s*\d/)
    expect(notif).toMatch(/from '\.\/mc-tps'/)
  })

  it('两个界的大小关系成立（健康界高于告警界）', () => {
    expect(TPS_HEALTHY_MIN).toBeGreaterThan(TPS_WARNING_MIN)
  })
})
