import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AuditLogItem, CommandHistoryItem } from '@/api/types'
import { AuditBody, CmdBody } from '../audit-tables'

/** 字段结构对齐 mc-schemas 的 auditLogItemSchema，值一律虚构 */
function makeLog(overrides: Partial<AuditLogItem>): AuditLogItem {
  return {
    id: 1,
    instanceId: null,
    action: 'PLAYER_WHITELIST',
    targetType: 'player',
    targetId: 'Steve',
    detail: null,
    source: 'web',
    createdAt: 'not-a-date',
    ...overrides,
  }
}

/** 字段结构对齐 mc-schemas 的 commandHistoryItemSchema，值一律虚构 */
function makeCmd(overrides: Partial<CommandHistoryItem>): CommandHistoryItem {
  return {
    id: 1,
    instanceId: 'demo',
    command: 'whitelist add Steve',
    source: 'web',
    success: true,
    response: null,
    durationMs: 12,
    createdAt: '2026-01-02T03:04:05Z',
    ...overrides,
  }
}

describe('AuditBody（issue 481 拆分后行为级测试）', () => {
  it('行渲染：key+from+to 三件套合并展示，操作列走标签映射，目标列拼接类型与 ID', () => {
    const logs: AuditLogItem[] = [
      makeLog({
        detail: { key: 'whitelist', from: 'false', to: 'true', reason: '违规建筑' },
        createdAt: '2026-01-02T03:04:05Z',
      }),
    ]
    render(
      <table>
        <AuditBody logs={logs} />
      </table>,
    )
    expect(screen.getByText('白名单操作')).toBeInTheDocument()
    expect(screen.getByText('player: Steve')).toBeInTheDocument()
    expect(screen.getByText('whitelist: false → true · 原因: 违规建筑')).toBeInTheDocument()
  })

  it('兜底路径：非法 ISO 时间原样返回，未映射操作回退原文，空详情展示占位符', () => {
    const logs: AuditLogItem[] = [
      makeLog({ action: 'CUSTOM_ACTION', targetType: null, targetId: null, detail: '' }),
    ]
    render(
      <table>
        <AuditBody logs={logs} />
      </table>,
    )
    expect(screen.getByText('not-a-date')).toBeInTheDocument()
    expect(screen.getByText('CUSTOM_ACTION')).toBeInTheDocument()
    // 目标列与详情列各渲染一个占位符
    expect(screen.getAllByText('-')).toHaveLength(2)
  })

  it('嵌套对象详情降级 JSON 字符串展示（审计详情兜底路径）', () => {
    const logs: AuditLogItem[] = [makeLog({ action: 'CONFIG_CHANGE', detail: { extra: { a: 1 } } })]
    render(
      <table>
        <AuditBody logs={logs} />
      </table>,
    )
    expect(screen.getByText('配置修改')).toBeInTheDocument()
    expect(screen.getByText('extra: {"a":1}')).toBeInTheDocument()
  })

  it('详情单元格 title 保留原始 JSON（人性化文案截断时的悬停兜底）', () => {
    const logs: AuditLogItem[] = [
      makeLog({ action: 'CONFIG_CHANGE', detail: { key: 'view-distance', from: '10', to: '12' } }),
    ]
    render(
      <table>
        <AuditBody logs={logs} />
      </table>,
    )
    expect(screen.getByText('view-distance: 10 → 12')).toHaveAttribute(
      'title',
      '{"key":"view-distance","from":"10","to":"12"}',
    )
  })
})

describe('CmdBody（命令历史表体）', () => {
  it('失败行 hover tooltip：response 内容 break-all 防长串溢出', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <table>
          <CmdBody cmds={[makeCmd({ success: false, response: 'ECONNREFUSED 1.2.3.4' })]} />
        </table>
      </TooltipProvider>,
    )
    await user.hover(screen.getByText('失败'))
    expect(await screen.findByText('ECONNREFUSED 1.2.3.4')).toHaveClass('break-all')
  })

  it('成功行不渲染失败 tooltip', () => {
    render(
      <TooltipProvider>
        <table>
          <CmdBody cmds={[makeCmd({ success: true })]} />
        </table>
      </TooltipProvider>,
    )
    expect(screen.queryByText('失败原因')).not.toBeInTheDocument()
  })
})
