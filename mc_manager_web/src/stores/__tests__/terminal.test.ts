/**
 * terminal store 单测：缓冲生命周期与实例隔离
 * 真实调用 store action 断言状态变迁（#436/#449 行为级范式）；
 * 级别推断/截断等纯函数语义由 lib/__tests__/terminal-log.test.ts 锁定，此处只验证 store 接线
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useTerminalStore } from '../terminal'
import { MAX_BUFFER_ENTRIES } from '@/lib/terminal-log'

beforeEach(() => {
  useTerminalStore.setState({ buffer: [], instanceId: null, suppressBackfill: false })
})

describe('terminal store 实例切换', () => {
  it('setInstance：切换实例清空缓冲并重置回填标记', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().pushEntry('inst-1', 'boot', 'stdout')
    useTerminalStore.getState().clear()
    useTerminalStore.getState().pushEntry('inst-1', 'after-clear', 'stdout')
    expect(useTerminalStore.getState().suppressBackfill).toBe(true)

    useTerminalStore.getState().setInstance('inst-2')

    const s = useTerminalStore.getState()
    expect(s.instanceId).toBe('inst-2')
    expect(s.buffer).toHaveLength(0)
    expect(s.suppressBackfill).toBe(false)
  })

  it('setInstance：同实例幂等（不清空既有缓冲）', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().pushEntry('inst-1', 'line-1', 'stdout')

    useTerminalStore.getState().setInstance('inst-1')

    expect(useTerminalStore.getState().buffer).toHaveLength(1)
  })
})

describe('terminal store 日志推入', () => {
  it('pushEntry：实例不匹配的 WS 事件忽略（隔离旧实例日志流）', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().pushEntry('other', 'stray', 'stdout')

    expect(useTerminalStore.getState().buffer).toHaveLength(0)
  })

  it('pushEntry：command → INPUT 级别', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().pushEntry('inst-1', 'say hi', 'command')

    const entry = useTerminalStore.getState().buffer[0]
    expect(entry).toMatchObject({ text: 'say hi', level: 'INPUT', jvmWarning: false })
  })

  it('pushEntry：stderr 无错误标记 → WARN；含异常标记 → ERROR', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().pushEntry('inst-1', 'oops', 'stderr')
    useTerminalStore.getState().pushEntry('inst-1', 'java.lang.Exception: boom', 'stderr')

    const buffer = useTerminalStore.getState().buffer
    expect(buffer[0]?.level).toBe('WARN')
    expect(buffer[1]?.level).toBe('ERROR')
  })

  it('pushEntry：stdout 按 MC 日志标记推断 INFO/WARN/ERROR', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().pushEntry('inst-1', 'Done (2.1s)! For help, type "help"', 'stdout')
    useTerminalStore
      .getState()
      .pushEntry('inst-1', '[12:00:00] [Server thread/WARN]: memory low', 'stdout')
    useTerminalStore
      .getState()
      .pushEntry('inst-1', '[12:00:01] [Server thread/ERROR]: bad thing', 'stdout')

    const levels = useTerminalStore.getState().buffer.map((e) => e.level)
    expect(levels).toEqual(['INFO', 'WARN', 'ERROR'])
  })

  it('pushEntry：JVM 启动警告标记 jvmWarning（默认隐藏态）', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore
      .getState()
      .pushEntry('inst-1', 'WARNING: An illegal reflective access operation has occurred', 'stdout')

    const entry = useTerminalStore.getState().buffer[0]
    expect(entry?.jvmWarning).toBe(true)
  })

  it('pushEntry：超过 2000 条丢最旧（缓冲上限收敛）', () => {
    useTerminalStore.getState().setInstance('inst-1')
    for (let i = 0; i <= MAX_BUFFER_ENTRIES; i++) {
      useTerminalStore.getState().pushEntry('inst-1', `line-${i}`, 'stdout')
    }

    const buffer = useTerminalStore.getState().buffer
    expect(buffer).toHaveLength(MAX_BUFFER_ENTRIES)
    expect(buffer[0]?.text).toBe('line-1')
    expect(buffer[MAX_BUFFER_ENTRIES - 1]?.text).toBe(`line-${MAX_BUFFER_ENTRIES}`)
  })
})

describe('terminal store 历史回填', () => {
  const history = [
    { text: 'startup done', type: 'stdout' as const },
    { text: 'watchdog', type: 'stderr' as const },
  ]

  it('fillHistory：空缓冲 + 实例匹配 → 填充历史条目', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().fillHistory('inst-1', history)

    const buffer = useTerminalStore.getState().buffer
    expect(buffer).toHaveLength(2)
    expect(buffer[0]).toMatchObject({ text: 'startup done', level: 'INFO' })
    expect(buffer[1]?.text).toBe('watchdog')
  })

  it('fillHistory：非空缓冲不重复填充（防重复）', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().pushEntry('inst-1', 'live-log', 'stdout')

    useTerminalStore.getState().fillHistory('inst-1', history)

    const buffer = useTerminalStore.getState().buffer
    expect(buffer).toHaveLength(1)
    expect(buffer[0]?.text).toBe('live-log')
  })

  it('fillHistory：实例不匹配忽略', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().fillHistory('other', history)

    expect(useTerminalStore.getState().buffer).toHaveLength(0)
  })

  it('fillHistory：suppressBackfill 置位后忽略（手动清空不回填）', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().clear()
    useTerminalStore.getState().fillHistory('inst-1', history)

    expect(useTerminalStore.getState().buffer).toHaveLength(0)
  })

  it('fillHistory：全空白行日志 → 不填充（entries 空早退）', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().fillHistory('inst-1', [{ text: '   ', type: 'stdout' }])

    expect(useTerminalStore.getState().buffer).toHaveLength(0)
  })
})

describe('terminal store 清空与重启联动', () => {
  it('clear：清缓冲 + 置回填抑制标记', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().pushEntry('inst-1', 'to-be-cleared', 'stdout')

    useTerminalStore.getState().clear()

    const s = useTerminalStore.getState()
    expect(s.buffer).toHaveLength(0)
    expect(s.suppressBackfill).toBe(true)
  })

  it('resetForRestart：清缓冲 + 保留回填（新进程日志可重新填充）', () => {
    useTerminalStore.getState().setInstance('inst-1')
    useTerminalStore.getState().clear()
    useTerminalStore.getState().resetForRestart()
    expect(useTerminalStore.getState().suppressBackfill).toBe(false)

    useTerminalStore
      .getState()
      .fillHistory('inst-1', [{ text: 'restarted', type: 'stdout' as const }])
    const buffer = useTerminalStore.getState().buffer
    expect(buffer).toHaveLength(1)
    expect(buffer[0]?.text).toBe('restarted')
  })
})
