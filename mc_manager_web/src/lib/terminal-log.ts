/**
 * 终端日志纯逻辑
 * - 级别推断（command→INPUT；stderr/stdout 正则）
 * - JVM 警告过滤（默认隐藏）
 * - 缓冲上限 2000 条 / 单行截断 4096 / 多行兜底截断 40 行
 */

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'INPUT'

export interface TerminalLogEntry {
  text: string
  /** 推断级别 */
  level: LogLevel
  /** 是否被 JVM 警告过滤（隐藏态） */
  jvmWarning: boolean
}

export const MAX_BUFFER_ENTRIES = 2000
export const MAX_LINE_LENGTH = 4096
export const MAX_MULTILINE_COUNT = 40

// MC 日志级别标记形如 [Server thread/ERROR]（方括号内末段为级别，前缀可变）
const ERROR_RE = /ERROR\]|FATAL\]|Exception|Caused by:/
const WARN_RE = /WARN(?:ING)?\]:/
const JVM_WARNING_RE =
  /WARNING: A restricted method|WARNING: Please consider reporting|WARNING: An illegal reflective access|WARNING: Removal of API|java\.lang\.System\$LoggerFinder/

/** 级别推断 */
export function inferLevel(text: string, type: 'stdout' | 'stderr' | 'command'): LogLevel {
  if (type === 'command') return 'INPUT'
  if (type === 'stderr') {
    if (ERROR_RE.test(text)) return 'ERROR'
    return 'WARN'
  }
  // stdout
  if (WARN_RE.test(text)) return 'WARN'
  if (ERROR_RE.test(text)) return 'ERROR'
  return 'INFO'
}

/** JVM 启动警告匹配（默认隐藏，眼睛按钮切换显示） */
export function isJvmWarning(text: string): boolean {
  return JVM_WARNING_RE.test(text)
}

/** 单行截断（4096 字符 + 标记，与服务端一致） */
export function truncateLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text
  return `${text.slice(0, MAX_LINE_LENGTH)}…[truncated]`
}

/** 多行日志兜底截断（40 行 + 已截断标记） */
export function truncateMultiline(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= MAX_MULTILINE_COUNT) return text
  const kept = lines.slice(0, MAX_MULTILINE_COUNT).join('\n')
  return `${kept}\n…[已截断 ${lines.length - MAX_MULTILINE_COUNT} 行]`
}

/** 推入缓冲（2000 上限丢最旧；返回新缓冲） */
export function pushLogEntry(
  buffer: TerminalLogEntry[],
  entry: TerminalLogEntry,
): TerminalLogEntry[] {
  const next = [...buffer, entry]
  return next.length > MAX_BUFFER_ENTRIES ? next.slice(next.length - MAX_BUFFER_ENTRIES) : next
}

/** WS 日志事件 → 日志条目 */
export function entryFromWs(text: string, type: 'stdout' | 'stderr' | 'command'): TerminalLogEntry {
  const full = truncateMultiline(truncateLine(text))
  return { text: full, level: inferLevel(text, type), jvmWarning: isJvmWarning(text) }
}

/** 历史日志（GET /logs）→ 条目列表（仅填充非空行；stdout/stderr） */
export function entriesFromHistory(logs: Array<{ text: string; type: 'stdout' | 'stderr' }>): TerminalLogEntry[] {
  return logs
    .filter((l) => l.text?.trim())
    .map((l) => entryFromWs(l.text, l.type))
}
