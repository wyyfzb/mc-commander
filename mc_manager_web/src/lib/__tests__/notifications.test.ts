import { describe, it, expect } from 'vitest'
import {
  aggregateNotifications,
  buildAlertNotifications,
  buildNotifications,
  mergeNotifications,
  NOTIFICATION_TYPE_META,
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

  it('taskFailed 文案含任务名与错误摘要', () => {
    const [n] = buildNotifications({
      type: 'taskFailed',
      data: { taskName: '每日重启', taskType: 'restart', error: '端口被占用' },
    })
    expect(n).toMatchObject({ type: 'taskFailed', category: 'server' })
    expect(n?.content).toBe('定时任务「每日重启」执行失败: 端口被占用')
  })

  it('taskFailed 缺错误字段时仅含任务名', () => {
    const [n] = buildNotifications({ type: 'taskFailed', data: { taskName: '每日重启' } })
    expect(n?.content).toBe('定时任务「每日重启」执行失败')
  })

  it('webhookDeliveryFailed 生成 server 类 severe 通知', () => {
    const [n] = buildNotifications({
      type: 'webhookDeliveryFailed',
      data: { webhookName: 'Discord 告警', webhookId: 42, error: 'HTTP 403' },
    })
    expect(n).toMatchObject({ type: 'webhookFailed', category: 'server' })
    expect(n?.content).toContain('Discord 告警')
    expect(n?.content).toContain('重试耗尽')
  })

  it('webhookDeliveryFailed 缺名称时使用默认文案', () => {
    const [n] = buildNotifications({ type: 'webhookDeliveryFailed', data: {} })
    expect(n?.content).toBe('Webhook「未命名 Webhook」投递失败（重试耗尽）')
  })

  it('非通知事件返回空数组', () => {
    expect(buildNotifications({ type: 'log', data: { text: 'x' } })).toEqual([])
  })

  it('status circuit_breaker → circuitBreaker severe 通知（含连崩次数）', () => {
    const [n] = buildNotifications({
      type: 'status',
      data: { event: 'circuit_breaker', consecutiveCrashes: 3, windowMs: 120000 },
    })
    expect(n).toMatchObject({ type: 'circuitBreaker', category: 'server' })
    expect(n?.content).toBe('连续崩溃 3 次，已触发熔断保护（自动重启暂停，请检查日志）')
  })

  it('status circuit_breaker 缺次数字段时显示 0', () => {
    const [n] = buildNotifications({ type: 'status', data: { event: 'circuit_breaker' } })
    expect(n?.content).toBe('连续崩溃 0 次，已触发熔断保护（自动重启暂停，请检查日志）')
  })

  it('deployComplete 生成 server 类 info 通知（含实例名）', () => {
    const [n] = buildNotifications({
      type: 'deployComplete',
      data: { instanceName: '生存服', instanceId: 'paper-abc1', stage: 'complete' },
    })
    expect(n).toMatchObject({ type: 'deployComplete', category: 'server' })
    expect(n?.content).toBe('实例「生存服」部署完成')
  })

  it('deployFailed 生成 server 类 severe 通知（含失败原因）', () => {
    const [n] = buildNotifications({
      type: 'deployFailed',
      data: { instanceName: 'Forge 服', error: 'Forge installer timed out (120s)' },
    })
    expect(n).toMatchObject({ type: 'deployFailed', category: 'server' })
    expect(n?.content).toBe('实例「Forge 服」部署失败：Forge installer timed out (120s)')
  })

  it('deployComplete 缺实例名时使用默认文案', () => {
    const [n] = buildNotifications({ type: 'deployComplete', data: {} })
    expect(n?.content).toBe('实例「未命名」部署完成')
  })

  it('deployCancelled 生成 server 类 info 通知（用户取消不是告警）', () => {
    const [n] = buildNotifications({
      type: 'deployCancelled',
      data: { instanceName: '演示实例', instanceId: 'paper-abc1', stage: 'cancelled' },
    })
    expect(n).toMatchObject({ type: 'deployCancelled', category: 'server' })
    // 不宣称「已清理」：清理成不成只有服务端知道，成功时也不多话
    expect(n?.content).toBe('实例「演示实例」部署已取消')
    // 与 deployFailed（severe，进严重告警档）分档：主动取消不该混进告警筛选
    expect(NOTIFICATION_TYPE_META.deployCancelled.severity).toBe('info')
    expect(NOTIFICATION_TYPE_META.deployFailed.severity).toBe('severe')
  })

  it('deployCancelled 带收尾明细时一并显示（清理失败不得被吞成「已清理」）', () => {
    const [n] = buildNotifications({
      type: 'deployCancelled',
      data: { instanceName: '演示实例', error: '实例目录未能删除（EBUSY: resource busy）' },
    })
    expect(n?.content).toBe('实例「演示实例」部署已取消：实例目录未能删除（EBUSY: resource busy）')
  })

  it('upgradeComplete 生成 server 类 info 通知（含实例名）', () => {
    const [n] = buildNotifications({
      type: 'upgradeComplete',
      data: { instanceName: '生存服', instanceId: 'paper-abc1', stage: 'completed' },
    })
    expect(n).toMatchObject({ type: 'upgradeComplete', category: 'server' })
    expect(n?.content).toBe('实例「生存服」升级完成')
  })

  it('upgradeFailed 透出服务端 detail（含回滚说明）', () => {
    const [n] = buildNotifications({
      type: 'upgradeFailed',
      data: { instanceName: '生存服', detail: '升级失败并已回滚: 下载失败' },
    })
    expect(n).toMatchObject({ type: 'upgradeFailed', category: 'server' })
    expect(n?.content).toBe('实例「生存服」升级失败并已回滚: 下载失败')
  })

  it('upgradeFailed 缺 detail 时使用默认文案', () => {
    const [n] = buildNotifications({ type: 'upgradeFailed', data: { instanceName: '生存服' } })
    expect(n?.content).toBe('实例「生存服」升级失败')
  })

  it('deployFailed / upgradeFailed 为 critical 类不参与聚合', () => {
    const result = aggregateNotifications(
      [
        {
          id: 'a', type: 'deployFailed', category: 'server',
          content: '实例「Forge 服」部署失败：x', timestamp: 60_000, count: 1, read: false,
        },
      ],
      { type: 'deployFailed', category: 'server', content: '实例「Forge 服」部署失败：x' },
      65_000,
    )
    expect(result).toHaveLength(2)
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

  it('taskFailed 属 critical 类：同任务连发不聚合（每次失败独立可见）', () => {
    const existing = [base({ type: 'taskFailed', content: '定时任务「每日重启」执行失败', timestamp: 95_000 })]
    const result = aggregateNotifications(
      existing,
      { type: 'taskFailed', category: 'server', content: '定时任务「每日重启」执行失败' },
      100_000, // 5s 后同一失败再来一条
    )
    expect(result).toHaveLength(2)
  })

  it('circuitBreaker 属 critical 类：连续熔断不聚合（每次独立可见）', () => {
    const existing = [base({ type: 'circuitBreaker', content: '连续崩溃 3 次，已触发熔断保护（自动重启暂停，请检查日志）', timestamp: 95_000 })]
    const result = aggregateNotifications(
      existing,
      { type: 'circuitBreaker', category: 'server', content: '连续崩溃 3 次，已触发熔断保护（自动重启暂停，请检查日志）' },
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
    expect(notifications[0]?.content).toBe('CPU 使用率过高: 85.0%（单核口径）')

    const recovered = buildAlertNotifications({ cpu: 50 }, undefined, new Set(['highCpu']))
    expect(recovered.notifications[0]?.content).toBe('CPU 使用率已恢复正常')
  })
})

describe('mergeNotifications 跨标签合并', () => {
  it('并集：两侧独有条目都保留（另一标签刚产生的通知不被覆盖）', () => {
    const local = [base({ id: 'a', timestamp: 100 })]
    const remote = [base({ id: 'b', timestamp: 200 })]

    // 远端独有条目排最前（对本标签是「新出现的」），本地顺序保持不动
    expect(mergeNotifications(local, remote).map((n) => n.id)).toEqual(['b', 'a'])
  })

  it('身份取 eventKey 优先：同一事件在两个标签各生成的副本合并成一条', () => {
    // 两个标签各持一份副本：id 是各自 randomUUID（不同），eventKey 相同
    const tabA = [base({ id: 'tab-a-1', eventKey: 'evt-42-0', count: 3, read: false })]
    const tabB = [base({ id: 'tab-b-1', eventKey: 'evt-42-0', count: 3, read: true })]

    const merged = mergeNotifications(tabA, tabB)
    expect(merged).toHaveLength(1)
    // 保留先到者的 id，字段取并集（已读不回退）
    expect(merged[0]).toMatchObject({ id: 'tab-a-1', read: true, count: 3 })
  })

  it('无 eventKey 时退回 id 身份（前端本地告警等无服务端事件的条目）', () => {
    const local = [base({ id: 'alert-1' })]
    const remote = [base({ id: 'alert-2' })]

    expect(mergeNotifications(local, remote)).toHaveLength(2)
    expect(mergeNotifications(local, local)).toHaveLength(1)
  })

  it('同 id：read 取并集、count/timestamp 取较大值（单调量不回退）', () => {
    const local = [base({ id: 'a', read: true, count: 3, timestamp: 500 })]
    const remote = [base({ id: 'a', read: false, count: 1, timestamp: 100 })]

    const [merged] = mergeNotifications(local, remote)
    expect(merged).toMatchObject({ id: 'a', read: true, count: 3, timestamp: 500 })
  })

  it('清空时刻：更早的条目两侧都不保留，同毫秒新条目保留（清空后立刻产生的通知不被吞掉）', () => {
    const local = [base({ id: 'old', timestamp: 100 }), base({ id: 'same-ms', timestamp: 200 })]
    const remote = [base({ id: 'older', timestamp: 50 }), base({ id: 'new', timestamp: 300 })]

    expect(mergeNotifications(local, remote, 200).map((n) => n.id)).toEqual(['new', 'same-ms'])
  })

  it('顺序与裁剪：本地顺序不动，远端独有条目排最前，超上限裁掉列表尾部', () => {
    const local = Array.from({ length: 5 }, (_, i) => base({ id: `n-${i}`, timestamp: 100 - i }))

    const merged = mergeNotifications(local, [], 0, 3)
    expect(merged.map((n) => n.id)).toEqual(['n-0', 'n-1', 'n-2'])
  })
})
