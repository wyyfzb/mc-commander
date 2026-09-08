import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AuditLogItem } from '@/api/types'
import { AuditBody } from '../audit-tables'

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
    const logs: AuditLogItem[] = [
      makeLog({ action: 'CONFIG_CHANGE', detail: { extra: { a: 1 } } }),
    ]
    render(
      <table>
        <AuditBody logs={logs} />
      </table>,
    )
    expect(screen.getByText('配置修改')).toBeInTheDocument()
    expect(screen.getByText('extra: {"a":1}')).toBeInTheDocument()
  })
})
