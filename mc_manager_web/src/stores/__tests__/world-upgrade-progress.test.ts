/**
 * world-upgrade-progress store 测试：
 * - applyWorldUpgradeProgress 按实例记录（多实例互不覆盖）
 * - clearWorldUpgradeProgress 只清指定实例；对不存在的实例是空操作（返回同一状态对象）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyWorldUpgradeProgress,
  clearWorldUpgradeProgress,
  useWorldUpgradeProgressStore,
} from '../world-upgrade-progress'

beforeEach(() => {
  useWorldUpgradeProgressStore.setState({ progress: {} })
})

describe('world-upgrade-progress store', () => {
  it('applyWorldUpgradeProgress 按实例记录，多实例互不覆盖', () => {
    applyWorldUpgradeProgress('a', 10)
    applyWorldUpgradeProgress('b', 20)
    applyWorldUpgradeProgress('a', 40)

    expect(useWorldUpgradeProgressStore.getState().progress).toEqual({ a: 40, b: 20 })
  })

  it('clearWorldUpgradeProgress 只清指定实例', () => {
    applyWorldUpgradeProgress('a', 10)
    applyWorldUpgradeProgress('b', 20)

    clearWorldUpgradeProgress('a')

    expect(useWorldUpgradeProgressStore.getState().progress).toEqual({ b: 20 })
  })

  it('clearWorldUpgradeProgress 对不存在的实例不改状态对象（避免无谓重渲染）', () => {
    applyWorldUpgradeProgress('a', 10)
    const before = useWorldUpgradeProgressStore.getState()

    clearWorldUpgradeProgress('missing')

    expect(useWorldUpgradeProgressStore.getState().progress).toBe(before.progress)
  })
})
