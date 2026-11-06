/**
 * 实例总览的健康判定与排序（纯函数，逐条锁行为）
 *
 * 这些判据决定「清单把哪台排在最前、标成什么」，判错会让用户先去处理一台没事的实例，
 * 而真正卡死的那台沉在列表底部。
 */
import { describe, expect, it } from 'vitest'
import {
  buildFleetRows,
  countIssues,
  fleetIssue,
  fleetRowSummary,
} from '@/features/instances/fleet-health'
import { mockInstanceStatus } from '@tests/support/handlers'
import type { InstanceStatus } from '@/api/types'

function status(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
  return { ...mockInstanceStatus, ...overrides }
}

describe('fleetIssue · 单台实例的结论', () => {
  it('熔断优先于一切：即使 TPS 正常也报故障', () => {
    const issue = fleetIssue(
      status({ circuitBreakerTripped: true, consecutiveCrashes: 5, tps: 20 }),
    )
    expect(issue).toMatchObject({ level: 'error', label: '崩溃熔断' })
  })

  it('运行中 TPS 低于健康线报卡顿，严重档升级为 error', () => {
    expect(fleetIssue(status({ tps: 17 }))).toMatchObject({ level: 'warning', label: 'TPS 偏低' })
    expect(fleetIssue(status({ tps: 8 }))).toMatchObject({ level: 'error', label: '严重卡顿' })
  })

  it('TPS 恰好等于健康下界不算问题', () => {
    expect(fleetIssue(status({ tps: 19 }))).toBeNull()
  })

  it('已停止的实例不按残留 TPS 判卡顿', () => {
    // 停服后 tps 是上一次运行的残留读数，据此报警会把停着的实例整片标成故障
    expect(fleetIssue(status({ isRunning: false, tps: 4 }))).toBeNull()
  })

  it('未熔断但有近期崩溃报告警', () => {
    expect(fleetIssue(status({ consecutiveCrashes: 2 }))).toMatchObject({
      level: 'warning',
      label: '近期崩溃',
    })
  })

  it('外网连不进来报告警', () => {
    expect(fleetIssue(status({ reachability: 'blocked' }))).toMatchObject({
      level: 'warning',
      label: '连不进来',
    })
  })

  it('健康实例无结论', () => {
    expect(fleetIssue(status({ reachability: 'reachable' }))).toBeNull()
  })
})

describe('buildFleetRows · 排序', () => {
  it('按故障 → 告警 → 健康运行 → 已停止排序', () => {
    /* 展示名刻意与期望顺序**反着**排（甲<乙<丙<丁 而期望顺序是丁丙乙甲）：
       两者同向时，「按档排序」与「按名字排序」会得出同一个结果，用例就锁不住档位判据 */
    const rows = buildFleetRows([
      status({ id: 'stopped', name: '甲 已停止', isRunning: false }),
      status({ id: 'healthy', name: '乙 健康' }),
      status({ id: 'warn', name: '丙 告警', tps: 16 }),
      status({ id: 'broken', name: '丁 故障', circuitBreakerTripped: true, consecutiveCrashes: 3 }),
    ])
    expect(rows.map((r) => r.status.id)).toEqual(['broken', 'warn', 'healthy', 'stopped'])
  })

  it('已停止排在健康运行之后（停着的实例再糟也占不到人）', () => {
    // 名称反向排：健康那张叫「乙」、停着那张叫「甲」，纯按名字排会把停着的那台排前面
    const rows = buildFleetRows([
      status({ id: 's1', name: '甲 停着', isRunning: false }),
      status({ id: 'r1', name: '乙 在跑', isRunning: true }),
    ])
    expect(rows.map((r) => r.status.id)).toEqual(['r1', 's1'])
  })

  it('同档按展示名排，空名回退 id 后仍可比较', () => {
    const rows = buildFleetRows([
      status({ id: 'z1', name: '乙实例' }),
      status({ id: 'a1', name: '甲实例' }),
      status({ id: 'blank', name: '   ' }),
    ])
    // 三个都是健康运行，按展示名（含空名回退的 id）稳定排序，且不因空名抛错
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.status.id).sort()).toEqual(['a1', 'blank', 'z1'])
  })

  it('不修改入参数组（页面可能拿它继续算别的）', () => {
    const input = [status({ id: 'b', name: '乙' }), status({ id: 'a', name: '甲' })]
    const snapshot = input.map((s) => s.id)
    buildFleetRows(input)
    expect(input.map((s) => s.id)).toEqual(snapshot)
  })
})

describe('countIssues · 条数', () => {
  it('故障与告警分别计数', () => {
    const rows = buildFleetRows([
      status({ id: 'e1', circuitBreakerTripped: true, consecutiveCrashes: 4 }),
      status({ id: 'w1', tps: 16 }),
      status({ id: 'ok1' }),
    ])
    expect(countIssues(rows)).toEqual({ total: 2, errors: 1 })
  })

  it('全健康时两项都为 0', () => {
    expect(countIssues(buildFleetRows([status()]))).toEqual({ total: 0, errors: 0 })
  })
})

describe('fleetRowSummary · 窄容器摘要行', () => {
  it('运行中给出在线/TPS/内存三件，以单位收尾', () => {
    const text = fleetRowSummary(status({ playerCount: 3, tps: 19.96, memoryUsage: 3.2 }))
    expect(text).toBe('3 人在线 · TPS 20.0 · 内存 3.2 GB')
  })

  it('内存读数为 0 时不出「内存 0 GB」——那读起来像已经耗光', () => {
    expect(fleetRowSummary(status({ memoryUsage: 0 }))).not.toContain('内存')
  })

  it('已停止带版本号，便于确认停的是哪一版', () => {
    expect(fleetRowSummary(status({ isRunning: false, mcVersion: '1.21.4' }))).toBe(
      '已停止 · 1.21.4',
    )
  })
})
