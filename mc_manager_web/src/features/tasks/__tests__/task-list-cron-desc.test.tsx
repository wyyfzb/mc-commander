/**
 * 任务行 cron 描述渲染防退化：
 * 任务行须在 mono cron 表达式旁渲染 cronDescription 的中文可读描述
 * （与编辑器预览同源）；描述为空串（无法识别的表达式）时不渲染描述节点。
 * 去掉描述 span 或判定分支反转即本文件红。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ScheduledTask } from '@mc-commander/schemas'
import { TaskList } from '../components/task-list'

/** 字段结构对齐 mc-schemas 的 scheduledTaskSchema，值一律虚构 */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 1,
    instanceId: 'demo',
    name: '每日备份',
    type: 'backup',
    cronExpression: '0 4 * * *',
    command: null,
    isEnabled: true,
    lastRunAt: null,
    lastRunStatus: 'never',
    lastRunError: null,
    nextRunAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const noop = vi.fn()
const baseProps = {
  isLoading: false,
  runningTaskId: null,
  onToggle: noop,
  onRunNow: noop,
  onEdit: noop,
  onDelete: noop,
  onNewTask: noop,
}

describe('任务行 cron 描述渲染', () => {
  it('可识别表达式：mono cron 旁渲染中文可读描述', () => {
    render(<TaskList {...baseProps} tasks={[makeTask()]} />)
    expect(screen.getByText('0 4 * * *')).toBeInTheDocument()
    expect(screen.getByText('04:00每天执行')).toBeInTheDocument()
    // 描述与 mono 原文同行（cronDescription 与编辑器预览同源的挂载点）
    expect(screen.getByText('0 4 * * *').parentElement).toHaveTextContent('04:00每天执行')
  })

  it('无法识别表达式：只渲染 mono 原文，不渲染描述节点', () => {
    render(<TaskList {...baseProps} tasks={[makeTask({ cronExpression: 'a b c d e' })]} />)
    const cronLine = screen.getByText('a b c d e').parentElement
    expect(cronLine).toHaveTextContent(/^a b c d e$/)
  })
})
