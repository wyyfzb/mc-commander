import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useServerStore } from '../server'

/**
 * useServerStore 的实例选择持久化
 *
 * 背景：顶栏选中的实例原本只存在内存里，刷新页面就丢——多实例下必然跳回
 * 「最近创建的那个」，用户对着错的服务器下 /op 这类命令也不会察觉。
 *
 * 只持久化「在看哪个实例」这一个选择，不持久化任何实时数据：
 * status 存下来会在刷新后先显示一份过期快照（面板明明停了、界面还显示运行中）。
 */

const STORAGE_KEY = 'mcs-server'

beforeEach(() => {
  localStorage.clear()
  useServerStore.setState({
    status: null,
    systemStats: null,
    instanceId: null,
    socketConnected: false,
    hasConnectedOnce: false,
    lastStatusEvent: null,
    phase: {},
  })
})

afterEach(() => {
  localStorage.clear()
})

describe('useServerStore 实例选择持久化', () => {
  it('instanceId 写入 localStorage', async () => {
    useServerStore.getState().setInstanceId('inst-b')
    await vi.waitFor(
      () => {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as {
          state: { instanceId: string }
        }
        expect(stored.state.instanceId).toBe('inst-b')
      },
      { timeout: 5000 },
    )
  })

  it('实时数据不写入 localStorage（刷新后不得先显示过期快照）', async () => {
    useServerStore.getState().setInstanceId('inst-b')
    useServerStore.setState({
      status: { id: 'inst-b', isRunning: true } as never,
      systemStats: { cpu: 12 } as never,
    })
    await vi.waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull(), {
      timeout: 5000,
    })
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown>
    const state = stored.state as Record<string, unknown>
    expect(state).not.toHaveProperty('status')
    expect(state).not.toHaveProperty('systemStats')
    // 启停中间态跨刷新无意义，同样不该落盘
    expect(state).not.toHaveProperty('phase')
  })

  it('损坏载荷（instanceId 非字符串）读回为 null，不进 store', () => {
    // 直接走 merge 的归一逻辑：手改/损坏的 localStorage 不得让顶栏显示一个
    // 非字符串的「实例名」（渲染出来是 [object Object] 之类）
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state: { instanceId: { nope: 1 } } }))
    const merge = useServerStore.persist.getOptions().merge
    const merged = merge?.(
      { instanceId: { nope: 1 } },
      { ...useServerStore.getState(), instanceId: null },
    ) as { instanceId: unknown }
    expect(merged.instanceId).toBeNull()
  })

  it('空字符串同样归一为 null（不把 "" 当成一个有效实例 id）', () => {
    const merge = useServerStore.persist.getOptions().merge
    const merged = merge?.({ instanceId: '' }, { ...useServerStore.getState() }) as {
      instanceId: unknown
    }
    expect(merged.instanceId).toBeNull()
  })
})
