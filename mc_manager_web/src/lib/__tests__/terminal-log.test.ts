import { describe, it, expect } from 'vitest'
import {
  entryFromWs,
  entriesFromHistory,
  inferLevel,
  isJvmWarning,
  MAX_BUFFER_ENTRIES,
  pushLogEntry,
  truncateLine,
  truncateMultiline,
  type TerminalLogEntry,
} from '../terminal-log'

describe('级别推断', () => {
  it('command 类型 → INPUT', () => {
    expect(inferLevel('> say hi', 'command')).toBe('INPUT')
  })

  it('stderr 含 ERROR 标记 → ERROR', () => {
    expect(inferLevel('[12:00:00] [Server thread/ERROR]: boom', 'stderr')).toBe('ERROR')
    expect(inferLevel('Exception in thread', 'stderr')).toBe('ERROR')
    expect(inferLevel('Caused by: java.lang.RuntimeException', 'stderr')).toBe('ERROR')
  })

  it('stderr 其他 → WARN', () => {
    expect(inferLevel('some stderr noise', 'stderr')).toBe('WARN')
  })

  it('stdout 含 WARN 标记 → WARN；含 ERROR → ERROR；否则 INFO', () => {
    expect(inferLevel('[WARN]: low memory', 'stdout')).toBe('WARN')
    expect(inferLevel('[ERROR]: failed', 'stdout')).toBe('ERROR')
    expect(inferLevel('Done (1.2s)!', 'stdout')).toBe('INFO')
  })
})

describe('JVM 警告过滤', () => {
  it('匹配常见 JVM 启动警告', () => {
    expect(isJvmWarning('WARNING: A restricted method in java.lang.System has been called')).toBe(
      true,
    )
    expect(isJvmWarning('WARNING: An illegal reflective access operation has occurred')).toBe(true)
    expect(isJvmWarning('WARNING: Please consider reporting this to the maintainers')).toBe(true)
    expect(isJvmWarning('WARNING: Removal of API ... has been deprecated')).toBe(true)
    expect(isJvmWarning('java.lang.System$LoggerFinder')).toBe(true)
    expect(isJvmWarning('[INFO] normal log')).toBe(false)
  })
})

describe('截断规则', () => {
  it('单行 4096 截断 + 标记', () => {
    const long = 'a'.repeat(5000)
    const result = truncateLine(long)
    expect(result.length).toBeLessThan(5000)
    expect(result.endsWith('…[truncated]')).toBe(true)
    expect(result.length).toBe(4096 + '…[truncated]'.length)
  })

  it('多行超过 40 行兜底截断', () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const result = truncateMultiline(many)
    expect(result).toContain('line 0')
    expect(result).toContain('已截断 10 行')
    expect(result.split('\n').length).toBeLessThanOrEqual(42)
  })
})

describe('缓冲管理', () => {
  it('2000 条上限丢最旧', () => {
    const entry: TerminalLogEntry = { text: 'x', level: 'INFO', jvmWarning: false }
    let buffer: TerminalLogEntry[] = []
    for (let i = 0; i < MAX_BUFFER_ENTRIES + 100; i++) {
      buffer = pushLogEntry(buffer, { ...entry, text: `line ${i}` })
    }
    expect(buffer.length).toBe(MAX_BUFFER_ENTRIES)
    expect(buffer[0]?.text).toBe('line 100')
    expect(buffer[buffer.length - 1]?.text).toBe(`line ${MAX_BUFFER_ENTRIES + 99}`)
  })
})

describe('WS 事件与历史日志入口', () => {
  it('entryFromWs 推断级别并标记 JVM 警告（JVM 警告行无方括号标记，级别 INFO）', () => {
    const e = entryFromWs('WARNING: A restricted method', 'stdout')
    expect(e.jvmWarning).toBe(true)
    expect(e.level).toBe('INFO')
  })

  it('entriesFromHistory 过滤空行', () => {
    const entries = entriesFromHistory([
      { text: 'line 1', type: 'stdout' },
      { text: '  ', type: 'stdout' },
      { text: '', type: 'stderr' },
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe('line 1')
  })
})
