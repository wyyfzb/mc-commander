/**
 * 批量操作执行器单测
 */
import { describe, expect, it } from 'vitest'
import { formatBatchSummary, formatFailureDetails, runBatchForTargets } from '../mc-batch'

describe('runBatchForTargets', () => {
  it('顺序逐条执行并汇总成功数', async () => {
    const order: string[] = []
    const result = await runBatchForTargets({
      targets: [
        { name: 'A', isOnline: true },
        { name: 'B', isOnline: true },
      ],
      requireOnline: false,
      execute: async (t) => {
        order.push(t.name)
      },
    })
    expect(order).toEqual(['A', 'B'])
    expect(result).toEqual({
      successCount: 2,
      failCount: 0,
      skippedCount: 0,
      allOffline: false,
      failures: [],
    })
  })

  it('requireOnline 时离线目标跳过计 skipped', async () => {
    const executed: string[] = []
    const result = await runBatchForTargets({
      targets: [
        { name: 'A', isOnline: true },
        { name: 'B', isOnline: false },
        { name: 'C', isOnline: true },
      ],
      requireOnline: true,
      execute: async (t) => {
        executed.push(t.name)
      },
    })
    expect(executed).toEqual(['A', 'C'])
    expect(result).toEqual({
      successCount: 2,
      failCount: 0,
      skippedCount: 1,
      allOffline: false,
      failures: [],
    })
  })

  it('单条失败计 fail，不阻断后续目标', async () => {
    const result = await runBatchForTargets({
      targets: [
        { name: 'A', isOnline: true },
        { name: 'B', isOnline: true },
        { name: 'C', isOnline: true },
      ],
      requireOnline: false,
      execute: async (t) => {
        if (t.name === 'B') throw new Error('命令执行失败')
      },
    })
    expect(result.successCount).toBe(2)
    expect(result.failCount).toBe(1)
    expect(result.failures).toEqual([{ target: 'B', error: '命令执行失败' }])
  })

  it('全部离线时不执行任何命令（allOffline）', async () => {
    const executed: string[] = []
    const result = await runBatchForTargets({
      targets: [
        { name: 'A', isOnline: false },
        { name: 'B', isOnline: false },
      ],
      requireOnline: true,
      execute: async (t) => {
        executed.push(t.name)
      },
    })
    expect(executed).toEqual([])
    expect(result).toEqual({
      successCount: 0,
      failCount: 0,
      skippedCount: 2,
      allOffline: true,
      failures: [],
    })
  })

  it('名单类动作（白名单/OP）requireOnline=false 对离线仍执行', async () => {
    const result = await runBatchForTargets({
      targets: [{ name: 'A', isOnline: false }],
      requireOnline: false,
      execute: async () => {},
    })
    expect(result).toEqual({
      successCount: 1,
      failCount: 0,
      skippedCount: 0,
      allOffline: false,
      failures: [],
    })
  })

  it('多条失败记录每个目标的独立错误', async () => {
    const result = await runBatchForTargets({
      targets: [
        { name: 'Alex', isOnline: true },
        { name: 'Steve', isOnline: true },
        { name: 'Creeper', isOnline: true },
      ],
      requireOnline: false,
      execute: async (t) => {
        if (t.name === 'Alex') throw new Error('RCON 超时')
        if (t.name === 'Steve') throw new Error('玩家不存在')
      },
    })
    expect(result.successCount).toBe(1)
    expect(result.failCount).toBe(2)
    expect(result.failures).toHaveLength(2)
    expect(result.failures).toEqual([
      { target: 'Alex', error: 'RCON 超时' },
      { target: 'Steve', error: '玩家不存在' },
    ])
  })

  it('非 Error 类型错误也记录', async () => {
    const result = await runBatchForTargets({
      targets: [{ name: 'A', isOnline: true }],
      requireOnline: false,
      execute: async () => {
        throw 'string error'
      },
    })
    expect(result.failures).toEqual([{ target: 'A', error: 'string error' }])
  })
})

describe('formatBatchSummary（汇总 Toast 文案）', () => {
  it('常规汇总', () => {
    expect(
      formatBatchSummary('踢出', {
        successCount: 3,
        failCount: 1,
        skippedCount: 2,
        allOffline: false,
        failures: [],
      }),
    ).toBe('批量踢出完成：成功 3，失败 1，跳过离线 2')
  })
  it('无跳过时不显示跳过段', () => {
    expect(
      formatBatchSummary('设置OP', {
        successCount: 5,
        failCount: 0,
        skippedCount: 0,
        allOffline: false,
        failures: [],
      }),
    ).toBe('批量设置OP完成：成功 5，失败 0')
  })
  it('全部离线提示', () => {
    expect(
      formatBatchSummary('传送', {
        successCount: 0,
        failCount: 0,
        skippedCount: 2,
        allOffline: true,
        failures: [],
      }),
    ).toBe('所选玩家均已离线，无法执行')
  })
})

describe('formatFailureDetails（失败详情文案）', () => {
  it('无失败返回 undefined', () => {
    expect(
      formatFailureDetails({
        successCount: 2,
        failCount: 0,
        skippedCount: 0,
        allOffline: false,
        failures: [],
      }),
    ).toBeUndefined()
  })

  it('单条失败返回带 bullet 列表', () => {
    const result = {
      successCount: 1,
      failCount: 1,
      skippedCount: 0,
      allOffline: false,
      failures: [{ target: 'Alex', error: 'RCON 超时' }],
    }
    expect(formatFailureDetails(result)).toBe('• Alex：RCON 超时')
  })

  it('多条失败用换行分隔', () => {
    const result = {
      successCount: 0,
      failCount: 2,
      skippedCount: 0,
      allOffline: false,
      failures: [
        { target: 'Alex', error: 'RCON 超时' },
        { target: 'Steve', error: '玩家不存在' },
      ],
    }
    const details = formatFailureDetails(result)
    expect(details).toContain('• Alex：RCON 超时')
    expect(details).toContain('• Steve：玩家不存在')
    expect(details).toContain('\n')
  })
})
