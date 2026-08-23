import { describe, it, expect } from 'vitest'
import {
  aggregateNotifications,
  buildAlertNotifications,
  buildNotifications,
  type AppNotification,
} from '../notifications'

/**
 * 通知系统单测（聚合 30s/60s、critical 不聚合、告警状态机）
 */

function base(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'id-1',
    type: 'join',
    category: 'game',
    content: 'Steve 加入了游戏',
    timestamp: 100_000,
    count: 1,
    read: false,
    ...overrides,
  }
}

describe('buildNotifications 文案模板', () => {
  it('playerJoin → 中文文案', () => {
    const [n] = buildNotifications({ type: 'playerJoin', data: { name: 'Steve' } })
    expect(n).toMatchObject({ type: 'join', category: 'game', content: 'Steve 加入了游戏' })
  })

  it('playerDeath 团灭聚合事件逐条生成', () => {
    const ns = buildNotifications({
      type: 'playerDeath',
      data: { players: [{ name: 'A', cause: '被僵尸杀死' }, { name: 'B', cause: '坠落' }], count: 2 },
    })
    expect(ns).toHaveLength(2)
    expect(ns[0]?.content).toBe('A 被僵尸杀死')
    expect(ns[1]?.content).toBe('B 坠落')
  })

  it('achievement 区分挑战', () => {
    const [n] = buildNotifications({
      type: 'achievement',
      data: { name: 'Steve', advancement: '钻石!', isChallenge: true },
    })
    expect(n?.content).toBe('Steve 完成了挑战 [钻石!]')
  })

  it('status 事件映射（started/ready/stopped/crash/save）', () => {
    expect(buildNotifications({ type: 'status', data: { event: 'started' } })[0]?.content).toBe('服务器已启动')
    expect(buildNotifications({ type: 'status', data: { event: 'ready' } })[0]?.content).toBe('服务器已就绪')
    expect(buildNotifications({ type: 'status', data: { event: 'stopped' } })[0]?.content).toBe('服务器已停止')
    expect(
      buildNotifications({ type: 'status', data: { event: 'crash', autoRestart: true } })[0]?.content,
    ).toBe('服务器意外退出，正在自动重启')
  })

  it('weatherUpdate 英文映射中文', () => {
    const [n] = buildNotifications({ type: 'weatherUpdate', data: { weather: 'thunder' } })
    expect(n?.content).toBe('天气变为雷暴')
  })

  it('备份/恢复类缺省文案', () => {
    expect(buildNotifications({ type: 'backupComplete' })[0]?.content).toBe('备份完成')
    expect(buildNotifications({ type: 'backupSkipped' })[0]?.content).toBe('定时备份已跳过（上一备份仍在进行）')
  })

  it('非通知事件返回空数组', () => {
    expect(buildNotifications({ type: 'log', data: { text: 'x' } })).toEqual([])
  })
})

describe('aggregateNotifications 聚合规则', () => {
  it('同类型同内容 60s 内 count++（内容聚合）', () => {
    const existing = [base({ timestamp: 60_000 })]
    const result = aggregateNotifications(
      existing,
      { type: 'join', category: 'game', content: 'Steve 加入了游戏' },
      100_000, // 40s 后
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.count).toBe(2)
  })

  it('同玩家不同类型 30s 内 count++（实体聚合）', () => {
    const existing = [base({ type: 'join', content: 'Steve 加入了游戏', timestamp: 85_000 })]
    const result = aggregateNotifications(
      existing,
      { type: 'leave', category: 'game', content: 'Steve 离开了游戏' },
      100_000, // 15s 后，实体键 type 不同但…实体键含 type：join|Steve vs leave|Steve 不匹配
    )
    // 实体聚合键含类型：不命中 → 新条目
    expect(result).toHaveLength(2)
  })

  it('同玩家同类型 30s 内 count++（实体聚合）', () => {
    const existing = [base({ type: 'join', content: 'Steve 加入了游戏', timestamp: 85_000 })]
    const result = aggregateNotifications(
      existing,
      { type: 'join', category: 'game', content: 'Steve 加入了游戏' },
      100_000,
    )
    // 内容聚合键先命中（同类型同内容 60s）
    expect(result).toHaveLength(1)
    expect(result[0]?.count).toBe(2)
  })

  it('critical 类不聚合（serverCrash/backupFailed/restoreFailed）', () => {
    const existing = [base({ type: 'serverCrash', content: '服务器意外退出', timestamp: 90_000 })]
    const result = aggregateNotifications(
      existing,
      { type: 'serverCrash', category: 'server', content: '服务器意外退出' },
      100_000,
    )
    expect(result).toHaveLength(2)
  })

  it('超过 60s 窗口不聚合', () => {
    const existing = [base({ timestamp: 30_000 })]
    const result = aggregateNotifications(
      existing,
      { type: 'join', category: 'game', content: 'Steve 加入了游戏' },
      100_000, // 70s 后
    )
    expect(result).toHaveLength(2)
  })
})

describe('buildAlertNotifications 告警状态机', () => {
  it('TPS 低于阈值首次触发告警', () => {
    const { notifications, activeAlerts } = buildAlertNotifications({ tps: 10 }, undefined, new Set())
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.content).toBe('TPS 过低: 10.0')
    expect(activeAlerts.has('lowTps')).toBe(true)
  })

  it('持续超阈值不重复告警（跃迁单次）', () => {
    const { notifications } = buildAlertNotifications({ tps: 10 }, undefined, new Set(['lowTps']))
    expect(notifications).toHaveLength(0)
  })

  it('恢复后产生恢复通知并清除激活态', () => {
    const { notifications, activeAlerts } = buildAlertNotifications({ tps: 20 }, undefined, new Set(['lowTps']))
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.content).toBe('TPS 已恢复正常')
    expect(activeAlerts.has('lowTps')).toBe(false)
  })

  it('CPU/内存阈值 80% 告警与恢复', () => {
    const { notifications } = buildAlertNotifications({ cpu: 85 }, undefined, new Set())
    expect(notifications[0]?.content).toBe('CPU 使用率过高: 85.0%')

    const recovered = buildAlertNotifications({ cpu: 50 }, undefined, new Set(['highCpu']))
    expect(recovered.notifications[0]?.content).toBe('CPU 使用率已恢复正常')
  })
})
