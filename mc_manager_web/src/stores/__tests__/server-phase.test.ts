/**
 * server store phase 中间态单测（issue 334）
 * - setPhase 置入 starting/stopping（按实例隔离，多实例并行互不覆盖）
 * - setPhase(id, null) 清除（清除不存在的 key 无害且不新建键）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useServerStore } from '../server'

beforeEach(() => {
  useServerStore.setState({ phase: {} })
})

describe('server store phase 中间态', () => {
  it('置入 starting / stopping', () => {
    const { setPhase } = useServerStore.getState()
    setPhase('inst-1', 'starting')
    expect(useServerStore.getState().phase['inst-1']).toBe('starting')

    setPhase('inst-1', 'stopping')
    expect(useServerStore.getState().phase['inst-1']).toBe('stopping')
  })

  it('多实例并行：各自 phase 互不覆盖', () => {
    const { setPhase } = useServerStore.getState()
    setPhase('inst-1', 'starting')
    setPhase('inst-2', 'stopping')

    const phase = useServerStore.getState().phase
    expect(phase['inst-1']).toBe('starting')
    expect(phase['inst-2']).toBe('stopping')
  })

  it('清除单个实例：其余实例保留', () => {
    const { setPhase } = useServerStore.getState()
    setPhase('inst-1', 'starting')
    setPhase('inst-2', 'stopping')

    setPhase('inst-1', null)
    const phase = useServerStore.getState().phase
    expect(phase['inst-1']).toBeUndefined()
    expect(phase['inst-2']).toBe('stopping')
  })

  it('清除不存在的 key：无操作不残留', () => {
    const { setPhase } = useServerStore.getState()
    setPhase('ghost', null)
    expect(useServerStore.getState().phase).toEqual({})
  })

  it('重复置入同实例同态：幂等', () => {
    const { setPhase } = useServerStore.getState()
    setPhase('inst-1', 'starting')
    setPhase('inst-1', 'starting')
    expect(useServerStore.getState().phase).toEqual({ 'inst-1': 'starting' })
  })
})
