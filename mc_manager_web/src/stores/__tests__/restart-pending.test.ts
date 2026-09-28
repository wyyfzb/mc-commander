/**
 * restart-pending store 单测（启动配置「待重启生效」跟踪）
 *
 * 闭环的每一环都要有锁，缺一个指示器就会说谎：
 * - 保存置位 / 重启（started）清除 / 跨刷新持久化**读回** / 卸载后不留残条
 * 仓储面（localStorage）是用户可改的外部输入，故损坏载荷必须逐态验证——
 * pending 为 null 会让 Object.keys 在 render 期抛错（整页白屏），为字符串/数组则会把
 * 下标或字符当实例 id 渲染出来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRestartPendingStore } from '../restart-pending'

const STORAGE_KEY = 'mcs-restart-pending'

/**
 * 重建模块（persist 的 hydrate 仅在模块导入期执行一次）。
 * `payload === undefined` 表示**沿用当前 localStorage**（用于「先写盘再重建」的读回用例），
 * 此时不能 clear——清了就变成「空库重建」，用例恒过而什么都没测。
 */
async function reloadWith(payload: unknown) {
  vi.resetModules()
  if (payload !== undefined) {
    localStorage.clear()
    localStorage.setItem(
      STORAGE_KEY,
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    )
  }
  const mod = await import('../restart-pending')
  return mod.useRestartPendingStore
}

describe('restart-pending store', () => {
  beforeEach(() => {
    localStorage.clear()
    useRestartPendingStore.setState({ pending: {} })
  })

  afterEach(() => {
    localStorage.clear()
    useRestartPendingStore.setState({ pending: {} })
  })

  it('markPending 置位并记时刻（指示器要能如实说明「什么时候改的」）', () => {
    const before = Date.now()
    useRestartPendingStore.getState().markPending('inst-a')
    const at = useRestartPendingStore.getState().pending['inst-a']
    expect(at).toBeTypeOf('number')
    expect(at!).toBeGreaterThanOrEqual(before)
  })

  it('clearPending 只清指定实例，不动其他实例的待办', () => {
    const { markPending, clearPending } = useRestartPendingStore.getState()
    markPending('inst-a')
    markPending('inst-b')

    clearPending('inst-a')
    const pending = useRestartPendingStore.getState().pending
    expect(pending['inst-a']).toBeUndefined()
    // 别的实例改了也还没重启，不能被一起清掉
    expect(pending['inst-b']).toBeTypeOf('number')
  })

  it('clearPending 对不存在的实例是无操作（不产生新对象抖动）', () => {
    useRestartPendingStore.getState().markPending('inst-a')
    const before = useRestartPendingStore.getState().pending
    useRestartPendingStore.getState().clearPending('inst-missing')
    expect(useRestartPendingStore.getState().pending).toBe(before)
  })

  it('重复保存覆盖时刻（同一实例只记最近一次改动）', () => {
    const { markPending } = useRestartPendingStore.getState()
    markPending('inst-a')
    const first = useRestartPendingStore.getState().pending['inst-a']
    markPending('inst-a')
    const second = useRestartPendingStore.getState().pending['inst-a']
    expect(second!).toBeGreaterThanOrEqual(first!)
  })

  it('pruneTo 丢弃已不存在的实例，保留仍存在的（卸载后不留撤不掉的残条）', () => {
    const { markPending, pruneTo } = useRestartPendingStore.getState()
    markPending('inst-a')
    markPending('inst-b')
    markPending('inst-gone')

    pruneTo(new Set(['inst-a', 'inst-b']))
    const pending = useRestartPendingStore.getState().pending
    expect(Object.keys(pending).sort()).toEqual(['inst-a', 'inst-b'])
  })

  it('pruneTo 无需裁剪时保持引用（避免每次列表刷新都触发重渲染）', () => {
    useRestartPendingStore.getState().markPending('inst-a')
    const before = useRestartPendingStore.getState().pending
    useRestartPendingStore.getState().pruneTo(new Set(['inst-a', 'inst-b']))
    expect(useRestartPendingStore.getState().pending).toBe(before)
  })

  it('跨刷新持久化：写入落盘，重建 store 后读回同一条目', async () => {
    useRestartPendingStore.getState().markPending('inst-a')
    const at = useRestartPendingStore.getState().pending['inst-a']!

    const store = await reloadWith(undefined)
    // 关键断言是**读回值**而非「localStorage 里有字符串」：后者不锁任何读回行为
    expect(store.getState().pending['inst-a']).toBe(at)
  })
})

describe('restart-pending store 损坏载荷容错（逐态重建模块）', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('pending 为 null → 归一为空表（不得在 render 期抛错）', async () => {
    const store = await reloadWith({ state: { pending: null }, version: 0 })
    expect(store.getState().pending).toEqual({})
    // 组件侧的第一句就是 Object.keys(pending)：null 会在此抛错
    expect(() => Object.keys(store.getState().pending)).not.toThrow()
  })

  it('pending 为字符串 → 归一为空表（不得把字符下标当实例 id 渲染）', async () => {
    const store = await reloadWith({ state: { pending: 'corrupt' }, version: 0 })
    expect(store.getState().pending).toEqual({})
  })

  it('pending 为数组 → 归一为空表（不得把下标当实例 id）', async () => {
    const store = await reloadWith({ state: { pending: ['a', 'b'] }, version: 0 })
    expect(store.getState().pending).toEqual({})
  })

  it('条目值非法（字符串/负数/null/非有限数）→ 逐项剔除，合法项保留', async () => {
    // Infinity 走 JSON.stringify 会变成 null，故直接给原始载荷文本（localStorage 本来
    // 就是外部输入，手写文本正是真实攻击面）
    const store = await reloadWith(
      '{"state":{"pending":{"good":123,"bad":"x","neg":-1,"nul":null,"inf":1e999}},"version":0}',
    )
    expect(store.getState().pending).toEqual({ good: 123 })
  })

  it('空键 → 剔除（无 id 的条目无法定位实例）', async () => {
    const store = await reloadWith({ state: { pending: { '': 123, ok: 456 } }, version: 0 })
    expect(store.getState().pending).toEqual({ ok: 456 })
  })

  it('非法 JSON / 缺 state / state 为数组 → 回退空表且不抛错', async () => {
    for (const payload of ['{not json', { version: 0 }, { state: [1, 2], version: 0 }]) {
      const store = await reloadWith(payload)
      expect(store.getState().pending).toEqual({})
    }
  })
})
